import { randomUUID } from "node:crypto";
import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import type { Send, SendRecipient } from "../../types.js";
import { usersRepo } from "../users/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { withdrawFromMasterWallet } from "../wallets/blockradarAdapter.js";
import { ledgerRepo } from "../ledger/repository.js";
import { canInitiateSend } from "../sendAuthorization.js";
import { verifyTransactionPin } from "../pin/service.js";
import { createOfframpOrder, type CreatedOrder } from "./paycrestAdapter.js";
import { computeFeeSplit, requireTreasuryAddress } from "./fee.js";
import { sendsRepo } from "./repository.js";

// Carried over from a chat draft (domain/chat/remittanceDraft.ts), which
// already locked a real rate/receive address (against the net amount, after
// fee) by creating this order up front — reused here instead of creating a
// second, redundant order.
export interface LockedOrder extends CreatedOrder {
  reference: string;
  feeAmount: string;
  treasuryAddress: string;
}

export interface InitiateSendInput {
  amount: string;
  fiatCurrency: string;
  recipient: SendRecipient;
  pin: string;
  rate?: string;
  existingOrder?: LockedOrder;
}

export interface InitiatedSend {
  send: Send;
  receiveAddress: string;
  validUntil: string;
}

// SEND_INSTRUCTED -> ORDER_CREATED -> PAYOUT_INITIATED. Compliance screening
// (mirroring domain/deposits/screening.ts) isn't wired yet, but the payout
// broadcast is: once Paycrest's order is created, the net amount is paid
// directly from Blockradar's master wallet (which every deposit lands in
// automatically via Blockradar's own auto-sweep — confirmed live, no code
// of ours involved) to the order's receiveAddress, and the platform fee is
// paid to treasury the same way — neither withdraws from the sending
// user's own Blockradar wallet. SETTLING/COMPLETE arrive later via the
// payment_order.* webhook once Paycrest confirms the deposit and completes
// the payout; PAYOUT_INITIATED itself may still be confirming on-chain —
// Blockradar's own withdraw.success/withdraw.failed webhook (see
// routes/blockradarWebhook.ts) is what would flip this to FAILED if a
// broadcast that looked accepted doesn't actually land.
export async function initiateSend(userId: string, input: InitiateSendInput): Promise<InitiatedSend> {
  const user = await usersRepo.findById(userId);
  if (!user) throw new Error("User not found");

  const authResult = canInitiateSend(user);
  if (!authResult.allowed) {
    throw new Error(`send not allowed: ${authResult.reason}`);
  }

  // Gates the actual fund movement below — checked before touching the
  // database or Paycrest, per the architecture rule that nothing moving real
  // funds can rely solely on an already-unlocked session (§9).
  const pinValid = await verifyTransactionPin(userId, input.pin);
  if (!pinValid) {
    throw new Error("Incorrect PIN");
  }

  const wallet = await walletsRepo.findByUserId(userId);
  if (!wallet) throw new Error("No wallet found for user");

  // Reuse the chat-locked order only if it hasn't expired by the time the
  // user actually confirms — Paycrest quotes are only valid for ~1hr.
  const reusable =
    input.existingOrder && new Date(input.existingOrder.validUntil).getTime() > Date.now()
      ? input.existingOrder
      : null;

  const reference = reusable?.reference ?? randomUUID();
  // Recomputed fresh even when reusing a chat-locked order — computeFeeSplit
  // is a pure function of amount + the fee bps, so this reproduces the exact
  // net amount Paycrest's order was created with (LockedOrder doesn't carry
  // it directly) as long as the fee bps hasn't changed mid-quote-window.
  const { feeAmount, netAmount } = computeFeeSplit(input.amount);
  const treasuryAddress = reusable?.treasuryAddress ?? requireTreasuryAddress();

  const send = await withTransaction(async (client) => {
    // Atomic decrement-with-guard (see ledgerRepo.debitAvailable) — two
    // concurrent sends can't both pass a balance check and double-spend the
    // same funds; whichever commits first wins, the other sees the reduced
    // balance and fails here.
    const debited = await ledgerRepo.debitAvailable(client, userId, env.defaultTokenSymbol, input.amount);
    if (!debited) {
      throw new Error("Insufficient balance");
    }

    const created = await sendsRepo.create(client, {
      userId,
      walletId: wallet.id,
      tokenSymbol: env.defaultTokenSymbol,
      chain: wallet.chain,
      amountHuman: input.amount,
      fiatCurrency: input.fiatCurrency,
      recipient: input.recipient,
      reference,
      feeAmount,
      treasuryAddress,
    });
    await sendsRepo.logTransition(client, created.id, null, "SEND_INSTRUCTED", "send_requested");
    return created;
  });

  const order =
    reusable ??
    (await createOfframpOrder({
      amount: netAmount,
      token: env.defaultTokenSymbol,
      network: wallet.chain,
      refundAddress: wallet.address,
      fiatCurrency: input.fiatCurrency,
      recipient: input.recipient,
      reference,
      rate: input.rate,
    }));

  const updated = await withTransaction(async (client) => {
    const next = await sendsRepo.updateOrderCreated(client, send.id, {
      providerOrderId: order.orderId,
      rate: order.rate,
    });
    await sendsRepo.logTransition(
      client,
      send.id,
      "SEND_INSTRUCTED",
      "ORDER_CREATED",
      reusable ? "reused_chat_locked_order" : "paycrest_order_created",
    );
    return next;
  });

  let payout;
  try {
    payout = await withdrawFromMasterWallet({
      chain: wallet.chain,
      tokenSymbol: env.defaultTokenSymbol,
      toAddress: order.receiveAddress,
      amount: netAmount,
      reference: `${reference}-payout`,
    });
  } catch (err) {
    await withTransaction(async (client) => {
      // Refund — the balance was debited up front to prevent double-spending
      // across concurrent sends, but the payout never actually left custody,
      // so the user's balance shouldn't reflect otherwise.
      await ledgerRepo.creditAvailable(client, userId, env.defaultTokenSymbol, input.amount);
      await sendsRepo.updateState(client, updated.id, { state: "FAILED" });
      await sendsRepo.logTransition(
        client,
        updated.id,
        "ORDER_CREATED",
        "FAILED",
        `blockradar_withdraw_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    throw new Error(
      `Could not broadcast the payout (${err instanceof Error ? err.message : String(err)}) — the send was marked failed.`,
    );
  }

  const final = await withTransaction(async (client) => {
    const next = await sendsRepo.updateState(client, updated.id, {
      state: "PAYOUT_INITIATED",
      withdrawTxHash: payout.txHash,
    });
    await sendsRepo.logTransition(
      client,
      updated.id,
      "ORDER_CREATED",
      "PAYOUT_INITIATED",
      payout.txHash
        ? "blockradar_withdraw_broadcast"
        : "blockradar_withdraw_broadcast_pending_screening",
    );
    return next;
  });

  // Best-effort — the user's payout already succeeded above, so a failure
  // here only means the platform fee didn't reach treasury this time, not
  // that the send itself failed. Logged for later manual reconciliation
  // rather than thrown.
  if (Number(feeAmount) > 0) {
    try {
      const feeSweep = await withdrawFromMasterWallet({
        chain: wallet.chain,
        tokenSymbol: env.defaultTokenSymbol,
        toAddress: treasuryAddress,
        amount: feeAmount,
        reference: `${reference}-fee`,
      });
      await withTransaction((client) =>
        sendsRepo.logTransition(
          client,
          final.id,
          "PAYOUT_INITIATED",
          "PAYOUT_INITIATED",
          feeSweep.txHash ? `fee_swept:${feeSweep.txHash}` : "fee_swept_pending_screening",
        ),
      );
    } catch (err) {
      console.error(`Fee sweep failed for send ${final.id}:`, err);
      await withTransaction((client) =>
        sendsRepo.logTransition(
          client,
          final.id,
          "PAYOUT_INITIATED",
          "PAYOUT_INITIATED",
          `fee_sweep_failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  return { send: final, receiveAddress: order.receiveAddress, validUntil: order.validUntil };
}
