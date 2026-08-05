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
import { recipientsRepo } from "../recipients/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { ledgerRepo } from "../ledger/repository.js";
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
  chain: string;
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
    chainHint: incoming.chainHint ?? existing.chainHint,
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

// Shared tail once amount + fiatCurrency + a fully-resolved recipient are
// known, whether that came from a fresh parse or a saved recipient. Locks a
// real rate by creating a Paycrest order (see resolveRemittanceIntent's own
// comment for why that's the source of truth instead of the rate-preview
// endpoint) and only sends the net amount (after platform fee) for
// conversion — the fee itself isn't moved anywhere yet, just recorded.
async function finalizeRemittanceDraft(
  userId: string,
  amount: number,
  fiatCurrency: string,
  fiatCountryLabel: string,
  recipient: SendRecipient,
  chainHint?: string,
): Promise<RemittanceResolution> {
  let treasuryAddress: string;
  try {
    treasuryAddress = requireTreasuryAddress();
  } catch (err) {
    return { ok: false, message: `Sends aren't available right now (${err instanceof Error ? err.message : String(err)}).` };
  }

  const wallet = await walletsRepo.findByUserId(userId);
  if (!wallet) return { ok: false, message: `I couldn't find your wallet — try again in a moment.` };

  // Balance is tracked per chain (USDC on one chain isn't spendable on
  // another) — resolve which chain this send draws from before locking a
  // rate. No balance anywhere yet still falls through to wallet.chain as a
  // reasonable default; the real "not enough funds" error surfaces later,
  // atomically, at actual debit time (domain/offramp/service.ts) — this is
  // only about which chain, not whether there's enough there.
  const balances = await ledgerRepo.getBalancesForUser(userId);
  const fundedChains = balances.filter((b) => b.tokenSymbol === env.defaultTokenSymbol && Number(b.availableBalance) > 0);

  let chain: string;
  if (chainHint) {
    const match = fundedChains.find((b) => b.chain.toLowerCase() === chainHint.toLowerCase());
    if (!match) {
      return {
        ok: false,
        message: `You don't have a ${env.defaultTokenSymbol} balance on ${chainHint} to send from.`,
      };
    }
    chain = match.chain;
  } else if (fundedChains.length > 1) {
    const list = fundedChains.map((b) => `${b.chain} (${b.availableBalance} ${env.defaultTokenSymbol})`).join(", ");
    return { ok: false, message: `Which chain would you like to send from? You have balance on: ${list}.` };
  } else {
    chain = fundedChains[0]?.chain ?? wallet.chain;
  }

  const amountStr = String(amount);
  const { feeAmount, netAmount } = computeFeeSplit(amountStr);
  const reference = randomUUID();

  let order;
  try {
    order = await createOfframpOrder({
      amount: netAmount,
      token: env.defaultTokenSymbol,
      network: chain,
      refundAddress: wallet.address,
      fiatCurrency,
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
    ? ` (roughly ${getCurrencySymbol(fiatCurrency)}${payout.toLocaleString()})`
    : "";

  return {
    ok: true,
    draft: {
      amount: amountStr,
      feeAmount,
      netAmount,
      treasuryAddress,
      fiatCurrency,
      recipient,
      rate: order.rate,
      reference,
      orderId: order.orderId,
      receiveAddress: order.receiveAddress,
      validUntil: order.validUntil,
      chain,
    },
    summary: `Ready to send $${amountStr} to ${recipient.accountName}${fiatCountryLabel}${payoutEstimate}. Fee: ${feeAmount} ${env.defaultTokenSymbol}. This quote is locked for about an hour — confirm in the app to enter your PIN and complete it.`,
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

  // A saved recipient (e.g. "mom") skips country/institution/account
  // resolution entirely — those were already settled the first time this
  // recipient was saved. This is the whole point of saving one.
  if (intent.recipientNickname) {
    const saved = await recipientsRepo.findByNickname(userId, intent.recipientNickname);
    if (saved) {
      const recipient: SendRecipient = {
        institution: saved.institution,
        institutionName: saved.institutionName,
        accountIdentifier: saved.accountIdentifier,
        accountName: saved.accountName,
        memo: saved.nickname,
      };
      return finalizeRemittanceDraft(
        userId,
        intent.amount,
        saved.fiatCurrency,
        ` (${saved.institutionName})`,
        recipient,
        intent.chainHint,
      );
    }
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

  // The user may have re-entered this account fresh instead of referencing
  // it by nickname — check whether it's already saved under one so `memo`
  // still gets set. The frontend reads memo's presence as "already saved";
  // leaving it unset here for an already-saved account is exactly what was
  // prompting users to save the same recipient again on a second transfer.
  const alreadySaved = await recipientsRepo.findByAccountIdentifier(userId, matched.code, intent.accountIdentifier);
  const nicknameForMemo = intent.recipientNickname ?? alreadySaved?.nickname;

  const recipient: SendRecipient = {
    institution: matched.code,
    institutionName: matched.name,
    accountIdentifier: intent.accountIdentifier,
    accountName: verified.accountName,
    ...(nicknameForMemo ? { memo: nicknameForMemo } : {}),
  };

  return finalizeRemittanceDraft(
    userId,
    intent.amount,
    country.currencyCode,
    ` (${matched.name}) in ${country.name}`,
    recipient,
    intent.chainHint,
  );
}
