import { Router, type Request, type Response } from "express";
import { env } from "../config/env.js";
import { verifyAlchemyWebhookSignature, normalizeAlchemyPayload } from "../domain/deposits/alchemyWebhook.js";
import { walletsRepo } from "../domain/wallets/repository.js";
import { ingestDeposit } from "../domain/deposits/stateMachine.js";

export const alchemyWebhookRouter = Router();

// One URL per chain (not one shared endpoint) — deliberately, not
// mirroring routes/solanaWebhook.ts's single-URL shape. An aws-kms EVM
// wallet is ONE row stored under env.defaultChain regardless of which
// chain a deposit actually lands on (one KMS key, every EVM chain — see
// wallets/chains.ts), so there's no wallet.chain to trust, and
// insertIfNew's dedup is keyed on (chain, tx_hash) — trusting a `network`
// field inside the payload body instead of the URL that delivered it
// would let a wrong chain tag silently defeat dedup against
// depositScanner.ts's own correctly-tagged row for the same deposit.
// :chain is checked against env.alchemyWebhookSigningKeys BEFORE the body
// is even parsed, so an unconfigured/unknown chain fails signature
// verification closed rather than falling through to a guess.
//
// Mounted unconditionally (not gated behind EVM_WEBHOOK_DEPOSITS_ENABLED
// at the route-registration level), same reasoning as
// routes/solanaWebhook.ts's own comment: this URL is externally reachable
// the moment it's deployed, regardless of go-live intent, so verify
// signature FIRST, then check the flag.
//
// This is purely a SPEED LAYER — depositScanner.ts's 30s poll (and its own
// reconciler) keep running completely unchanged and will independently
// re-detect and ingest the same deposit via the exact same idempotent
// (chain, tx_hash) path if this webhook never fires at all.
alchemyWebhookRouter.post("/webhooks/alchemy/:chain", async (req: Request, res: Response) => {
  const chain = req.params.chain;
  if (!verifyAlchemyWebhookSignature(chain, req.rawBody, req.header("x-alchemy-signature"))) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }
  if (!env.evmWebhookDepositsEnabled) {
    res.status(200).json({ ok: true, ignored: "evm webhook deposits not enabled" });
    return;
  }

  const transfers = normalizeAlchemyPayload(chain, req.body);

  for (const transfer of transfers) {
    try {
      const wallet = await walletsRepo.findByAddress(transfer.toAddress);
      if (!wallet) {
        // Shouldn't happen — every address we generate is stored
        // immediately — but ack anyway so Alchemy doesn't retry something
        // we can't act on. Same stance routes/solanaWebhook.ts already
        // takes for its own "no wallet registered" case.
        console.error(`[alchemy webhook] no wallet registered for ${transfer.toAddress} (${chain}, tx ${transfer.txHash})`);
        continue;
      }

      await ingestDeposit({
        userId: wallet.userId,
        walletId: wallet.id,
        tokenSymbol: transfer.tokenSymbol,
        amount: transfer.amount,
        chain, // from the URL, never from the payload — see the comment above
        txHash: transfer.txHash,
      });
    } catch (err) {
      console.error(`[alchemy webhook] failed to process transfer on ${chain} (tx ${transfer.txHash}):`, err);
    }
  }

  res.status(200).json({ ok: true });
});
