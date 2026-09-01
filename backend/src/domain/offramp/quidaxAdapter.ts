import { env } from "../../config/env.js";

// Verified live against the real API (2026-08-10), not just Quidax's docs —
// their docs disagreed with the live API in multiple places (e.g. docs say
// "sol" and "lisk", the live API only accepts "solana" and "lsk"; docs list
// Arbitrum as USDC-supported, the live API rejects it under every name
// tried). base/solana/ethereum are eligible for USDC on Quidax among our
// six chains — Celo/Optimism/Stellar aren't supported by Quidax for USDC
// regardless of naming (see providerSelection.ts for the eligibility gate
// that keeps this adapter from ever being called for those chains).
// Ethereum is the same story as "sol"/"lisk" above: neither "ethereum" nor
// "eth" work, only the non-obvious "erc20" — verified live (2026-09-01)
// with a real working quote (10 USDC -> fee 25.0, to_amount 13709.4 NGN).
// Quidax only ever covers NGN among our currencies regardless of chain
// (see QUIDAX_SUPPORTED_FIAT_CURRENCIES) — Ethereum doesn't change that.
const NETWORK_NAMES: Record<string, string> = {
  base: "base",
  solana: "solana",
  ethereum: "erc20",
};

export function quidaxNetworkFor(chain: string): string | null {
  return NETWORK_NAMES[chain.toLowerCase()] ?? null;
}

function requireQuidaxSecretKey(): string {
  if (!env.quidaxSecretKey) {
    throw new Error("QUIDAX_SECRET_KEY must be set to use the Quidax off-ramp provider");
  }
  return env.quidaxSecretKey;
}

async function quidaxFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const secretKey = requireQuidaxSecretKey();
  const res = await fetch(`${env.quidaxBaseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-private-key": secretKey, ...(init?.headers ?? {}) },
  });
  const json = (await res.json()) as { status: string; message: string; data: T | null };
  if (!res.ok || json.status !== "ok") {
    throw new Error(`Quidax request failed (${res.status} ${path}): ${json.message ?? "unknown error"}`);
  }
  return json.data as T;
}

export interface Institution {
  name: string;
  code: string;
  type: string;
}

// GET /merchants/custodial/banks — country, not currency, is the actual
// param (NG/GH), unlike Paycrest's currency-code-keyed institutions
// lookup — mapped here so callers can keep using the same fiatCurrency
// vocabulary as the rest of this codebase.
const COUNTRY_FOR_FIAT: Record<string, string> = { NGN: "NG", GHS: "GH" };

// Real bug found live: providerSelection.ts's isQuidaxEligible() only ever
// checked chain support, never fiatCurrency — so a non-NGN/GHS send on an
// otherwise-eligible chain (e.g. UGX on Base) still got compared here.
// Quidax's own rate/order endpoints below don't validate to_currency
// either, they just pass it straight through — same shape of gap as
// Centiiv's (see CENTIIV_SUPPORTED_FIAT_CURRENCIES), so this can't rely on
// the provider to reject it. Derived from COUNTRY_FOR_FIAT rather than a
// second hardcoded list, since that's already the authoritative "what
// currencies does Quidax off-ramp actually support" source in this file.
export const QUIDAX_SUPPORTED_FIAT_CURRENCIES = new Set(Object.keys(COUNTRY_FOR_FIAT));

export async function getInstitutions(fiatCurrency: string): Promise<Institution[]> {
  const country = COUNTRY_FOR_FIAT[fiatCurrency.toUpperCase()];
  if (!country) throw new Error(`Quidax off-ramp doesn't support fiat currency ${fiatCurrency}`);
  const banks = await quidaxFetch<{ code: string; name: string }[]>(`/merchants/custodial/banks?country=${country}`);
  return banks.map((b) => ({ code: b.code, name: b.name, type: "bank" }));
}

// Deliberately richer than Paycrest's { rate } — Quidax's quote already
// nets out its own fee into to_amount, so "how much fiat does the user
// actually get" is to_amount directly, not something requiring a separate
// fee subtraction. providerSelection.ts compares toAmount values, not
// synthesized rates, for exactly this reason (an apples-to-apples "what
// does the user actually receive" comparison, not two differently-shaped
// rate figures).
export interface QuidaxRateQuote {
  toAmount: string;
  fee: string;
}

