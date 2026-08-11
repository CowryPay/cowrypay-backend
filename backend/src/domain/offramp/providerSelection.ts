import { getOfframpRate as getPaycrestRate, isPaycrestEligible } from "./paycrestAdapter.js";
import { getOfframpRate as getQuidaxRate, quidaxNetworkFor } from "./quidaxAdapter.js";
import { getOfframpRate as getCentiivRate, centiivNetworkFor } from "./centiivAdapter.js";

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
// here before ever calling their API, not left to fail per-request.
export function isQuidaxEligible(chain: string): boolean {
  return quidaxNetworkFor(chain) !== null;
}

// Centiiv supports 3 of our 5 chains (Stellar/Solana/Base — verified live
// against their real API, see centiivAdapter.ts's own comment on this).
export function isCentiivEligible(chain: string): boolean {
  return centiivNetworkFor(chain) !== null;
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
}): Promise<ProviderQuote> {
  const paycrestPromise: Promise<ProviderQuote | null> = isPaycrestEligible(params.chain)
    ? getPaycrestRate({
        network: params.chain,
        token: "USDC",
        amount: params.amount,
        fiatCurrency: params.fiatCurrency,
      })
        .then((q) => ({ provider: "paycrest" as const, toAmount: (Number(params.amount) * Number(q.rate)).toString() }))
        .catch(() => null)
    : Promise.resolve(null);

  const quidaxPromise: Promise<ProviderQuote | null> = isQuidaxEligible(params.chain)
    ? getQuidaxRate({ network: params.chain, amount: params.amount, fiatCurrency: params.fiatCurrency })
        .then((q) => ({ provider: "quidax" as const, toAmount: q.toAmount }))
        .catch(() => null)
    : Promise.resolve(null);

  const centiivPromise: Promise<ProviderQuote | null> = isCentiivEligible(params.chain)
    ? getCentiivRate({ network: params.chain, amount: params.amount, fiatCurrency: params.fiatCurrency })
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
