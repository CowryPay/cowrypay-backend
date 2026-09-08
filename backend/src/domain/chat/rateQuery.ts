import { env } from "../../config/env.js";
import { ledgerRepo } from "../ledger/repository.js";
import { selectOfframpProvider } from "../offramp/providerSelection.js";
import type { ParsedIntent } from "./schemas.js";

export type RateQueryIntent = Extract<ParsedIntent, { kind: "rate" }>;

// NGN is the primary market this product actually serves — a reasonable
// default when a user just asks "what's the rate" with no currency named,
// same spirit as env.defaultTokenSymbol/env.defaultChain defaulting the
// other flows' unnamed fields.
const DEFAULT_FIAT_CURRENCY = "NGN";

// Read-only — no draft, no session, nothing to confirm or PIN-gate. Reuses
// the exact same selectOfframpProvider every real remittance quote goes
// through (see providerSelection.ts), so "what's the rate" can never show
// a number the real send flow wouldn't also get — same live-shopped-
// across-providers rate, not a separately maintained figure that could
// drift out of sync with it.
export async function resolveRateQuery(userId: string, intent: RateQueryIntent): Promise<string> {
  const fiatCurrency = (intent.fiatCurrency ?? DEFAULT_FIAT_CURRENCY).toUpperCase();
  const tokenSymbol = intent.tokenHint?.toUpperCase() ?? env.defaultTokenSymbol;

  // Prefers a chain the user actually holds this token on, same reasoning
  // as remittanceDraft.ts's resolveFiatAmountToCrypto — a rate they can
  // actually reach, not an arbitrary one.
  let chain = intent.chainHint?.toLowerCase();
  if (!chain) {
    const balances = await ledgerRepo.getBalancesForUser(userId);
    const funded = balances.find((b) => b.tokenSymbol === tokenSymbol && Number(b.availableBalance) > 0);
    chain = funded?.chain ?? env.defaultChain;
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
