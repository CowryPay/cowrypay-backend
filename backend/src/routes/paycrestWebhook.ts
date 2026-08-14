import { Router, type Request, type Response } from "express";
import { resolveNextSendState, verifyPaycrestSignature } from "../domain/offramp/paycrestWebhook.js";
import { sendsRepo } from "../domain/offramp/repository.js";
import { applyTerminalFailureTransition } from "../domain/offramp/sendStateTransition.js";
import { withTransaction } from "../db/pool.js";

export const paycrestWebhookRouter = Router();

// One URL for every payment_order.* event (configured on Paycrest's
// dashboard) — mirrors routes/blockradarWebhook.ts's pattern. Orders are
// matched by `data.id` against sends.provider_order_id, not `reference`
// (Paycrest's own reference field isn't guaranteed to round-trip on every
// event per their docs).
paycrestWebhookRouter.post("/webhooks/paycrest", async (req: Request, res: Response) => {
  const signature = req.header("x-paycrest-signature");

  if (!verifyPaycrestSignature(req.rawBody, signature)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  const event = req.body?.event as string | undefined;
  const orderId = req.body?.data?.id as string | undefined;
  // Mirrors the same field the REST order-status response carries (see
  // paycrestAdapter.ts's getOrderStatus) — only actually populated once
  // Paycrest moves crypto on-chain themselves, e.g. a refund.
  const refundTxHash = (req.body?.data?.txHash as string | undefined) || undefined;
  if (!event || !orderId) {
    res.status(400).json({ error: "missing event or data.id" });
    return;
  }

  const send = await sendsRepo.findByProviderOrderId(orderId);
  if (!send) {
    // Ack anyway so Paycrest doesn't keep retrying an order we have no
    // record of (e.g. a test event against a different environment).
    res.status(200).json({ ok: true, ignored: "no matching send" });
    return;
  }

  const nextState = resolveNextSendState(event, send.state);
  if (!nextState) {
    res.status(200).json({ ok: true, ignored: event });
    return;
  }

  await withTransaction(async (client) => {
    if (nextState === "FAILED" || nextState === "REFUNDED") {
      await applyTerminalFailureTransition(
        client,
        send,
        nextState,
        event,
        "paycrest_webhook",
        refundTxHash ? { txHash: refundTxHash } : undefined,
      );
    } else {
      await sendsRepo.updateState(client, send.id, { state: nextState });
      await sendsRepo.logTransition(client, send.id, send.state, nextState, event, "paycrest_webhook");
    }
  });

  res.json({ ok: true });
});
