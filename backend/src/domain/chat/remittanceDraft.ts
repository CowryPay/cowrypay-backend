import { env } from "../../config/env.js";
import { getCurrencySymbol, resolveCountry, SUPPORTED_COUNTRIES } from "../../ai-agent/offramp/countries.js";
import { describeInstitutionPrompt, findInstitutionMatches } from "../../ai-agent/offramp/institutionMatch.js";
import { getInstitutions, getOfframpRate, verifyRecipientAccount, type Institution } from "../offramp/paycrestAdapter.js";
import { walletsRepo } from "../wallets/repository.js";
import type { SendRecipient } from "../../types.js";
import type { ParsedIntent } from "./schemas.js";
import { resolveInstitutionWithLlm } from "./llm.js";

export interface RemittanceDraft {
  amount: string;
  fiatCurrency: string;
  recipient: SendRecipient;
  rate?: string;
}

export type RemittanceResolution =
  | { ok: true; draft: RemittanceDraft; summary: string }
  | { ok: false; message: string };

type RemittanceIntent = Extract<ParsedIntent, { kind: "remittance" }>;

// Turns a parsed remittance intent into either a fully-resolved, ready-to-send
// draft, or a conversational question asking for whatever's missing/ambiguous.
// This never calls initiateSend itself — the frontend collects the PIN
// through its own dedicated flow and submits the confirmed draft to
// POST /offramp/sends, same as a manually-filled-in send. Chat only ever
// gets to *propose*, never to *execute*.
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
  let rate: string | undefined;
  let payoutEstimate = "";
  try {
    const quote = await getOfframpRate({
      network: wallet.chain,
      token: env.defaultTokenSymbol,
      amount,
      fiatCurrency: country.currencyCode,
    });
    rate = quote.rate;
    const payout = Number(intent.amount) * Number(quote.rate);
    if (Number.isFinite(payout)) {
      payoutEstimate = ` (roughly ${getCurrencySymbol(country.currencyCode)}${payout.toLocaleString()})`;
    }
  } catch {
    // Non-critical — proceed without a payout estimate in the summary.
  }

  const recipient: SendRecipient = {
    institution: matched.code,
    accountIdentifier: intent.accountIdentifier,
    accountName: verified.accountName,
    ...(intent.recipientNickname ? { memo: intent.recipientNickname } : {}),
  };

  return {
    ok: true,
    draft: { amount, fiatCurrency: country.currencyCode, recipient, rate },
    summary: `Ready to send $${amount} to ${verified.accountName} (${matched.name}) in ${country.name}${payoutEstimate}. Confirm in the app to enter your PIN and complete it.`,
  };
}
