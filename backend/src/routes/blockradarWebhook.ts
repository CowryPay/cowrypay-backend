import { Router, type Request, type Response } from "express";
import { verifyBlockradarSignature } from "../domain/deposits/blockradarWebhook.js";
import { ingestDeposit } from "../domain/deposits/stateMachine.js";
import { walletsRepo } from "../domain/wallets/repository.js";

export const blockradarWebhookRouter = Router();

// One URL receives every Blockradar event type (configured once on the
// master wallet, per their docs) — branch on `event`, ignore anything that
// isn't a deposit credit for now (withdraw/swap/offramp/gateway events,
// plus non-success deposit states) rather than erroring on them.
blockradarWebhookRouter.post("/webhooks/blockradar", async (req: Request, res: Response) => {
  const signature = req.header("x-blockradar-signature");
  if (!verifyBlockradarSignature(req.rawBody, signature)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  const event = req.body?.event;
  if (event !== "deposit.success") {
    res.status(200).json({ ok: true, ignored: event });
    return;
  }

  const data = req.body?.data ?? {};
  const address = data.recipientAddress as string | undefined;
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
