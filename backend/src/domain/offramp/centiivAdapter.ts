import { env } from "../../config/env.js";

// Verified live against the real API (2026-08-11), not their docs site —
// docs.centiiv.io and centiiv.io both blocked/redirected every automated
// fetch attempted (a client-side-routed app that served the same fallback
// page regardless of URL requested). Every fact below came from live
// requests against api.centiiv.io using real credentials, the same
// discipline applied to Quidax earlier — including one real, live
// (unfunded, since-expired) mainnet order actually created to see the
// true response shape rather than guess field names for something this
// money-critical.
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
  // "0" at creation, always — Centiiv gives no rate until settlement
  // actually happens (confirmed: metadata.rate comes back null on a real
  // live order, and no quote/rate endpoint exists despite being
  // referenced in their docs' page-slug index — searched a dozen route
  // variants, none exist). centiivSettlementPoller.ts fills in the real
  // rate once Centiiv reveals it, updating this same send row later.
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
    rate: "0",
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
