import { Router, type Request, type Response } from "express";
import { ensureSolanaWallet } from "../domain/users/service.js";
import { ensureSolanaUsdtAta } from "../domain/wallets/solanaAdapter.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const solanaWalletRouter = Router();

// Every user actually gets their Solana address at signup now (see
// ensureAccount in users/service.ts) — this stays idempotent/on-demand as
// the retry path for the rare case someone asks before that background
// call has finished, or if it failed.
//
// USDC's ATA is funded eagerly at wallet-creation time, but USDT's isn't
// (solanaAdapter.ts) — most users never touch it, so it's only funded here,
// on demand, when the caller explicitly asks with ?token=USDT. Skipping
// that call before telling a caller their address accepts USDT would let a
// USDT deposit silently fail for senders whose own wallet doesn't
// auto-create the destination ATA.
solanaWalletRouter.get("/wallets/solana", requireAuth, async (req: Request, res: Response) => {
  try {
    const wallet = await ensureSolanaWallet(req.authUser!.id);
    const wantsUsdt = req.query.token?.toString().toUpperCase() === "USDT";
    if (wantsUsdt) await ensureSolanaUsdtAta(wallet.address);
    res.json({ address: wallet.address, usdtReady: wantsUsdt });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
