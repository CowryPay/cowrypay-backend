import { env } from "../../config/env.js";

// Verified live against the real API (2026-08-12) — Paycrest returns a
// hard "Token USDC is not supported on network X" for Optimism, Solana,
// and Stellar, both at rate-lookup AND order-creation time. Distinct from
// Celo's known quirk (rate-preview alone fails with "no provider
// available," but real order creation still works — confirmed via many
// completed Celo sends this session) — that's a liquidity/preview gap,
// this is Paycrest structurally not having the network at all. Used to
// gate providerSelection.ts's rate comparison AND, critically, the
// fallback-to-Paycrest retry in remittanceDraft.ts, which was blindly
// retrying Paycrest for Stellar sends whenever the winning alt provider
// failed — producing exactly this confusing raw validation error instead
// of an honest "no provider available" message. Ethereum is NOT in this
// set — verified live (2026-09-01) with real working rates: network name
// is "ethereum" (not "eth", which gets the same hard-unsupported error
// shape). NGN and TZS both return real rates on Ethereum; KES and UGX
// currently return "no provider available" there — same liquidity/preview
// gap as Celo's own quirk above, not a structural unsupported-network
// error, so not added here.
const UNSUPPORTED_NETWORKS = new Set(["optimism", "solana", "stellar"]);

// Real gap found live (2026-08-31), same bug class already fixed for
// Quidax/Centiiv (see their own SUPPORTED_FIAT_CURRENCIES comments) but
// never applied here: this function only ever checked chain support,
// never fiatCurrency, so a GHS-bound send on an eligible chain (e.g.
// Base) was still treated as Paycrest-eligible and queried for a rate.
// Verified live against docs.paycrest.io/resources/supported-currencies
// AND a real GET /rates call (GHS cleanly rejected: "Fiat currency GHS
// is not supported") — Paycrest's own rate endpoint does validate this
// correctly, unlike Quidax/Centiiv's historical fake-rate behavior, so
// the practical danger here was smaller (a wasted API call, not a wrong
// provider winning the comparison), but the explicit gate is still the
// right fix: consistent with the other two providers, and doesn't rely
// on a downstream API happening to validate what this function should.
export const PAYCREST_SUPPORTED_FIAT_CURRENCIES = new Set(["NGN", "KES", "UGX", "TZS"]);

export function isPaycrestEligible(chain: string, fiatCurrency: string): boolean {
  return !UNSUPPORTED_NETWORKS.has(chain.toLowerCase()) && PAYCREST_SUPPORTED_FIAT_CURRENCIES.has(fiatCurrency.toUpperCase());
}

// Distinguished from a generic order-creation failure so callers can show a
// clean, actionable message instead of relaying Paycrest's raw validation
// text — this fires when no liquidity provider will fill an order (seen in
// practice for very small amounts, e.g. sub-$1 USDC->NGN), not a bug in our
// request.
export class NoLiquidityProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoLiquidityProviderError";
  }
}

export interface RateQuote {
  rate: string;
}

export interface Institution {
  name: string;
  code: string;
  type: string;
}

// docs.paycrest.io — GET /institutions/{currency} is public, no API key
// needed. Returns the valid bank / mobile-money codes for a currency;
// `institution` on verify-account and order creation must be one of these
// codes, not a free-text name.
export async function getInstitutions(currencyCode: string): Promise<Institution[]> {
  const res = await fetch(`${env.paycrestBaseUrl}/institutions/${currencyCode}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Paycrest institutions lookup failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: Institution[] };
  return json.data ?? [];
}

// docs.paycrest.io — GET /rates/{network}/{token}/{amount}/{fiat} is public,
// no API key needed. `sell` is the rate to quote a user off-ramping crypto
// to fiat (this is the offramp-only adapter for now).
export async function getOfframpRate(params: {
  network: string;
  token: string;
  amount: string;
  fiatCurrency: string;
}): Promise<RateQuote> {
  const url = `${env.paycrestBaseUrl}/rates/${params.network}/${params.token}/${params.amount}/${params.fiatCurrency}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Paycrest rate lookup failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data: { sell: { rate: string } } };
  return { rate: json.data.sell.rate };
}

export interface OfframpRecipient {
  institution: string;
  accountIdentifier: string;
  accountName: string;
  memo?: string;
}

