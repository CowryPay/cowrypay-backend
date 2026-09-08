import { getOfframpRate as getPaycrestRate, isPaycrestEligible, PAYCREST_SUPPORTED_FIAT_CURRENCIES } from "./paycrestAdapter.js";
import { getOfframpRate as getQuidaxRate, quidaxNetworkFor, QUIDAX_SUPPORTED_FIAT_CURRENCIES } from "./quidaxAdapter.js";
import { getOfframpRate as getCentiivRate, centiivNetworkFor, CENTIIV_SUPPORTED_FIAT_CURRENCIES } from "./centiivAdapter.js";
import { getTokenConfig } from "../wallets/chains.js";
import { getSolanaMint } from "../wallets/solanaAdapter.js";
import { stellarSupportedTokens } from "../wallets/stellarAssets.js";

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
    // USDC always; USDT0 (LayerZero OFT, launched on Stellar 2026-09-02)
    // as of 2026-09-08 — see stellarAssets.ts for the actual registry.
    // Stellar's classic USDT (not USDT0) never got support here — a
    // structurally different asset, out of scope.
    return stellarSupportedTokens().includes(token.toUpperCase());
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
// currency the user originally asked about. Exported for rateQuery.ts's
// all-currencies overview — the single authoritative "what do we actually
// off-ramp to today" set, not a separately maintained list that could
// drift out of sync (countries.ts's own SUPPORTED_COUNTRIES includes
// Malawi/MWK, which isn't actually in any of the three providers' sets
// below — aspirational, not real coverage).
export const ALL_SUPPORTED_FIAT_CURRENCIES = new Set([
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

// Real gap found live (2026-09-08) building rateQuery.ts's all-currencies
// table: no single chain reaches every supported currency (TZS is
// Paycrest-only, and Paycrest doesn't support Stellar/Solana at all — see
// paycrestAdapter.ts), so quoting a whole table of currencies against one
// fixed chain silently failed for whichever currencies that chain can't
// actually reach. Exported so a caller building a multi-currency view can
// pick a genuinely reachable chain PER currency instead of guessing one
// chain for everything. preferredChain (e.g. a user-named chainHint, or
// one they actually hold balance on) is honored only when it's actually
// eligible for THIS currency — never just assumed eligible because it's
// eligible for something else.
export function firstEligibleChainForCurrency(fiatCurrency: string, preferredChain?: string | null): string | null {
  const eligible = chainsSupportingCurrency(fiatCurrency);
  if (preferredChain && eligible.includes(preferredChain.toLowerCase())) return preferredChain.toLowerCase();
  return eligible[0] ?? null;
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
// chance to fill the order. Only throws when none can — and even then,
// distinguishes WHY: no provider was ever eligible for this chain/currency
// pair at all (explainNoProviderMessage's job) versus at least one
// provider WAS eligible and genuinely tried, but rejected the request for
// a real reason (amount below their minimum, momentarily down, etc.) —
// see this function's own real incident below for why collapsing those
// two into one generic message is actively misleading, not just vague.
export class NoOfframpRateError extends Error {}

// Real incident this closes (2026-09-08): a USDT0-on-Stellar->NGN request
// below Centiiv's real 0.5 rail minimum surfaced as "Sending from Stellar
// to NGN isn't supported right now" — false; the route works fine, the
// amount was just too small. That happened because every provider promise
// below discarded its real rejection reason (.catch(() => null)) and the
// caller (remittanceDraft.ts) had no way to tell "route genuinely
// unsupported" apart from "route supported, this specific request failed."
// Strips each adapter's own HTTP-wrapper framing (centiivAdapter.ts's
// `Centiiv request failed (400 /public/quote): <real message>`, and
// similar shapes elsewhere) down to the actual, user-meaningful reason —
// this text can end up directly in a chat reply (see remittanceDraft.ts's
// noRateReason), and a raw status-code-and-path wrapper reads as an
// internal error, not an explanation, even though the real message after
// the colon is often perfectly clear on its own ("Amount is below the
// minimum of 0.5 for this rail").
const HTTP_WRAPPER_PREFIX = /^\w[\w -]* request failed \([^)]*\):\s*/;

// Real gap found live (2026-09-08): the user-facing rate/remittance
// messages never named a provider anywhere else in this codebase — every
// other reply is provider-agnostic by design — but this one leaked
// "Centiiv: Amount is below the minimum..." straight into a chat reply,
// the only place a vendor name reached a user. provider is kept on this
// return value for server-side logging only (see selectOfframpProvider's
// own console.error below) — never folded into anything thrown or
// returned to a caller that might show it to a user.
function describeProviderError(provider: OfframpProvider, err: unknown): { provider: OfframpProvider; reason: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { provider, reason: message.replace(HTTP_WRAPPER_PREFIX, "") };
}

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

  const anyEligible =
    isPaycrestEligible(params.chain, params.fiatCurrency) ||
    isQuidaxEligible(params.chain, params.fiatCurrency) ||
    isCentiivEligible(params.chain, params.fiatCurrency);
  if (!anyEligible) {
    throw new Error(explainNoProviderMessage(params.chain, params.fiatCurrency));
  }

  const errors: { provider: OfframpProvider; reason: string }[] = [];

  const paycrestPromise: Promise<ProviderQuote | null> = isPaycrestEligible(params.chain, params.fiatCurrency)
    ? getPaycrestRate({
        network: params.chain,
        token,
        amount: params.amount,
        fiatCurrency: params.fiatCurrency,
      })
        .then((q) => ({ provider: "paycrest" as const, toAmount: (Number(params.amount) * Number(q.rate)).toString() }))
        .catch((err) => {
          errors.push(describeProviderError("paycrest", err));
          return null;
        })
    : Promise.resolve(null);

  const quidaxPromise: Promise<ProviderQuote | null> = isQuidaxEligible(params.chain, params.fiatCurrency)
    ? getQuidaxRate({ network: params.chain, token, amount: params.amount, fiatCurrency: params.fiatCurrency })
        .then((q) => ({ provider: "quidax" as const, toAmount: q.toAmount }))
        .catch((err) => {
          errors.push(describeProviderError("quidax", err));
          return null;
        })
    : Promise.resolve(null);

  const centiivPromise: Promise<ProviderQuote | null> = isCentiivEligible(params.chain, params.fiatCurrency)
    ? getCentiivRate({ network: params.chain, token, amount: params.amount, fiatCurrency: params.fiatCurrency })
        .then((q) => ({ provider: "centiiv" as const, toAmount: q.estimatedReceivableAmount }))
        .catch((err) => {
          errors.push(describeProviderError("centiiv", err));
          return null;
        })
    : Promise.resolve(null);

  const quotes = (await Promise.all([paycrestPromise, quidaxPromise, centiivPromise])).filter(
    (q): q is ProviderQuote => q !== null,
  );

  if (quotes.length === 0) {
    // At least one provider was eligible for this exact chain/currency
    // pair (checked above) and genuinely attempted a quote — so the route
    // itself is real. Surface what actually went wrong instead of the
    // generic "isn't supported" claim, which would be false here — but
    // never which vendor said it (see describeProviderError's own
    // comment): full detail (provider names included) goes to the server
    // log for debugging, only the bare reasons reach the thrown message
    // that can end up in a chat reply.
    console.error(
      `[offramp] no provider could quote ${params.amount} ${token} from ${params.chain} to ${params.fiatCurrency}:`,
      errors.map((e) => `${e.provider}: ${e.reason}`).join(" | "),
    );
    throw new NoOfframpRateError(
      `Couldn't get a rate for ${params.amount} ${token} from ${capitalize(params.chain)} to ${params.fiatCurrency.toUpperCase()} right now (${errors.map((e) => e.reason).join("; ")}).`,
    );
  }
  return quotes.reduce((best, q) => (Number(q.toAmount) > Number(best.toAmount) ? q : best));
}
