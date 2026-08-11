import { randomUUID } from "node:crypto";
import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import type { Send, SendRecipient } from "../../types.js";
import { usersRepo } from "../users/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { getWalletAdapter } from "../wallets/index.js";
import { PayoutLiquidityError } from "../wallets/adapter.js";
import { ledgerRepo } from "../ledger/repository.js";
import { canInitiateSend } from "../sendAuthorization.js";
import { verifyTransactionPin } from "../pin/service.js";
import { createOfframpOrder, type CreatedOrder } from "./paycrestAdapter.js";
import { createOfframpOrder as createQuidaxOrder } from "./quidaxAdapter.js";
import { createOfframpOrder as createCentiivOrder } from "./centiivAdapter.js";
import { computeFeeSplit, requireTreasuryAddress } from "./fee.js";
import { sendsRepo } from "./repository.js";
import type { OfframpProvider } from "./providerSelection.js";

// Carried over from a chat draft (domain/chat/remittanceDraft.ts), which
// already locked a real rate/receive address (against the net amount, after
// fee) by creating this order up front — reused here instead of creating a
// second, redundant order.
export interface LockedOrder extends CreatedOrder {
  reference: string;
  feeAmount: string;
  treasuryAddress: string;
  // Which provider actually created this locked order — required now that
  // remittanceDraft.ts can lock either provider, not assumed to be Paycrest
  // the way it safely could be before (see the reuse fix below).
  provider: OfframpProvider;
}

export interface InitiateSendInput {
  amount: string;
  fiatCurrency: string;
  recipient: SendRecipient;
  pin: string;
  rate?: string;
  existingOrder?: LockedOrder;
  // Which chain to pay this send out from — defaults to wallet.chain when
  // omitted, so any caller that doesn't pass it (old frontend, direct API
  // use) behaves exactly as before per-chain balances existed. Only
  // meaningful once a wallet can hold balance on more than one chain (see
  // the Phase 7 migration plan) — until then this is always "celo".
  chain?: string;
  // Which off-ramp provider to actually use — required to be explicit
  // (not auto-re-decided here) because `recipient.institution` is a
  // provider-specific bank code (Paycrest's own codes vs Quidax's CBN
  // codes are different namespaces) that the caller must already have
  // resolved via the matching provider's institution list. Omitted means
  // Paycrest — the only provider that existed before this, so every
  // caller that hasn't been updated to pass this keeps working exactly as
  // before. See providerSelection.ts for the rate-shopping step callers
  // are expected to run before this, to actually decide which provider
  // and institution list to use.
  provider?: OfframpProvider;
}

export interface InitiatedSend {
  send: Send;
  receiveAddress: string;
  validUntil: string;
  // Friendly confirmation text for the frontend to show right after
  // submission. Deliberately says "processing", not "completed" — at this
  // point the send has only broadcast, not settled (Paycrest's own
  // payment_order.* webhook is what actually confirms that, later) —
  // claiming otherwise here would repeat the exact kind of premature
  // "done" claim that caused the double-spend bug earlier in this project.
  message: string;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

  // Every EVM chain (celo/base/optimism) shares one wallet row, always
  // registered under env.defaultChain — one KMS/Blockradar address covers
  // all of them, so "which EVM chain to send from" (input.chain) and
  // "which wallet row to look up" are different questions there. Stellar
  // is the one genuine exception: its shared-address wallet is its own
  // row, keyed under "stellar" specifically.
  const walletChainKey = input.chain?.toLowerCase() === "stellar" ? "stellar" : env.defaultChain;
  const wallet = await walletsRepo.findByUserIdAndChain(userId, walletChainKey);
  if (!wallet) throw new Error("No wallet found for user");
  const chain = input.chain ?? wallet.chain;
  const walletAddress = wallet.address;

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
    const debited = await ledgerRepo.debitAvailable(client, userId, env.defaultTokenSymbol, chain, input.amount);
    if (!debited) {
      throw new Error("Insufficient balance");
    }

    const created = await sendsRepo.create(client, {
      userId,
      walletId: wallet.id,
      tokenSymbol: env.defaultTokenSymbol,
      chain,
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

  // A reused chat-locked order already carries the provider it was
  // actually created with (remittanceDraft.ts can lock either provider) —
  // a fresh order dispatches to whichever provider the caller explicitly
  // chose (see InitiateSendInput.provider's own comment on why this isn't
  // re-decided here).
  const provider: OfframpProvider = reusable?.provider ?? input.provider ?? "paycrest";
  async function createOrderForProvider(): Promise<CreatedOrder> {
    const recipient = {
      institution: input.recipient.institution,
      accountIdentifier: input.recipient.accountIdentifier,
      accountName: input.recipient.accountName,
    };
    if (provider === "quidax") {
      return createQuidaxOrder({ amount: netAmount, network: chain, fiatCurrency: input.fiatCurrency, recipient, reference });
    }
    if (provider === "centiiv") {
      return createCentiivOrder({ amount: netAmount, network: chain, fiatCurrency: input.fiatCurrency, recipient, reference });
    }
    return createOfframpOrder({
      amount: netAmount,
      token: env.defaultTokenSymbol,
      network: chain,
      refundAddress: walletAddress,
      fiatCurrency: input.fiatCurrency,
      recipient: input.recipient,
      reference,
      rate: input.rate,
    });
  }
  const order = reusable ?? (await createOrderForProvider());

  const updated = await withTransaction(async (client) => {
    const next = await sendsRepo.updateOrderCreated(client, send.id, {
      providerOrderId: order.orderId,
      rate: order.rate,
      provider,
    });
    await sendsRepo.logTransition(
      client,
      send.id,
      "SEND_INSTRUCTED",
      "ORDER_CREATED",
      reusable ? "reused_chat_locked_order" : `${provider}_order_created`,
    );
    return next;
  });

  let payout;
  try {
    payout = await getWalletAdapter(chain, wallet.provider).withdraw({
      chain,
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
      await ledgerRepo.creditAvailable(client, userId, env.defaultTokenSymbol, chain, input.amount);
      await sendsRepo.updateState(client, updated.id, { state: "FAILED" });
      await sendsRepo.logTransition(
        client,
        updated.id,
        "ORDER_CREATED",
        "FAILED",
        `blockradar_withdraw_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    // PayoutLiquidityError's message is already clean and accurate (our
    // payout wallet's liquidity, never the user's balance) — surfaced
    // as-is rather than wrapped in the generic "could not broadcast (raw
    // chain error)" text below, which is only fit for logs, not users.
    if (err instanceof PayoutLiquidityError) {
      throw err;
    }
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
      const feeSweep = await getWalletAdapter(chain, wallet.provider).withdraw({
        chain,
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

  const fiatAmount = Number(netAmount) * Number(order.rate);
  const fiatEstimate = Number.isFinite(fiatAmount) ? fiatAmount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : null;
  const recipientLabel = input.recipient.institutionName ?? input.recipient.institution;
  const message = [
    `⏳ Your transaction with the following details is processing:`,
    `💸 Sent ${input.amount} ${env.defaultTokenSymbol} on ${capitalize(chain)} — ${input.recipient.accountName} at ${recipientLabel}` +
      (fiatEstimate ? ` will receive ${input.fiatCurrency} ${fiatEstimate}` : ""),
    ``,
    `This usually completes within a few minutes — we'll update you once it's confirmed.`,
  ].join("\n");

  return { send: final, receiveAddress: order.receiveAddress, validUntil: order.validUntil, message };
}
