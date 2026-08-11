import { env } from "../../config/env.js";

// Verified live against the real API (2026-08-11), not guessed — every
// fact below came from live requests against api.centiiv.io using real
// credentials, the same discipline applied to Quidax earlier, including
// one real, live (unfunded, since-expired) mainnet order actually created
// to see the true response shape rather than guess field names for
// something this money-critical. docs.centiiv.io (the custom domain)
// blocked/redirected every automated fetch attempted; the underlying
// readme.io project (c-vmch.readme.io) worked fine once found — that's
// where POST /public/quote (see getOfframpRate below) turned up, after a
// dozen guessed route variants missed it entirely. Lesson: a blocked docs
// site isn't proof an endpoint doesn't exist, only that it wasn't found
// yet — worth remembering before declaring a capability gap on any future
// provider integration too.
//
// Only STELLAR, SOLANA, and BASE are eligible among our five chains —
// OPTIMISM appears in Centiiv's network enum but has no real USDC->NGN
// "rail" (confirmed via a live 400: "No rail found for USDC to NGN on
// OPTIMISM"), and CELO isn't in their network enum at all.
const NETWORK_NAMES: Record<string, string> = {
  stellar: "STELLAR",
  solana: "SOLANA",
  base: "BASE",
};

export function centiivNetworkFor(chain: string): string | null {
  return NETWORK_NAMES[chain.toLowerCase()] ?? null;
}

function requireCentiivPublicKey(): string {
  if (!env.centiivPublicKey) {
    throw new Error("CENTIIV_PUBLIC_KEY must be set to use the Centiiv off-ramp provider");
  }
  return env.centiivPublicKey;
}

async function centiivFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const publicKey = requireCentiivPublicKey();
  const res = await fetch(`${env.centiivBaseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "X-API-Key": publicKey, ...(init?.headers ?? {}) },
  });
  const json = await res.json();
  if (!res.ok) {
    const message = (json as { message?: string })?.message ?? `HTTP ${res.status}`;
    throw new Error(`Centiiv request failed (${res.status} ${path}): ${message}`);
  }
  return json as T;
}

export interface Institution {
  name: string;
  code: string;
  type: string;
}

// GET /banking/banks — no country/currency param accepted or needed
// (confirmed: passing none returns the full Nigerian bank list including
// "Central Bank of Nigeria" itself); Centiiv's fiat side appears NGN-only
// today, consistent with every rail confirmed above being ...->NGN.
export async function getInstitutions(): Promise<Institution[]> {
  const res = await centiivFetch<{ success: boolean; data: { name: string; code: string }[] }>("/banking/banks");
  return res.data.map((b) => ({ code: b.code, name: b.name, type: "bank" }));
}

export interface RateQuote {
  rate: string;
  estimatedReceivableAmount: string;
  fees: string;
}

// POST /public/quote — found via the user directly pointing to Centiiv's
// real docs URL (c-vmch.readme.io) after docs.centiiv.io itself blocked
// every automated fetch attempted, including a dozen guessed route
// variants for this exact endpoint. Confirmed live: real rate, e.g. 10
// USDC -> NGN on Solana quoted at rate "1357.735", fees "0". This is a
// PREVIEW only — the order's own metadata.rate (see CreatedOrder /
// centiivSettlementPoller.ts) is the real, final settled rate, which can
// differ slightly if the market moves between this quote and the crypto
// actually arriving.
export async function getOfframpRate(params: {
  network: string;
  amount: string;
  fiatCurrency: string;
}): Promise<RateQuote> {
  const network = centiivNetworkFor(params.network);
  if (!network) throw new Error(`Centiiv off-ramp doesn't support chain ${params.network} for USDC`);
  const result = await centiivFetch<{ rate: string; estimatedReceivableAmount: string; fees: string }>(
    "/public/quote",
    {
      method: "POST",
      body: JSON.stringify({
        fromAsset: "USDC",
        toAsset: params.fiatCurrency.toUpperCase(),
        amount: Number(params.amount),
        network,
      }),
    },
  );
  return { rate: result.rate, estimatedReceivableAmount: result.estimatedReceivableAmount, fees: result.fees };
}

export interface OfframpRecipient {
  institution: string; // Centiiv bank code (e.g. "090267"), not Paycrest's or Quidax's
  accountIdentifier: string;
  accountName: string; // not sent — Centiiv resolves + returns the real name itself (see CreatedOrder below); kept for interface parity with the other adapters
}

export interface CreateOrderInput {
  amount: string;
  network: string;
  fiatCurrency: string;
  recipient: OfframpRecipient;
  reference: string; // used only as the Idempotency-Key header (confirmed live: identical header + body returns the SAME order id, no duplicate) — POST /requests rejects any extra body field outright, including a "reference" field
}

export interface CreatedOrder {
  orderId: string;
  receiveAddress: string;
  validUntil: string;
  // A real quote fetched at creation time (see getOfframpRate above), NOT
  // the order's own metadata.rate — that stays null until real settlement
  // happens, confirmed live, and can end up slightly different from this
  // quote if the market moves in between. This is a preview, same caveat
  // as Paycrest/Quidax's own rate-at-creation-time numbers.
  rate: string;
}

// A single atomic call, unlike Quidax's three-step flow — POST /requests
// does bank-account-name verification internally and returns the deposit
// address in one response. Rejects unknown body fields outright (a
// whitelist-validated DTO, confirmed live), so the shape below is exactly
// what's accepted, nothing more.
export async function createOfframpOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const network = centiivNetworkFor(input.network);
  if (!network) throw new Error(`Centiiv off-ramp doesn't support chain ${input.network} for USDC`);

  const quote = await getOfframpRate({ network: input.network, amount: input.amount, fiatCurrency: input.fiatCurrency });

  const result = await centiivFetch<{
    id: string;
    temporaryWallet: { publicAddress: string; expiresAt: string };
  }>("/requests", {
    method: "POST",
    headers: { "Idempotency-Key": input.reference },
    body: JSON.stringify({
      fromAsset: "USDC",
      toAsset: input.fiatCurrency.toUpperCase(),
      amount: Number(input.amount),
      network,
      beneficiary: {
        bankAccount: { bankCode: input.recipient.institution, accountNumber: input.recipient.accountIdentifier },
      },
    }),
  });

  return {
    orderId: result.id,
    receiveAddress: result.temporaryWallet.publicAddress,
    validUntil: result.temporaryWallet.expiresAt,
    rate: quote.rate,
  };
}

export interface CentiivRequestStatus {
  id: string;
  status: string;
  rate: string | null;
}

// GET /requests/:id — same shape as the create response. `status` only
// ever observed as "PENDING" live (no real order has settled yet to see
// a terminal value) — centiivSettlementPoller.ts deliberately does NOT
// guess a "COMPLETED"-shaped string for this reason, see its own comment.
export async function getOrderStatus(orderId: string): Promise<CentiivRequestStatus> {
  const result = await centiivFetch<{ id: string; status: string; metadata: { rate: string | null } }>(
    `/requests/${orderId}`,
  );
  return { id: result.id, status: result.status, rate: result.metadata.rate };
}
