import { Router, type Request, type Response } from "express";
import { resolveNextSendState, verifyPaycrestSignature } from "../domain/offramp/paycrestWebhook.js";
import { sendsRepo } from "../domain/offramp/repository.js";
import { withTransaction } from "../db/pool.js";

export const paycrestWebhookRouter = Router();

// One URL for every payment_order.* event (configured on Paycrest's
// dashboard) — mirrors routes/blockradarWebhook.ts's pattern. Orders are
// matched by `data.id` against sends.provider_order_id, not `reference`
// (Paycrest's own reference field isn't guaranteed to round-trip on every
// event per their docs).
paycrestWebhookRouter.post("/webhooks/paycrest", async (req: Request, res: Response) => {
  const signature = req.header("x-paycrest-signature");

  // TEMPORARY diagnostic — remove once PAYCREST_API_SECRET is confirmed.
  // No distinct "webhook secret" has turned up anywhere on Paycrest's
  // dashboard despite their docs naming one separately from the API Key,
  // so this captures a real signature + exact raw body to test candidate
  // secrets against offline (starting with the API Key itself) instead of
  // guessing blind or waiting on support.
  console.log(`[paycrest webhook] signature=${signature}`);
  console.log(`[paycrest webhook] rawBody=${req.rawBody?.toString("utf8")}`);

  if (!verifyPaycrestSignature(req.rawBody, signature)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  const event = req.body?.event as string | undefined;
  const orderId = req.body?.data?.id as string | undefined;
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
    await sendsRepo.updateState(client, send.id, { state: nextState });
    await sendsRepo.logTransition(client, send.id, send.state, nextState, event, "paycrest_webhook");
  });

  res.json({ ok: true });
});
