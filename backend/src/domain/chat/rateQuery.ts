import { env } from "../../config/env.js";
import { ledgerRepo } from "../ledger/repository.js";
import { selectOfframpProvider, ALL_SUPPORTED_FIAT_CURRENCIES, eligibleChainsForCurrency, type ProviderQuote } from "../offramp/providerSelection.js";
import { listSupportedCountries, countryCodeToFlag } from "../../ai-agent/offramp/countries.js";
import type { ParsedIntent } from "./schemas.js";

export type RateQueryIntent = Extract<ParsedIntent, { kind: "rate" }>;

// NGN is the primary market this product actually serves — a reasonable
// default when a user just asks "what's the rate" with no currency named,
// same spirit as env.defaultTokenSymbol/env.defaultChain defaulting the
// other flows' unnamed fields.
const DEFAULT_FIAT_CURRENCY = "NGN";

async function resolvePreferredChain(userId: string, tokenSymbol: string, chainHint?: string): Promise<string> {
  if (chainHint) return chainHint.toLowerCase();
  const balances = await ledgerRepo.getBalancesForUser(userId);
  const funded = balances.find((b) => b.tokenSymbol === tokenSymbol && Number(b.availableBalance) > 0);
  return funded?.chain ?? env.defaultChain;
}

// Real gap found live (2026-09-08), the same day the single-chain version
// of this was fixed: "eligible" (eligibleChainsForCurrency) is a static
// fact — does some provider claim to serve this chain/currency pair — not
// a live health check. UGX/Stellar is eligible on paper (Centiiv supports
// both) but Centiiv's own API returned a real 500 for that exact pair
// while UGX/Base (Paycrest) quoted fine at the same moment — trying only
// the first eligible chain gave up on a currency an alternate chain could
// still actually quote. Tries every genuinely eligible chain in order
// (preferred first) and returns the first one that actually works.
async function quoteAcrossEligibleChains(
  fiatCurrency: string,
  tokenSymbol: string,
  amount: string,
  preferredChain: string,
): Promise<{ selection: ProviderQuote; chain: string } | { error: string }> {
  const candidates = eligibleChainsForCurrency(fiatCurrency, preferredChain);
  if (candidates.length === 0) {
    return { error: `${fiatCurrency} isn't a currency we off-ramp to right now.` };
  }
  let lastError = "";
  for (const chain of candidates) {
    try {
      const selection = await selectOfframpProvider({ chain, token: tokenSymbol, amount, fiatCurrency });
      return { selection, chain };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { error: lastError };
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
  // Resolved once (a user's funded chain doesn't change per currency) —
  // quoteAcrossEligibleChains re-checks eligibility, and now falls back
  // across every option, PER row below.
  const preferredChain = await resolvePreferredChain(userId, tokenSymbol, chainHint);

  const BENCHMARK_AMOUNT = "10";
  const countries = listSupportedCountries().filter((c) => ALL_SUPPORTED_FIAT_CURRENCIES.has(c.currencyCode));

  const rows = await Promise.all(
    countries.map(async (country) => {
      const result = await quoteAcrossEligibleChains(country.currencyCode, tokenSymbol, BENCHMARK_AMOUNT, preferredChain);
      if ("error" in result) {
        // One currency's quote failing on every eligible chain (a
        // provider outage, a momentary gap) shouldn't block the rest of
        // the table — skipped, not fatal.
        console.error(`[rate-query] failed to quote ${country.currencyCode} on every eligible chain:`, result.error);
        return null;
      }
      const rate = Number(result.selection.toAmount) / Number(BENCHMARK_AMOUNT);
      return { country, rate };
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
  const preferredChain = await resolvePreferredChain(userId, tokenSymbol, intent.chainHint);

  // Quotes at the user's own named amount when they gave one (a
  // provider's per-unit rate can shift slightly with size — Centiiv's own
  // 0.5 minimum is one real example of non-linearity at the low end), a
  // round benchmark otherwise.
  const namedAmount = intent.amount != null && intent.amount > 0;
  const amount = namedAmount ? intent.amount!.toString() : "10";

  const result = await quoteAcrossEligibleChains(fiatCurrency, tokenSymbol, amount, preferredChain);
  if ("error" in result) {
    return `Couldn't get a live rate for ${tokenSymbol} to ${fiatCurrency} right now (${result.error}).`;
  }

  // provider (which vendor's own rail actually won the quote) is
  // deliberately never shown to the user — real gap found live
  // (2026-09-08): this used to say "via Centiiv", the only place in this
  // codebase a payment provider's name ever reached a chat reply. Every
  // other user-facing message here is provider-agnostic by design.
  const toAmountNum = Number(result.selection.toAmount);
  const perUnitRate = toAmountNum / Number(amount);
  const rateStr = perUnitRate.toLocaleString(undefined, { maximumFractionDigits: 2 });

  if (namedAmount) {
    const totalStr = toAmountNum.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return `${intent.amount} ${tokenSymbol} ≈ ${totalStr} ${fiatCurrency} right now — that's about ${rateStr} ${fiatCurrency} per ${tokenSymbol}. Rates move with the market; this is a live quote, not fixed.`;
  }
  return `1 ${tokenSymbol} ≈ ${rateStr} ${fiatCurrency} right now. Rates move with the market; this is a live quote, not fixed.`;
}
