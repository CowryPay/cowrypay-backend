import { getOfframpRate as getPaycrestRate, isPaycrestEligible, PAYCREST_SUPPORTED_FIAT_CURRENCIES } from "./paycrestAdapter.js";
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

// The 6 chains this codebase's off-ramp flow ever sources from — kept
// here (not imported from chains.ts's EVM-only SUPPORTED_CHAINS) since
// this is specifically the "which chains might a user be sending FROM"
// universe for building a helpful error, not a wallet-provisioning list.
const ALL_OFFRAMP_CHAINS = ["celo", "base", "optimism", "solana", "stellar", "ethereum"];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Every fiat currency any provider supports right now, for enumerating
// "what CAN this chain send to" — deliberately NOT limited to whichever
// currency the user originally asked about.
const ALL_SUPPORTED_FIAT_CURRENCIES = new Set([
  ...PAYCREST_SUPPORTED_FIAT_CURRENCIES,
  ...QUIDAX_SUPPORTED_FIAT_CURRENCIES,
  ...CENTIIV_SUPPORTED_FIAT_CURRENCIES,
]);

function chainsSupportingCurrency(fiatCurrency: string): string[] {
  return ALL_OFFRAMP_CHAINS.filter(
    (chain) =>
      isPaycrestEligible(chain, fiatCurrency) || isQuidaxEligible(chain, fiatCurrency) || isCentiivEligible(chain, fiatCurrency),
  );
}

function currenciesReachableFromChain(chain: string): string[] {
  return [...ALL_SUPPORTED_FIAT_CURRENCIES].filter(
    (ccy) => isPaycrestEligible(chain, ccy) || isQuidaxEligible(chain, ccy) || isCentiivEligible(chain, ccy),
  );
}

// Real incident this replaces: "No off-ramp provider is available for
// this amount/chain right now" told a user their Celo->Ghana send failed
// with no indication of WHY, or whether "right now" meant "try again in
// a minute" (implying a transient outage) versus "this combination isn't
// supported at all" (the actual, permanent reason — none of the three
// providers cover both Celo AND GHS between them). Exported so
// remittanceDraft.ts's own near-identical generic messages can reuse the
// same explanation instead of drifting out of sync with it.
export function explainNoProviderMessage(chain: string, fiatCurrency: string): string {
  const chainLabel = capitalize(chain);
  const currencyLabel = fiatCurrency.toUpperCase();
  const altChains = chainsSupportingCurrency(fiatCurrency).filter((c) => c.toLowerCase() !== chain.toLowerCase());
  const altCurrencies = currenciesReachableFromChain(chain);

  const parts = [`Sending from ${chainLabel} to ${currencyLabel} isn't supported right now.`];
  if (altChains.length > 0) {
    parts.push(`${currencyLabel} can currently be reached from: ${altChains.map(capitalize).join(", ")}.`);
  }
  if (altCurrencies.length > 0) {
    parts.push(`${chainLabel} can currently send to: ${altCurrencies.join(", ")}.`);
  }
  if (altChains.length === 0 && altCurrencies.length === 0) {
    parts.push(`${currencyLabel} isn't supported by any provider right now.`);
  }
  return parts.join(" ");
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
    throw new Error(explainNoProviderMessage(params.chain, params.fiatCurrency));
  }
  return quotes.reduce((best, q) => (Number(q.toAmount) > Number(best.toAmount) ? q : best));
}
