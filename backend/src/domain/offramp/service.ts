import { randomUUID } from "node:crypto";
import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import type { Send, SendRecipient } from "../../types.js";
import { usersRepo } from "../users/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { canInitiateSend } from "../sendAuthorization.js";
import { createOfframpOrder } from "./paycrestAdapter.js";
import { sendsRepo } from "./repository.js";

export interface InitiateSendInput {
  amount: string;
  fiatCurrency: string;
  recipient: SendRecipient;
  rate?: string;
}

export interface InitiatedSend {
  send: Send;
  receiveAddress: string;
  validUntil: string;
}

// MVP path only: SEND_INSTRUCTED -> ORDER_CREATED. Compliance screening
// (mirroring domain/deposits/screening.ts) and the Blockradar withdraw
// broadcast that would move a send on to PAYOUT_INITIATED/SETTLING/COMPLETE
// via the payment_order.* webhook aren't wired yet — this only proves the
// Paycrest order-creation leg works end to end.
export async function initiateSend(userId: string, input: InitiateSendInput): Promise<InitiatedSend> {
  const user = await usersRepo.findById(userId);
  if (!user) throw new Error("User not found");

  const authResult = canInitiateSend(user);
  if (!authResult.allowed) {
    throw new Error(`send not allowed: ${authResult.reason}`);
  }

  const wallet = await walletsRepo.findByUserId(userId);
  if (!wallet) throw new Error("No wallet found for user");

  const reference = randomUUID();

  const send = await withTransaction(async (client) => {
    const created = await sendsRepo.create(client, {
      userId,
      walletId: wallet.id,
      tokenSymbol: env.defaultTokenSymbol,
      chain: wallet.chain,
      amountHuman: input.amount,
      fiatCurrency: input.fiatCurrency,
      recipient: input.recipient,
      reference,
    });
    await sendsRepo.logTransition(client, created.id, null, "SEND_INSTRUCTED", "send_requested");
    return created;
  });

  const order = await createOfframpOrder({
    amount: input.amount,
    token: env.defaultTokenSymbol,
    network: wallet.chain,
    refundAddress: wallet.address,
    fiatCurrency: input.fiatCurrency,
    recipient: input.recipient,
    reference,
    rate: input.rate,
  });

  const updated = await withTransaction(async (client) => {
    const next = await sendsRepo.updateOrderCreated(client, send.id, {
      providerOrderId: order.orderId,
      rate: order.rate,
    });
    await sendsRepo.logTransition(client, send.id, "SEND_INSTRUCTED", "ORDER_CREATED", "paycrest_order_created");
    return next;
  });

  return { send: updated, receiveAddress: order.receiveAddress, validUntil: order.validUntil };
}
