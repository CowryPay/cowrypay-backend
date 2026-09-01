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
// STELLAR, SOLANA, BASE, and ETHEREUM are eligible among our six chains —
// OPTIMISM appears in Centiiv's network enum but has no real USDC->NGN
// "rail" (confirmed via a live 400: "No rail found for USDC to NGN on
// OPTIMISM"), and CELO isn't in their network enum at all. ETHEREUM
// verified live (2026-09-01) with real working quotes across NGN
// (rate 1371.7, 0 fees), KES (127.34, 0 fees), and UGX (3760.7675,
// 0 fees) — the widest/cheapest Ethereum coverage of the three
// providers, TZS is the one gap (not in Centiiv's currency support at
// all, see CENTIIV_SUPPORTED_FIAT_CURRENCIES, independent of chain).
// Centiiv's network enum as of this date is actually much larger
// (ARBITRUM, POLYGON, AVALANCHE, APTOS, BSC, HYPEREVM all appeared in a
// live validation error) — only wiring up what we actually need here.
const NETWORK_NAMES: Record<string, string> = {
  stellar: "STELLAR",
  solana: "SOLANA",
  base: "BASE",
  ethereum: "ETHEREUM",
};

export function centiivNetworkFor(chain: string): string | null {
  return NETWORK_NAMES[chain.toLowerCase()] ?? null;
}

// Real bug found live: providerSelection.ts's isCentiivEligible() only
// ever checked chain support, never fiatCurrency. Centiiv's /public/quote
// doesn't validate toAsset either — it happily returned a real-looking
// rate for a UGX request ("1 USDC = 3697.343 UGX") despite the order we
// sent using the wrong beneficiary shape entirely (BANK with a Nigerian
// bank code, for a country that isn't bank-routed at all) — so that fake
// order bounced back REFUNDED. Centiiv's own team confirmed UGX is real,
// just MOBILEMONEY-routed, not BANK — see centiivBeneficiaryTypeFor below.
// Verified live (2026-08-12) via their own validation-error responses
// (same technique as finding /public/quote): UGX/KES/GHS all genuinely
// accept a correctly-shaped MOBILEMONEY order (real temp wallet returned,
// left unfunded/expired rather than actually moving money to confirm).
export const CENTIIV_SUPPORTED_FIAT_CURRENCIES = new Set(["NGN", "UGX", "KES", "GHS"]);

// Each currency's mobile-money rail has its own fixed carrier network —
// confirmed live by deliberately sending an invalid network value and
// reading Centiiv's validation error, e.g. "beneficiary.destination.network
// must be equal to MPESA" for KES. GHS additionally rejects accountName
// outright ("property accountName should not exist") — its beneficiary
// shape has one fewer field than UGX/KES, not just a different network.
const MOBILE_MONEY_BY_CURRENCY: Record<string, { networks: string[]; includeAccountName: boolean }> = {
  UGX: { networks: ["MTN", "AIRTEL"], includeAccountName: true },
  KES: { networks: ["MPESA"], includeAccountName: true },
  GHS: { networks: ["MTN"], includeAccountName: false },
};

export function centiivBeneficiaryTypeFor(fiatCurrency: string): "BANK" | "MOBILEMONEY" | null {
  const currency = fiatCurrency.toUpperCase();
  if (currency === "NGN") return "BANK";
  if (currency in MOBILE_MONEY_BY_CURRENCY) return "MOBILEMONEY";
  return null;
}

// KES and GHS only ever have one valid network, so no resolution is
// needed. UGX has two (MTN and AIRTEL) — resolved from the recipient's own
// institution name, the same free-text a user already typed/selected in
// chat (e.g. "MTN Mobile Money Uganda" vs "Airtel Money Uganda"). Returns
// null if it can't be determined, which callers must treat as a failed
// resolution (same as an institution cross-match failure), not a guess.
export function centiivMobileMoneyNetworkFor(fiatCurrency: string, institutionHint?: string): string | null {
  const config = MOBILE_MONEY_BY_CURRENCY[fiatCurrency.toUpperCase()];
  if (!config) return null;
  if (config.networks.length === 1) return config.networks[0]!;
  const hint = (institutionHint ?? "").toUpperCase();
  return config.networks.find((n) => hint.includes(n)) ?? null;
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
// "Central Bank of Nigeria" itself, and a country param is silently
// ignored — confirmed by passing country=UG and getting the same NGN
// list back). Only relevant for NGN's BANK rail — mobile-money currencies
// (UGX/KES/GHS) don't have an institution list to resolve against at all;
// their "network" is a small fixed enum, not a coded institution.
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
  token: string;
  amount: string;
  fiatCurrency: string;
}): Promise<RateQuote> {
  const network = centiivNetworkFor(params.network);
  if (!network) throw new Error(`Centiiv off-ramp doesn't support chain ${params.network} for ${params.token}`);
  const result = await centiivFetch<{ rate: string; estimatedReceivableAmount: string; fees: string }>(
    "/public/quote",
    {
      method: "POST",
      body: JSON.stringify({
        fromAsset: params.token.toUpperCase(),
        toAsset: params.fiatCurrency.toUpperCase(),
        amount: Number(params.amount),
        network,
      }),
    },
  );
  return { rate: result.rate, estimatedReceivableAmount: result.estimatedReceivableAmount, fees: result.fees };
}

