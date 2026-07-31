import { Router, type Request, type Response } from "express";
import { verifyBlockradarSignature } from "../domain/deposits/blockradarWebhook.js";
import { ingestDeposit } from "../domain/deposits/stateMachine.js";
import { walletsRepo } from "../domain/wallets/repository.js";
import { sendsRepo } from "../domain/offramp/repository.js";
import { withTransaction } from "../db/pool.js";
import type { Send } from "../types.js";

export const blockradarWebhookRouter = Router();

// A master-wallet withdraw (domain/wallets/blockradarAdapter.ts) can go
// through AML/compliance screening before broadcasting — the initial API
// response returns no hash while that's pending, so this is the only way to
// learn the real hash (or that it failed) for a send that hasn't got one
// yet. Matched by `reference`, not hash, since we don't have a hash to
// match on until this fires. initiateSend appends "-payout"/"-fee" to the
// send's own `reference` when it calls the withdraw API — strip that back
// off to look the send up.
async function findSendForWithdrawEvent(data: any): Promise<{ send: Send; leg: "payout" | "fee" } | null> {
  const reference = data?.reference as string | undefined;
  if (reference?.endsWith("-payout")) {
    const send = await sendsRepo.findByReference(reference.slice(0, -"-payout".length));
    if (send) return { send, leg: "payout" };
  }
  if (reference?.endsWith("-fee")) {
    const send = await sendsRepo.findByReference(reference.slice(0, -"-fee".length));
    if (send) return { send, leg: "fee" };
  }
  const hash = data?.hash as string | undefined;
  const send = hash ? await sendsRepo.findByWithdrawTxHash(hash) : null;
  return send ? { send, leg: "payout" } : null;
}

// One URL receives every Blockradar event type (configured once on the
// master wallet, per their docs) — branch on `event`, ignore anything that
// isn't handled below (swap/offramp/gateway events, non-success deposit
// states) rather than erroring on them.
blockradarWebhookRouter.post("/webhooks/blockradar", async (req: Request, res: Response) => {
  const signature = req.header("x-blockradar-signature");
  if (!verifyBlockradarSignature(req.rawBody, signature)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  const event = req.body?.event;
  const data = req.body?.data ?? {};

  if (event === "withdraw.success") {
    const hash = data.hash as string | undefined;
    const match = await findSendForWithdrawEvent(data);
    if (match && hash) {
      const { send, leg } = match;
      if (leg === "payout") {
        // State stays PAYOUT_INITIATED (or wherever it already is) — this
        // just backfills the hash that wasn't available at broadcast time.
        // SETTLING/COMPLETE still only ever come from Paycrest's own
        // payment_order.* webhook.
        await withTransaction(async (client) => {
          await sendsRepo.updateState(client, send.id, { state: send.state, withdrawTxHash: hash });
          await sendsRepo.logTransition(
            client,
            send.id,
            send.state,
            send.state,
            `blockradar_withdraw_success_webhook:${hash}`,
          );
        });
      } else {
        await withTransaction((client) =>
          sendsRepo.logTransition(client, send.id, send.state, send.state, `fee_swept:${hash}`),
        );
      }
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (event === "withdraw.failed") {
    const match = await findSendForWithdrawEvent(data);
    if (match?.leg === "payout") {
      const { send } = match;
      if (send.state !== "FAILED" && send.state !== "COMPLETE") {
        await withTransaction(async (client) => {
          await sendsRepo.updateState(client, send.id, { state: "FAILED" });
          await sendsRepo.logTransition(client, send.id, send.state, "FAILED", "blockradar_withdraw_failed_webhook");
        });
      }
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (event !== "deposit.success") {
    res.status(200).json({ ok: true, ignored: event });
    return;
  }

  // Auto-sweep (enabled on this master wallet) changes what
  // `recipientAddress` means — once a deposit sweeps, that field points at
  // the master wallet, not the user's own address, and this event fires for
  // the (already-swept) final state rather than the original arrival.
  // `data.address.address` is the deposit's actual receiving address
  // regardless of auto-sweep — confirmed against a real payload where
  // `isAutoSweep: true`, `recipientAddress` was the master wallet, and
  // `data.address.address` was still the correct per-user child address.
  const address = (data.address?.address ?? data.recipientAddress) as string | undefined;
  const txHash = data.hash as string | undefined;
  const amount = data.amount;
  const tokenSymbol = data.asset?.symbol as string | undefined;

  if (!address || !txHash || amount == null || !tokenSymbol) {
    res.status(400).json({ error: "missing required deposit fields" });
    return;
  }

  const wallet = await walletsRepo.findByAddress(address);
  if (!wallet) {
    // Shouldn't happen — every address we generate is stored immediately —
    // but ack anyway so Blockradar doesn't retry something we can't act on.
    res.status(200).json({ ok: true, ignored: "no wallet registered for this address" });
    return;
  }

  try {
    const result = await ingestDeposit({
      userId: wallet.userId,
      walletId: wallet.id,
      tokenSymbol,
      amount: String(amount),
      chain: wallet.chain,
      txHash,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
