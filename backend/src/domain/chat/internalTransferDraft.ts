import { ledgerRepo } from "../ledger/repository.js";
import { stellarMemoRepo } from "../wallets/stellarMemoRepository.js";
import { stellarSupportedTokens } from "../wallets/stellarAssets.js";
import { env } from "../../config/env.js";
import { formatAmount } from "../../utils/format.js";
import type { ParsedIntent } from "./schemas.js";

export interface InternalTransferDraft {
  amount: string;
  recipientMemoId: string;
  tokenSymbol: string;
}

export type InternalTransferIntent = Extract<ParsedIntent, { kind: "internalTransfer" }>;

export type InternalTransferResolution =
  | { ok: true; draft: InternalTransferDraft; summary: string }
  | { ok: false; message: string };

// Mirrors cryptoWithdrawalDraft.ts's mergeCryptoWithdrawalDrafts exactly —
// new non-empty values win, missing ones fall back to what's already known
// from an earlier message in the same multi-turn exchange.
export function mergeInternalTransferDrafts(
  existing: InternalTransferIntent,
  incoming: InternalTransferIntent,
): InternalTransferIntent {
  return {
    kind: "internalTransfer",
    action: "SEND_TO_COWRYPAY_USER",
    amount: incoming.amount ?? existing.amount,
    recipientMemoId: incoming.recipientMemoId ?? existing.recipientMemoId,
    tokenHint: incoming.tokenHint ?? existing.tokenHint,
  };
}

// Same §9 boundary as cryptoWithdrawalDraft.ts's own — this only ever
// produces a DRAFT the frontend must show the user in full before they
// enter their PIN and the app calls the real POST /internal-transfers/
// stellar endpoint directly; chat never calls it. The one thing a wrong
// memo here can't do that a wrong address in a real crypto withdrawal
// can: send money somewhere genuinely unrecoverable — a bad memo either
// matches no one (rejected cleanly) or a real CowryPay account, fixable
// through support — but it's still real money moving between two real
// balances, so the same PIN-gated confirmation step still applies.
export async function resolveInternalTransferIntent(
  userId: string,
  intent: InternalTransferIntent,
): Promise<InternalTransferResolution> {
  if (intent.amount == null || intent.amount <= 0) {
    return { ok: false, message: "How much would you like to send?" };
  }
  if (!intent.recipientMemoId) {
    return { ok: false, message: "What's the recipient's CowryPay memo?" };
  }
  if (!/^\d+$/.test(intent.recipientMemoId)) {
    return { ok: false, message: `"${intent.recipientMemoId}" isn't a valid memo — it should be a plain number.` };
  }

  const tokenSymbol = (intent.tokenHint ?? env.defaultTokenSymbol).toUpperCase();
  if (!stellarSupportedTokens().includes(tokenSymbol)) {
    return {
      ok: false,
      message: `Stellar doesn't support ${tokenSymbol} yet — only ${stellarSupportedTokens().join(", ")}.`,
    };
  }

  const recipient = await stellarMemoRepo.findByMemoId(BigInt(intent.recipientMemoId));
  if (!recipient) {
    return { ok: false, message: `No CowryPay user found with memo ${intent.recipientMemoId} — double-check it and try again.` };
  }
  if (recipient.userId === userId) {
    return { ok: false, message: "You can't transfer to your own memo." };
  }

  const amountStr = intent.amount.toString();
  const balances = await ledgerRepo.getBalancesForUser(userId);
  const balance = balances.find((b) => b.chain === "stellar" && b.tokenSymbol === tokenSymbol);
  if (!balance || Number(balance.availableBalance) < intent.amount) {
    const available = formatAmount(balance?.availableBalance ?? "0");
    return {
      ok: false,
      message: `You only have ${available} ${tokenSymbol} available on Stellar — that's less than the ${amountStr} you asked to send.`,
    };
  }

  const draft: InternalTransferDraft = { amount: amountStr, recipientMemoId: intent.recipientMemoId, tokenSymbol };

  return {
    ok: true,
    draft,
    summary: `Ready to send ${amountStr} ${tokenSymbol} to CowryPay memo ${intent.recipientMemoId} — no fee, instant, no blockchain involved. Confirm in the app to enter your PIN and complete it.`,
  };
}
