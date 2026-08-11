import { getOfframpRate as getPaycrestRate } from "./paycrestAdapter.js";
import { getOfframpRate as getQuidaxRate, quidaxNetworkFor } from "./quidaxAdapter.js";
import { centiivNetworkFor } from "./centiivAdapter.js";

// "centiiv" is a real, valid value here (dispatchable via
// InitiateSendInput.provider) but deliberately never returned by
// selectOfframpProvider below — Centiiv gives no rate until after a real
// order is created and the deposit settles (see centiivAdapter.ts), so
// there's nothing to compare against Paycrest/Quidax's upfront quotes.
// Explicit-only by design, not an oversight.
export type OfframpProvider = "paycrest" | "quidax" | "centiiv";

// Not used by selectOfframpProvider (Centiiv is explicit-only, see above)
// — exported for callers that need to check chain eligibility before
// offering Centiiv as a manual choice.
export function isCentiivEligible(chain: string): boolean {
  return centiivNetworkFor(chain) !== null;
}

export interface ProviderQuote {
  provider: OfframpProvider;
  // "How much fiat the user actually receives" — the one number that's
  // genuinely comparable across providers, regardless of how each
  // represents rate/fee internally (Paycrest: a rate multiplier; Quidax: a
  // fee-inclusive to_amount straight from their quote).
  toAmount: string;
}

// Quidax only supports USDC on 2 of our 5 chains (verified live against
// their real API, see quidaxAdapter.ts's own comment on this) — checked
// here before ever calling their API, not left to fail per-request.
export function isQuidaxEligible(chain: string): boolean {
  return quidaxNetworkFor(chain) !== null;
}

// Queries every eligible provider in parallel and returns whichever gives
// the user more fiat. A provider erroring out (rate-limited, momentarily
// down, amount too small for their liquidity) is treated as "not
// available this round," not a hard failure — the other provider still
// gets a chance to fill the order. Only throws when neither can.
export async function selectOfframpProvider(params: {
  chain: string;
  amount: string;
  fiatCurrency: string;
}): Promise<ProviderQuote> {
  const paycrestPromise: Promise<ProviderQuote | null> = getPaycrestRate({
    network: params.chain,
    token: "USDC",
    amount: params.amount,
    fiatCurrency: params.fiatCurrency,
  })
    .then((q) => ({ provider: "paycrest" as const, toAmount: (Number(params.amount) * Number(q.rate)).toString() }))
    .catch(() => null);

  const quidaxPromise: Promise<ProviderQuote | null> = isQuidaxEligible(params.chain)
    ? getQuidaxRate({ network: params.chain, amount: params.amount, fiatCurrency: params.fiatCurrency })
        .then((q) => ({ provider: "quidax" as const, toAmount: q.toAmount }))
        .catch(() => null)
    : Promise.resolve(null);

  const [paycrest, quidax] = await Promise.all([paycrestPromise, quidaxPromise]);

  if (!paycrest && !quidax) {
    throw new Error("No off-ramp provider is available for this amount/chain right now");
  }
  if (!paycrest) return quidax as ProviderQuote;
  if (!quidax) return paycrest;
  return Number(quidax.toAmount) > Number(paycrest.toAmount) ? quidax : paycrest;
}
