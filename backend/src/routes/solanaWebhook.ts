import { Router, type Request, type Response } from "express";
import { address as toAddress } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { env } from "../config/env.js";
import { verifySolanaWebhookAuth, normalizeHeliusPayload } from "../domain/deposits/solanaWebhook.js";
import { walletsRepo } from "../domain/wallets/repository.js";
import { ingestDeposit } from "../domain/deposits/stateMachine.js";

export const solanaWebhookRouter = Router();

// One URL for every Enhanced webhook delivery from the deposit-indexer
// (Helius or equivalent) — mirrors routes/blockradarWebhook.ts's pattern.
// Mounted unconditionally (not gated behind SOLANA_DEPOSITS_ENABLED at the
// route-registration level) since the auth check plus the in-handler flag
// check together make it safe to always be present but inert — same
// reasoning stellarDepositScanner.ts's own flag uses, just enforced here
// because this route, unlike a poller, is externally reachable the moment
// it's deployed regardless of go-live intent.
solanaWebhookRouter.post("/webhooks/solana", async (req: Request, res: Response) => {
  if (!verifySolanaWebhookAuth(req)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }
  if (!env.solanaDepositsEnabled) {
    res.status(200).json({ ok: true, ignored: "solana deposits not enabled" });
    return;
  }

  // Both mints watched, not just USDC — which one a given transfer's
  // `mint` field matches determines the tokenSymbol stamped on the
  // deposit below, rather than that being hardcoded regardless of which
  // token actually moved.
  const MINT_TO_SYMBOL: Record<string, string> = {
    ...(env.solanaUsdcMint ? { [env.solanaUsdcMint]: "USDC" } : {}),
    ...(env.solanaUsdtMint ? { [env.solanaUsdtMint]: "USDT" } : {}),
  };
  const transfers = normalizeHeliusPayload(req.body).filter((t) => t.mint in MINT_TO_SYMBOL);

  for (const transfer of transfers) {
    try {
      const tokenSymbol = MINT_TO_SYMBOL[transfer.mint]!;
      // Solana's own official exchange-integration guide recommends
      // accepting deposits only from the correctly-derived Associated
      // Token Account for (owner, mint) — this is Solana's real analogue
      // of Stellar's "wrong memo" safety check: there's no memo ambiguity
      // here since every address is genuinely unique, but a token account
      // that doesn't match the expected derivation is not something to
      // trust blindly either.
      const owner = toAddress(transfer.ownerAddress);
      const [expectedAta] = await findAssociatedTokenPda({
        owner,
        mint: toAddress(transfer.mint),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      if (expectedAta !== transfer.ataAddress) {
        console.error(
          `[solana webhook] token account mismatch for owner ${transfer.ownerAddress}: expected ${expectedAta}, got ${transfer.ataAddress} (tx ${transfer.signature})`,
        );
        continue;
      }

      const wallet = await walletsRepo.findByChainAndAddress("solana", transfer.ownerAddress);
      if (!wallet) {
        // Shouldn't happen — every address we generate is stored
        // immediately — but ack anyway so the indexer doesn't retry
        // something we can't act on. Logged loudly, same stance
        // blockradarWebhook.ts already takes for its own "no wallet
        // registered" case.
        console.error(`[solana webhook] no wallet registered for owner ${transfer.ownerAddress} (tx ${transfer.signature})`);
        continue;
      }

      await ingestDeposit({
        userId: wallet.userId,
        walletId: wallet.id,
        tokenSymbol,
        amount: transfer.amount,
        chain: "solana",
        txHash: transfer.signature,
      });
    } catch (err) {
      console.error(`[solana webhook] failed to process transfer (tx ${transfer.signature}):`, err);
    }
  }

  res.status(200).json({ ok: true });
});
