import { getOfframpRate as getPaycrestRate, isPaycrestEligible } from "./paycrestAdapter.js";
import { getOfframpRate as getQuidaxRate, quidaxNetworkFor, QUIDAX_SUPPORTED_FIAT_CURRENCIES } from "./quidaxAdapter.js";
import { getOfframpRate as getCentiivRate, centiivNetworkFor, CENTIIV_SUPPORTED_FIAT_CURRENCIES } from "./centiivAdapter.js";
import { getTokenConfig } from "../wallets/chains.js";
import { getSolanaMint } from "../wallets/solanaAdapter.js";

export { isPaycrestEligible };

export type OfframpProvider = "paycrest" | "quidax" | "centiiv";

export interface ProviderQuote {
  provider: OfframpProvider;
  // "How much fiat the user actually receives" — the one number that's
  // genuinely comparable across providers, regardless of how each
  // represents rate/fee internally (Paycrest: a rate multiplier; Quidax/
  // Centiiv: a fee-inclusive amount straight from their own quote).
  toAmount: string;
}

// Quidax only supports USDC on 2 of our 5 chains (verified live against
// their real API, see quidaxAdapter.ts's own comment on this) — checked
// here before ever calling their API, not left to fail per-request. Also
// gated on fiatCurrency, not just chain — real bug found live: an
// eligible-chain send in an unsupported currency (e.g. UGX) was still
// being compared here, since Quidax's own endpoints don't validate
// to_currency either (see QUIDAX_SUPPORTED_FIAT_CURRENCIES's own comment).
export function isQuidaxEligible(chain: string, fiatCurrency: string): boolean {
  return quidaxNetworkFor(chain) !== null && QUIDAX_SUPPORTED_FIAT_CURRENCIES.has(fiatCurrency.toUpperCase());
}

// Centiiv supports 3 of our 5 chains (Stellar/Solana/Base — verified live
// against their real API, see centiivAdapter.ts's own comment on this).
// Also gated on fiatCurrency — real bug found live: a UGX send on an
// eligible chain got a fake-valid quote from Centiiv (they don't validate
// toAsset), won the rate comparison, and the order was built with the
// wrong beneficiary shape entirely (BANK instead of MOBILEMONEY), which
// only surfaced as a REFUND after the fact. Currently NGN (BANK), UGX/
// KES/GHS (MOBILEMONEY) — see CENTIIV_SUPPORTED_FIAT_CURRENCIES.
export function isCentiivEligible(chain: string, fiatCurrency: string): boolean {
  return centiivNetworkFor(chain) !== null && CENTIIV_SUPPORTED_FIAT_CURRENCIES.has(fiatCurrency.toUpperCase());
}

// Real gap found live: Paycrest genuinely supports USDT on Base (verified
// against their real API), but nothing else in this codebase does —
// chains.ts has no USDT entry for Base at all (no official Tether
// deployment there, only a disclaimed bridge — see chains.ts's own
// comment), so a Base+USDT send would fail at initiateSend's own
// getTokenConfig guard. Without this check, GET /offramp/rate would show
// a real, inviting quote for a combination that can't actually be sent —
// checked against the exact same source of truth initiateSend uses, so
// quoting and sending never disagree about what's actually possible.
function isTokenSupportedOnChain(chain: string, token: string): boolean {
  const c = chain.toLowerCase();
  if (c === "solana") {
    try {
      getSolanaMint(token);
      return true;
    } catch {
      return false;
    }
  }
  if (c === "stellar") {
    // Stellar never got USDT support (out of scope — see chains.ts's own
    // comment on the Celo/Solana-only decision); its adapter is still
    // hardcoded to a single USDC trustline.
    return token.toUpperCase() === "USDC";
  }
  try {
    getTokenConfig(c, token);
    return true;
  } catch {
    return false;
  }
}

// Queries every eligible provider in parallel and returns whichever gives
// the user more fiat. A provider erroring out (rate-limited, momentarily
// down, amount too small for their liquidity) is treated as "not
// available this round," not a hard failure — the others still get a
// chance to fill the order. Only throws when none can.
export async function selectOfframpProvider(params: {
  chain: string;
  amount: string;
  fiatCurrency: string;
  // Omitted means USDC — the only token that existed before USDT support.
  token?: string;
}): Promise<ProviderQuote> {
  const token = params.token ?? "USDC";
  if (!isTokenSupportedOnChain(params.chain, token)) {
    throw new Error(`${token} isn't supported on ${params.chain} yet.`);
  }
  const paycrestPromise: Promise<ProviderQuote | null> = isPaycrestEligible(params.chain, params.fiatCurrency)
    ? getPaycrestRate({
        network: params.chain,
        token,
        amount: params.amount,
        fiatCurrency: params.fiatCurrency,
      })
        .then((q) => ({ provider: "paycrest" as const, toAmount: (Number(params.amount) * Number(q.rate)).toString() }))
        .catch(() => null)
    : Promise.resolve(null);

  const quidaxPromise: Promise<ProviderQuote | null> = isQuidaxEligible(params.chain, params.fiatCurrency)
    ? getQuidaxRate({ network: params.chain, token, amount: params.amount, fiatCurrency: params.fiatCurrency })
        .then((q) => ({ provider: "quidax" as const, toAmount: q.toAmount }))
        .catch(() => null)
    : Promise.resolve(null);

  const centiivPromise: Promise<ProviderQuote | null> = isCentiivEligible(params.chain, params.fiatCurrency)
    ? getCentiivRate({ network: params.chain, token, amount: params.amount, fiatCurrency: params.fiatCurrency })
        .then((q) => ({ provider: "centiiv" as const, toAmount: q.estimatedReceivableAmount }))
        .catch(() => null)
    : Promise.resolve(null);

  const quotes = (await Promise.all([paycrestPromise, quidaxPromise, centiivPromise])).filter(
    (q): q is ProviderQuote => q !== null,
  );

  if (quotes.length === 0) {
    throw new Error("No off-ramp provider is available for this amount/chain right now");
  }
  return quotes.reduce((best, q) => (Number(q.toAmount) > Number(best.toAmount) ? q : best));
}
