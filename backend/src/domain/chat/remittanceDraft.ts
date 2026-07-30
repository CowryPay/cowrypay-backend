import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { getCurrencySymbol, resolveCountry, SUPPORTED_COUNTRIES } from "../../ai-agent/offramp/countries.js";
import { describeInstitutionPrompt, findInstitutionMatches } from "../../ai-agent/offramp/institutionMatch.js";
import { createOfframpOrder, getInstitutions, verifyRecipientAccount, type Institution } from "../offramp/paycrestAdapter.js";
import { walletsRepo } from "../wallets/repository.js";
import type { SendRecipient } from "../../types.js";
import type { ParsedIntent } from "./schemas.js";
import { resolveInstitutionWithLlm } from "./llm.js";

export interface RemittanceDraft {
  amount: string;
  fiatCurrency: string;
  recipient: SendRecipient;
  rate: string;
  reference: string;
  orderId: string;
  receiveAddress: string;
  validUntil: string;
}

export type RemittanceResolution =
  | { ok: true; draft: RemittanceDraft; summary: string }
  | { ok: false; message: string };

export type RemittanceIntent = Extract<ParsedIntent, { kind: "remittance" }>;

// Fills gaps in a newly-parsed message with whatever the prior draft already
// had — new non-empty values win, missing ones fall back to what's already
// known. Doesn't trust the LLM to always echo prior fields back itself.
export function mergeRemittanceDrafts(existing: RemittanceIntent, incoming: RemittanceIntent): RemittanceIntent {
  return {
    kind: "remittance",
    action: "SEND_REMITTANCE",
    amount: incoming.amount ?? existing.amount,
    recipientNickname: incoming.recipientNickname ?? existing.recipientNickname,
    countryHint: incoming.countryHint ?? existing.countryHint,
    institutionHint: incoming.institutionHint ?? existing.institutionHint,
    accountIdentifier: incoming.accountIdentifier ?? existing.accountIdentifier,
  };
}

// Turns a parsed remittance intent into either a fully-resolved, ready-to-send
// draft, or a conversational question asking for whatever's missing/ambiguous.
//
// Gets its rate by actually creating a real Paycrest order, not by previewing
// one — Paycrest's GET /rates estimate endpoint doesn't cover every network
// (Celo included) even when real payout liquidity exists there, so relying
// on it produces false "no provider available" errors. Creating the order up
// front doesn't move any funds itself (only the still-unbuilt Blockradar
// withdraw step does that, gated behind PIN) — it just locks a real rate and
// receive address, which POST /offramp/sends reuses on confirm instead of
// creating a second, redundant order. This never calls initiateSend itself:
// chat only ever gets to *propose*, never to *execute*.
export async function resolveRemittanceIntent(
  userId: string,
  intent: RemittanceIntent,
): Promise<RemittanceResolution> {
  if (intent.amount == null || intent.amount <= 0) {
    return { ok: false, message: `How much would you like to send? e.g. "send $50 to a bank account in Nigeria".` };
  }

  const country = resolveCountry(intent.countryHint);
  if (!country) {
    return {
      ok: false,
      message: `Which country is this going to? I currently support ${SUPPORTED_COUNTRIES.join(", ")}.`,
    };
  }

  if (!intent.institutionHint) {
    return { ok: false, message: `Which bank or mobile money provider should I send to?` };
  }

  if (!intent.accountIdentifier) {
    return { ok: false, message: `What's the account number or phone number to send to?` };
  }

  const wallet = await walletsRepo.findByUserId(userId);
  if (!wallet) return { ok: false, message: `I couldn't find your wallet — try again in a moment.` };

  let institutions;
  try {
    institutions = await getInstitutions(country.currencyCode);
  } catch {
    return { ok: false, message: `I couldn't look up providers for ${country.name} right now — try again shortly.` };
  }

  let matched: Institution | null = findInstitutionMatches(intent.institutionHint, institutions)[0] ?? null;
  if (!matched) {
    matched = await resolveInstitutionWithLlm(intent.institutionHint, institutions);
  }
  if (!matched) {
    return { ok: false, message: describeInstitutionPrompt(institutions) };
  }

  let verified;
  try {
    verified = await verifyRecipientAccount({
      institution: matched.code,
      accountIdentifier: intent.accountIdentifier,
    });
  } catch {
    return {
      ok: false,
      message: `I couldn't verify that account at ${matched.name} — double check the number and try again.`,
    };
  }

  const amount = String(intent.amount);
  const recipient: SendRecipient = {
    institution: matched.code,
    accountIdentifier: intent.accountIdentifier,
    accountName: verified.accountName,
    ...(intent.recipientNickname ? { memo: intent.recipientNickname } : {}),
  };
  const reference = randomUUID();

  let order;
  try {
    order = await createOfframpOrder({
      amount,
      token: env.defaultTokenSymbol,
      network: wallet.chain,
      refundAddress: wallet.address,
      fiatCurrency: country.currencyCode,
      recipient,
      reference,
    });
  } catch (err) {
    return {
      ok: false,
      message: `Couldn't lock a rate for that right now (${err instanceof Error ? err.message : String(err)}). Try again in a moment.`,
    };
  }

  const payout = Number(amount) * Number(order.rate);
  const payoutEstimate = Number.isFinite(payout)
    ? ` (roughly ${getCurrencySymbol(country.currencyCode)}${payout.toLocaleString()})`
    : "";

  return {
    ok: true,
    draft: {
      amount,
      fiatCurrency: country.currencyCode,
      recipient,
      rate: order.rate,
      reference,
      orderId: order.orderId,
      receiveAddress: order.receiveAddress,
      validUntil: order.validUntil,
    },
    summary: `Ready to send $${amount} to ${verified.accountName} (${matched.name}) in ${country.name}${payoutEstimate}. This quote is locked for about an hour — confirm in the app to enter your PIN and complete it.`,
  };
}
