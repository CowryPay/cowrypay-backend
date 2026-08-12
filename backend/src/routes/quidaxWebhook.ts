import { Router, type Request, type Response } from "express";
import { resolveNextSendState, verifyQuidaxSignature } from "../domain/offramp/quidaxWebhook.js";
import { sendsRepo } from "../domain/offramp/repository.js";
import { applyTerminalFailureTransition } from "../domain/offramp/sendStateTransition.js";
import { withTransaction } from "../db/pool.js";

export const quidaxWebhookRouter = Router();

// One URL for every sell_transaction.* event (configured on the Quidax
// Ramp merchant dashboard) — mirrors routes/paycrestWebhook.ts's pattern.
// Matched by data.merchant_reference against sends.provider_order_id,
// which quidaxAdapter.createOfframpOrder sets to our own reference (not
// Quidax's public_id/reference — see that file's comment on why).
quidaxWebhookRouter.post("/webhooks/quidax", async (req: Request, res: Response) => {
  const signature = req.header("x-ramp-signature");

  if (!verifyQuidaxSignature(req.rawBody, signature)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  const event = req.body?.event as string | undefined;
  const merchantReference = req.body?.data?.merchant_reference as string | undefined;
  if (!event || !merchantReference) {
    res.status(400).json({ error: "missing event or data.merchant_reference" });
    return;
  }

  const send = await sendsRepo.findByProviderOrderId(merchantReference);
  if (!send) {
    // Ack anyway so Quidax doesn't keep retrying an order we have no
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
      await applyTerminalFailureTransition(client, send, nextState, event, "quidax_webhook");
    } else {
      await sendsRepo.updateState(client, send.id, { state: nextState });
      await sendsRepo.logTransition(client, send.id, send.state, nextState, event, "quidax_webhook");
    }
  });

  res.json({ ok: true });
});