export interface CreateOrderInput {
  amount: string;
  token: string;
  network: string;
  refundAddress: string;
  fiatCurrency: string;
  recipient: OfframpRecipient;
  reference: string;
  rate?: string;
}

export interface CreatedOrder {
  orderId: string;
  receiveAddress: string;
  validUntil: string;
  rate: string;
}

function requirePaycrestApiKey(): string {
  if (!env.paycrestApiKey) {
    throw new Error("PAYCREST_API_KEY must be set to create off-ramp orders");
  }
  return env.paycrestApiKey;
}

export async function createOfframpOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const apiKey = requirePaycrestApiKey();

  const res = await fetch(`${env.paycrestBaseUrl}/sender/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "API-Key": apiKey },
    body: JSON.stringify({
      amount: input.amount,
      reference: input.reference,
      ...(input.rate ? { rate: input.rate } : {}),
      source: {
        type: "crypto",
        currency: input.token,
        network: input.network,
        refundAddress: input.refundAddress,
      },
      destination: {
        type: "fiat",
        currency: input.fiatCurrency,
        recipient: input.recipient,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    let parsed: { data?: { field?: string; message?: string } } | null = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // not JSON — fall through to the generic error below
    }
    if (parsed?.data?.field === "Rate" && parsed.data.message?.toLowerCase().includes("no provider available")) {
      throw new NoLiquidityProviderError(
        "That amount is too small to convert right now — try sending a larger amount.",
      );
    }
    throw new Error(`Paycrest order creation failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    data: {
      id: string;
      rate: string;
      validUntil?: string;
      receiveAddress?: string;
      providerAccount?: { receiveAddress?: string; validUntil?: string };
    };
  };
  const receiveAddress = json.data.providerAccount?.receiveAddress ?? json.data.receiveAddress;
  const validUntil = json.data.providerAccount?.validUntil ?? json.data.validUntil;
  if (!receiveAddress || !validUntil) {
    throw new Error("Paycrest order response had no receiveAddress/validUntil — response shape needs re-checking");
  }

  return { orderId: json.data.id, receiveAddress, validUntil, rate: json.data.rate };
}

export interface VerifiedAccount {
  accountName: string;
}

export async function verifyRecipientAccount(recipient: {
  institution: string;
  accountIdentifier: string;
}): Promise<VerifiedAccount> {
  const apiKey = requirePaycrestApiKey();

  const res = await fetch(`${env.paycrestBaseUrl}/verify-account`, {
    method: "POST",
    headers: { "content-type": "application/json", "API-Key": apiKey },
    body: JSON.stringify(recipient),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Paycrest account verification failed (${res.status}): ${body}`);
  }

  // docs.paycrest.io — `data` is the resolved account name itself (a plain
  // string), or "OK" when name lookup is unavailable — not an object.
  const json = (await res.json()) as { data: string };
  return { accountName: json.data };
}

export interface OrderStatus {
  id: string;
  status: string;
  amountPaid?: string;
  // Populated once Paycrest actually moves crypto on-chain themselves —
  // confirmed live on a "refunded" order: this is the on-chain tx hash of
  // THEIR OWN refund payment back to our refundAddress. Real incident
  // this exists to close: that refund lands directly in a user's own
  // AWS-KMS wallet, indistinguishable on-chain from an ordinary deposit —
  // see sendStateTransition.ts's applyTerminalFailureTransition, which
  // uses this to pre-register the transaction so the deposit scanner
  // doesn't credit it a second time.
  txHash?: string;
}

// docs.paycrest.io — GET /sender/orders/{id}, requires API key. Used to poll
// an order after creation (the sends state machine also gets updates via the
// payment_order.* webhook, but polling covers the gap before that arrives).
export async function getOrderStatus(orderId: string): Promise<OrderStatus> {
  const apiKey = requirePaycrestApiKey();

  const res = await fetch(`${env.paycrestBaseUrl}/sender/orders/${orderId}`, {
    headers: { "API-Key": apiKey },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Paycrest order status lookup failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as { data?: { id: string; status: string; amountPaid?: string; txHash?: string } };
  if (!json.data) {
    throw new Error("Paycrest order status response missing data");
  }
  return {
    id: json.data.id,
    status: json.data.status,
    amountPaid: json.data.amountPaid,
    txHash: json.data.txHash || undefined,
  };
}
