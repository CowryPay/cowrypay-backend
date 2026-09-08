import { env } from "../../config/env.js";
import { ledgerRepo } from "../ledger/repository.js";
import { selectOfframpProvider, ALL_SUPPORTED_FIAT_CURRENCIES, firstEligibleChainForCurrency } from "../offramp/providerSelection.js";
import { listSupportedCountries, countryCodeToFlag } from "../../ai-agent/offramp/countries.js";
import type { ParsedIntent } from "./schemas.js";

export type RateQueryIntent = Extract<ParsedIntent, { kind: "rate" }>;

// NGN is the primary market this product actually serves — a reasonable
// default when a user just asks "what's the rate" with no currency named,
// same spirit as env.defaultTokenSymbol/env.defaultChain defaulting the
// other flows' unnamed fields.
const DEFAULT_FIAT_CURRENCY = "NGN";

// Shared by both resolveRateQuery and resolveAllRatesQuery — prefers a
// chain the user actually holds this token on (falling back to
// env.defaultChain for a first-time user with nothing funded yet), but
// only when that chain can actually reach fiatCurrency — real bug found
// live (2026-09-08): a user funded on Stellar asking for a TZS rate
// failed outright, since Paycrest (the only TZS provider) doesn't support
// Stellar at all, when a real quote was one chain-substitution away.
// firstEligibleChainForCurrency itself falls back to a genuinely reachable
// chain when the preferred one can't reach this currency.
async function resolveBenchmarkChain(userId: string, tokenSymbol: string, fiatCurrency: string, chainHint?: string): Promise<string | null> {
  let preferred = chainHint ?? null;
  if (!preferred) {
    const balances = await ledgerRepo.getBalancesForUser(userId);
    const funded = balances.find((b) => b.tokenSymbol === tokenSymbol && Number(b.availableBalance) > 0);
    preferred = funded?.chain ?? env.defaultChain;
  }
  return firstEligibleChainForCurrency(fiatCurrency, preferred);
}

// Real feature request (2026-09-08): a bare "what's the rate today" should
// show every currency we actually off-ramp to at once, sell side only —
// on-ramp (buying crypto with fiat) isn't something this product does yet,
// so there's no "Buy" column to show. Sourced from
// providerSelection.ts's ALL_SUPPORTED_FIAT_CURRENCIES (the one real
// "what do we actually support" set — see that file's own comment on why
// countries.ts's SUPPORTED_COUNTRIES isn't quite the same thing) crossed
// with countries.ts's own list, so a currency never shows up here without
// a real country/flag to display it under.
export async function resolveAllRatesQuery(userId: string, tokenHint?: string, chainHint?: string): Promise<string> {
  const tokenSymbol = tokenHint?.toUpperCase() ?? env.defaultTokenSymbol;

  // Resolved once (a user's funded chain doesn't change per currency),
  // then re-checked for eligibility PER row below — no single chain
  // reaches every currency (TZS is Paycrest-only, which doesn't support
  // Stellar/Solana at all), so this is only ever a preference, honored
  // when it actually works for that specific currency.
  let preferredChain = chainHint ?? null;
  if (!preferredChain) {
    const balances = await ledgerRepo.getBalancesForUser(userId);
    const funded = balances.find((b) => b.tokenSymbol === tokenSymbol && Number(b.availableBalance) > 0);
    preferredChain = funded?.chain ?? env.defaultChain;
  }

  const BENCHMARK_AMOUNT = "10";
  const countries = listSupportedCountries().filter((c) => ALL_SUPPORTED_FIAT_CURRENCIES.has(c.currencyCode));

  const rows = await Promise.all(
    countries.map(async (country) => {
      const chain = firstEligibleChainForCurrency(country.currencyCode, preferredChain);
      if (!chain) return null;
      try {
        const selection = await selectOfframpProvider({
          chain,
          token: tokenSymbol,
          amount: BENCHMARK_AMOUNT,
          fiatCurrency: country.currencyCode,
        });
        const rate = Number(selection.toAmount) / Number(BENCHMARK_AMOUNT);
        return { country, rate };
      } catch (err) {
        // One currency's quote failing (a provider hiccup, a momentary
        // gap) shouldn't block the rest of the table — skipped, not fatal.
        console.error(`[rate-query] failed to quote ${country.currencyCode}:`, err);
        return null;
      }
    }),
  );

  const lines = ["Conversion Rates", ""];
  for (const row of rows) {
    if (!row) continue;
    const flag = countryCodeToFlag(row.country.countryCode);
    const rateStr = row.rate.toLocaleString(undefined, { maximumFractionDigits: 2 });
    lines.push(`${flag} ${row.country.currencyCode}/USD`);
    lines.push(`Sell: ${rateStr}`);
    lines.push("--------------------------");
  }
  if (lines.length === 2) {
    return "Couldn't get live rates right now — try again shortly.";
  }
  lines.pop(); // drop the trailing separator after the last row
  return lines.join("\n");
}

// Read-only — no draft, no session, nothing to confirm or PIN-gate. Reuses
// the exact same selectOfframpProvider every real remittance quote goes
// through (see providerSelection.ts), so "what's the rate" can never show
// a number the real send flow wouldn't also get — same live-shopped-
// across-providers rate, not a separately maintained figure that could
// drift out of sync with it.
export async function resolveRateQuery(userId: string, intent: RateQueryIntent): Promise<string> {
  const fiatCurrency = (intent.fiatCurrency ?? DEFAULT_FIAT_CURRENCY).toUpperCase();
  const tokenSymbol = intent.tokenHint?.toUpperCase() ?? env.defaultTokenSymbol;
  const chain = await resolveBenchmarkChain(userId, tokenSymbol, fiatCurrency, intent.chainHint);
  if (!chain) {
    return `${fiatCurrency} isn't a currency we off-ramp to right now.`;
  }

  // Quotes at the user's own named amount when they gave one (a
  // provider's per-unit rate can shift slightly with size — Centiiv's own
  // 0.5 minimum is one real example of non-linearity at the low end), a
  // round benchmark otherwise.
  const namedAmount = intent.amount != null && intent.amount > 0;
  const amount = namedAmount ? intent.amount!.toString() : "10";

  let selection;
  try {
    selection = await selectOfframpProvider({ chain, token: tokenSymbol, amount, fiatCurrency });
  } catch (err) {
    return `Couldn't get a live rate for ${tokenSymbol} to ${fiatCurrency} on ${chain} right now (${err instanceof Error ? err.message : String(err)}).`;
  }

  // provider (which vendor's own rail actually won the quote) is
  // deliberately never shown to the user — real gap found live
  // (2026-09-08): this used to say "via Centiiv", the only place in this
  // codebase a payment provider's name ever reached a chat reply. Every
  // other user-facing message here is provider-agnostic by design.
  const toAmountNum = Number(selection.toAmount);
  const perUnitRate = toAmountNum / Number(amount);
  const rateStr = perUnitRate.toLocaleString(undefined, { maximumFractionDigits: 2 });

  if (namedAmount) {
    const totalStr = toAmountNum.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return `${intent.amount} ${tokenSymbol} ≈ ${totalStr} ${fiatCurrency} right now — that's about ${rateStr} ${fiatCurrency} per ${tokenSymbol}. Rates move with the market; this is a live quote, not fixed.`;
  }
  return `1 ${tokenSymbol} ≈ ${rateStr} ${fiatCurrency} right now. Rates move with the market; this is a live quote, not fixed.`;
}