export async function getOfframpRate(params: {
  network: string;
  token: string;
  amount: string;
  fiatCurrency: string;
}): Promise<QuidaxRateQuote> {
  const network = quidaxNetworkFor(params.network);
  if (!network) throw new Error(`Quidax off-ramp doesn't support chain ${params.network} for ${params.token}`);
  const query = new URLSearchParams({
    token: params.token.toLowerCase(),
    currency: params.fiatCurrency.toLowerCase(),
    token_amount: params.amount,
    token_network: network,
  });
  const data = await quidaxFetch<{ to_amount: string; fee: string }>(`/merchants/purchase_quotes/sell?${query}`);
  return { toAmount: data.to_amount, fee: data.fee };
}

// Splits "NSEMEKE EKPEMA EKARIKA" into first_name="NSEMEKE",
// last_name="EKPEMA EKARIKA" — a heuristic, not a real name parser. Only
// matters for Quidax's name-match check against the bank account (see
// createOfframpOrder below); a bad split risks a false "name doesn't
// match" rejection, not a wrong payout — the account itself is still
// keyed by bank_code + account_number, not by name.
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] ?? fullName, lastName: parts.slice(1).join(" ") || parts[0] || fullName };
}

export interface OfframpRecipient {
  institution: string; // Quidax bank code (e.g. "044"), not Paycrest's institution code
  accountIdentifier: string;
  accountName: string;
}

export interface CreateOrderInput {
  amount: string;
  network: string;
  token: string;
  fiatCurrency: string;
  recipient: OfframpRecipient;
  reference: string;
}

export interface CreatedOrder {
  orderId: string; // our own reference — see the class comment above quidaxFetch for why
  receiveAddress: string;
  validUntil: string;
  rate: string;
}

// Composite: Quidax's own flow is three separate calls (initiate → attach
// bank account → confirm) rather than Paycrest's single order-creation
// call — collapsed into one function here so callers (offramp/service.ts)
// don't need to know the difference. No customer-side rate-lock/expiry
// concept exists in Quidax's API the way Paycrest's validUntil does; a
// synthetic 30-minute window is used instead purely so the existing
// reused-order logic (checking validUntil before reusing a locked quote)
// has something to compare against.
export async function createOfframpOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const network = quidaxNetworkFor(input.network);
  if (!network) throw new Error(`Quidax off-ramp doesn't support chain ${input.network} for ${input.token}`);
  const { firstName, lastName } = splitName(input.recipient.accountName);

  const initiated = await quidaxFetch<{ to_amount: string; from_amount: string; status: string }>(
    "/merchants/custodial/off_ramp_transactions/initiate",
    {
      method: "POST",
      body: JSON.stringify({
        from_currency: input.token.toLowerCase(),
        to_currency: input.fiatCurrency.toLowerCase(),
        from_amount: input.amount,
        network,
        merchant_reference: input.reference,
        customer: { first_name: firstName, last_name: lastName },
      }),
    },
  );

  await quidaxFetch(`/merchants/custodial/off_ramp_transactions/${input.reference}/bank_account`, {
    method: "POST",
    body: JSON.stringify({
      bank_code: input.recipient.institution,
      account_number: input.recipient.accountIdentifier,
      currency_code: input.fiatCurrency.toLowerCase(),
    }),
  });

  const confirmed = await quidaxFetch<{ address: string }>(
    `/merchants/custodial/off_ramp_transactions/${input.reference}/confirm`,
    { method: "POST" },
  );

  const rate = (Number(initiated.to_amount) / Number(initiated.from_amount)).toString();
  const validUntil = new Date(Date.now() + 30 * 60_000).toISOString();

  return { orderId: input.reference, receiveAddress: confirmed.address, validUntil, rate };
}

export interface OrderStatus {
  id: string;
  status: string;
  amountPaid?: string;
}

// Keyed by our own reference (merchant_reference), matching the other two
// endpoints above — not yet confirmed against Quidax's docs, which are
// ambiguous on this specific point (their example just says "reference"),
// so verify with a real transaction before relying on this in production.
export async function getOrderStatus(reference: string): Promise<OrderStatus> {
  const data = await quidaxFetch<{ public_id: string; status: string; fiat_payout?: { amount?: string } }>(
    `/merchants/off_ramp_transaction/${reference}`,
  );
  return { id: data.public_id, status: data.status, amountPaid: data.fiat_payout?.amount };
}
