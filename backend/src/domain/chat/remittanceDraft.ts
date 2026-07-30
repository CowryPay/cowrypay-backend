import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import {
  getCurrencySymbol,
  listSupportedCountries,
  resolveCountry,
  SUPPORTED_COUNTRIES,
  type CountryInfo,
} from "../../ai-agent/offramp/countries.js";
import { describeInstitutionPrompt, findInstitutionMatches } from "../../ai-agent/offramp/institutionMatch.js";
import { createOfframpOrder, getInstitutions, verifyRecipientAccount, type Institution } from "../offramp/paycrestAdapter.js";
import { computeFeeSplit, requireTreasuryAddress } from "../offramp/fee.js";
import { walletsRepo } from "../wallets/repository.js";
import type { SendRecipient } from "../../types.js";
import type { ParsedIntent } from "./schemas.js";
import { resolveInstitutionWithLlm } from "./llm.js";

export interface RemittanceDraft {
  amount: string;
  feeAmount: string;
  netAmount: string;
  treasuryAddress: string;
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

/**
 * Some institutions only operate in one country (e.g. "OPay" -> Nigeria
 * only). When the user names a specific provider before naming a country,
 * search every supported corridor's institution list and, if the name
 * resolves to exactly one country, infer the country instead of asking for
 * it. Falls back to null (caller asks the country question as usual) if
 * it's ambiguous, unmatched, or a lookup fails.
 */
async function resolveInstitutionAcrossCountries(
  query: string,
): Promise<{ country: CountryInfo; institution: Institution } | null> {
  const countries = listSupportedCountries();
  const results = await Promise.all(
    countries.map(async (country) => {
      try {
        const institutions = await getInstitutions(country.currencyCode);
        const matches = findInstitutionMatches(query, institutions);
        if (matches.length === 1) return { country, institution: matches[0]! };
      } catch {
        // Ignore per-corridor lookup failures — worst case we miss an inference.
      }
      return null;
    }),
  );
  const hits = results.filter((r): r is { country: CountryInfo; institution: Institution } => r !== null);
  return hits.length === 1 ? hits[0]! : null;
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
//
// Only the net amount (after the platform fee) is sent to Paycrest for
// conversion — the fee itself isn't moved anywhere yet (that's the
// still-unbuilt withdraw step's job), just recorded on the draft.
export async function resolveRemittanceIntent(
  userId: string,
  intent: RemittanceIntent,
): Promise<RemittanceResolution> {
  if (intent.amount == null || intent.amount <= 0) {
    return { ok: false, message: `How much would you like to send? e.g. "send $50 to a bank account in Nigeria".` };
  }

  let country = resolveCountry(intent.countryHint);
  let matched: Institution | null = null;

  // Country wasn't named, but an institution was — try inferring it before
  // asking a question the institution name might already answer.
  if (!country && intent.institutionHint) {
    const inferred = await resolveInstitutionAcrossCountries(intent.institutionHint);
    if (inferred) {
      country = inferred.country;
      matched = inferred.institution;
    }
  }

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

  let treasuryAddress: string;
  try {
    treasuryAddress = requireTreasuryAddress();
  } catch (err) {
    return { ok: false, message: `Sends aren't available right now (${err instanceof Error ? err.message : String(err)}).` };
  }

  const wallet = await walletsRepo.findByUserId(userId);
  if (!wallet) return { ok: false, message: `I couldn't find your wallet — try again in a moment.` };

  // Only re-resolve the institution against this country's list if the
  // cross-country search above didn't already nail it down.
  if (!matched) {
    let institutions;
    try {
      institutions = await getInstitutions(country.currencyCode);
    } catch {
      return { ok: false, message: `I couldn't look up providers for ${country.name} right now — try again shortly.` };
    }

    matched = findInstitutionMatches(intent.institutionHint, institutions)[0] ?? null;
    if (!matched) {
      matched = await resolveInstitutionWithLlm(intent.institutionHint, institutions);
    }
    if (!matched) {
      return { ok: false, message: describeInstitutionPrompt(institutions) };
    }
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
  const { feeAmount, netAmount } = computeFeeSplit(amount);
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
      amount: netAmount,
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

  const payout = Number(netAmount) * Number(order.rate);
  const payoutEstimate = Number.isFinite(payout)
    ? ` (roughly ${getCurrencySymbol(country.currencyCode)}${payout.toLocaleString()})`
    : "";

  return {
    ok: true,
    draft: {
      amount,
      feeAmount,
      netAmount,
      treasuryAddress,
      fiatCurrency: country.currencyCode,
      recipient,
      rate: order.rate,
      reference,
      orderId: order.orderId,
      receiveAddress: order.receiveAddress,
      validUntil: order.validUntil,
    },
    summary: `Ready to send $${amount} to ${verified.accountName} (${matched.name}) in ${country.name}${payoutEstimate}. Fee: ${feeAmount} ${env.defaultTokenSymbol}. This quote is locked for about an hour — confirm in the app to enter your PIN and complete it.`,
  };
}