export interface OfframpRecipient {
  institution: string; // Centiiv bank code (e.g. "090267") — BANK/NGN only, ignored for MOBILEMONEY
  accountIdentifier: string; // account number for BANK, phone number for MOBILEMONEY
  accountName: string; // NGN: not sent, Centiiv resolves + returns the real name itself. UGX/KES: sent as-is. GHS: not sent (rejected outright if present).
  network?: string; // required for MOBILEMONEY currencies — see centiivMobileMoneyNetworkFor
}

export interface CreateOrderInput {
  amount: string;
  network: string;
  token: string;
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
//
// The beneficiary shape genuinely differs by currency, not just its
// contents — real bug found live: a UGX order was built with
// `beneficiary.bankAccount` (a completely different top-level key from
// `beneficiary.destination`, which MOBILEMONEY actually needs), carrying a
// Nigerian bank code that meant nothing for a Uganda recipient. Centiiv's
// validation accepted the request anyway (bankCode isn't checked against
// real data) and it only surfaced as a REFUND after the fact.
export async function createOfframpOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const network = centiivNetworkFor(input.network);
  if (!network) throw new Error(`Centiiv off-ramp doesn't support chain ${input.network} for ${input.token}`);

  const beneficiaryType = centiivBeneficiaryTypeFor(input.fiatCurrency);
  if (!beneficiaryType) throw new Error(`Centiiv off-ramp doesn't support fiat currency ${input.fiatCurrency}`);

  let beneficiary: unknown;
  if (beneficiaryType === "BANK") {
    beneficiary = {
      bankAccount: { bankCode: input.recipient.institution, accountNumber: input.recipient.accountIdentifier },
    };
  } else {
    if (!input.recipient.network) {
      throw new Error(`Centiiv mobile money order for ${input.fiatCurrency} is missing a resolved network`);
    }
    const { includeAccountName } = MOBILE_MONEY_BY_CURRENCY[input.fiatCurrency.toUpperCase()]!;
    beneficiary = {
      destination: {
        type: "MOBILEMONEY",
        network: input.recipient.network,
        accountNumber: input.recipient.accountIdentifier,
        ...(includeAccountName ? { accountName: input.recipient.accountName } : {}),
      },
    };
  }

  const quote = await getOfframpRate({
    network: input.network,
    token: input.token,
    amount: input.amount,
    fiatCurrency: input.fiatCurrency,
  });

  const result = await centiivFetch<{
    id: string;
    temporaryWallet: { publicAddress: string; expiresAt: string };
  }>("/requests", {
    method: "POST",
    headers: { "Idempotency-Key": input.reference },
    body: JSON.stringify({
      fromAsset: input.token.toUpperCase(),
      toAsset: input.fiatCurrency.toUpperCase(),
      amount: Number(input.amount),
      network,
      beneficiary,
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
  // Real incident this exists to close: a live order's top-level `status`
  // said "REFUNDED" while this same array had a real entry showing Centiiv
  // had actually paid the recipient — their own data contradicting itself.
  // centiivSettlementPoller.ts treats a non-empty array here as reason to
  // NOT trust `status` alone before auto-refunding the user.
  fulfillments: Array<Record<string, unknown>>;
}

// GET /requests/:id — same shape as the create response. `status` only
// ever observed as "PENDING" live (no real order has settled yet to see
// a terminal value) — centiivSettlementPoller.ts deliberately does NOT
// guess a "COMPLETED"-shaped string for this reason, see its own comment.
export async function getOrderStatus(orderId: string): Promise<CentiivRequestStatus> {
  const result = await centiivFetch<{
    id: string;
    status: string;
    metadata: { rate: string | null };
    fulfillments?: Array<Record<string, unknown>>;
  }>(`/requests/${orderId}`);
  return { id: result.id, status: result.status, rate: result.metadata.rate, fulfillments: result.fulfillments ?? [] };
}
