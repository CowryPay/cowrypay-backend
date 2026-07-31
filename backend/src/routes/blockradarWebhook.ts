import { Router, type Request, type Response } from "express";
import { verifyBlockradarSignature } from "../domain/deposits/blockradarWebhook.js";
import { ingestDeposit } from "../domain/deposits/stateMachine.js";
import { walletsRepo } from "../domain/wallets/repository.js";
import { sendsRepo } from "../domain/offramp/repository.js";
import { withTransaction } from "../db/pool.js";

export const blockradarWebhookRouter = Router();

// One URL receives every Blockradar event type (configured once on the
// master wallet, per their docs) — branch on `event`, ignore anything that
// isn't handled below (swap/offramp/gateway events, non-success deposit
// states, withdraw.success — a synchronously-returned hash already marks a
// send PAYOUT_INITIATED, see domain/offramp/service.ts, so on-chain
// confirmation doesn't need to move it further) rather than erroring on them.
blockradarWebhookRouter.post("/webhooks/blockradar", async (req: Request, res: Response) => {
  const signature = req.header("x-blockradar-signature");
  if (!verifyBlockradarSignature(req.rawBody, signature)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  const event = req.body?.event;

  if (event === "withdraw.failed") {
    const hash = req.body?.data?.hash as string | undefined;
    const send = hash ? await sendsRepo.findByWithdrawTxHash(hash) : null;
    if (send && send.state !== "FAILED" && send.state !== "COMPLETE") {
      await withTransaction(async (client) => {
        await sendsRepo.updateState(client, send.id, { state: "FAILED" });
        await sendsRepo.logTransition(client, send.id, send.state, "FAILED", "blockradar_withdraw_failed_webhook");
      });
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (event !== "deposit.success") {
    res.status(200).json({ ok: true, ignored: event });
    return;
  }

  const data = req.body?.data ?? {};
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
