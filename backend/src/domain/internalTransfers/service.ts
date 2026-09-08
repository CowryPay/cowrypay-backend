import { randomUUID } from "node:crypto";
import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import type { InternalTransfer } from "../../types.js";
import { usersRepo } from "../users/repository.js";
import { ledgerRepo } from "../ledger/repository.js";
import { canInitiateSend } from "../sendAuthorization.js";
import { verifyTransactionPin } from "../pin/service.js";
import { stellarMemoRepo } from "../wallets/stellarMemoRepository.js";
import { stellarSupportedTokens } from "../wallets/stellarAssets.js";
import { internalTransfersRepo } from "./repository.js";

export interface InitiateStellarInternalTransferInput {
  recipientMemoId: string;
  amount: string;
  pin: string;
  // Omitted means USDC — the only token that existed before USDT0
  // support, same convention as every other send/withdrawal flow.
  tokenSymbol?: string;
}

// CowryPay-to-CowryPay transfer on Stellar, identified by the recipient's
// memo rather than an address — Stellar's shared-omnibus model means
// every user's own "address" is the same one shared address, so there's
// no such thing as "the recipient's own wallet address" to send to
// externally the way a normal crypto withdrawal works. Real incident this
// closes: a user withdrew straight to our own shared Stellar deposit
// address with no memo at all, intending to send to another CowryPay
// user — the payment landed back in our own treasury, correctly
// unattributable (see unmatched_stellar_deposits), and needed a manual
// admin resolve. This is the real feature that should have existed
// instead: a pure ledger movement (debit sender, credit recipient), never
// touching Stellar at all — no fee, no confirmation wait, no possibility
// of landing unattributed, and cheaper than a same-chain crypto
// withdrawal would ever need to be since nothing broadcasts anywhere.
export async function initiateStellarInternalTransfer(
  fromUserId: string,
  input: InitiateStellarInternalTransferInput,
): Promise<InternalTransfer> {
  const user = await usersRepo.findById(fromUserId);
  if (!user) throw new Error("User not found");

  const authResult = canInitiateSend(user);
  if (!authResult.allowed) {
    throw new Error(`transfer not allowed: ${authResult.reason}`);
  }

  // Checked before touching the database, same §9 rule every other
  // fund-moving flow in this codebase follows.
  const pinValid = await verifyTransactionPin(fromUserId, input.pin);
  if (!pinValid) {
    throw new Error("Incorrect PIN");
  }

  const tokenSymbol = (input.tokenSymbol ?? env.defaultTokenSymbol).toUpperCase();
  if (!stellarSupportedTokens().includes(tokenSymbol)) {
    throw new Error(`Stellar doesn't support tokenSymbol=${tokenSymbol} yet (only ${stellarSupportedTokens().join(", ")})`);
  }

  if (!/^\d+$/.test(input.recipientMemoId)) {
    throw new Error(`"${input.recipientMemoId}" isn't a valid memo — it should be a plain number.`);
  }
  const recipient = await stellarMemoRepo.findByMemoId(BigInt(input.recipientMemoId));
  if (!recipient) {
    throw new Error(`No CowryPay user found with memo ${input.recipientMemoId} — double-check it and try again.`);
  }
  if (recipient.userId === fromUserId) {
    throw new Error("You can't transfer to your own memo.");
  }

  const reference = randomUUID();

  return withTransaction(async (client) => {
    // Atomic decrement-with-guard — same double-spend protection every
    // other fund-moving flow in this codebase uses.
    const debited = await ledgerRepo.debitAvailable(client, fromUserId, tokenSymbol, "stellar", input.amount);
    if (!debited) {
      throw new Error("Insufficient balance");
    }
    await ledgerRepo.creditAvailable(client, recipient.userId, tokenSymbol, "stellar", input.amount);

    return internalTransfersRepo.create(client, {
      fromUserId,
      toUserId: recipient.userId,
      chain: "stellar",
      tokenSymbol,
      amountHuman: input.amount,
      recipientIdentifier: input.recipientMemoId,
      reference,
    });
  });
}
