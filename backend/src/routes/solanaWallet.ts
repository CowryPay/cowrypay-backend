import { Router, type Request, type Response } from "express";
import { ensureSolanaWallet } from "../domain/users/service.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const solanaWalletRouter = Router();

// Opt-in — creates a brand-new, pre-funded Solana address on first call
// (see ensureSolanaWallet), idempotent on every call after. Nothing in the
// default signup/balance/chat flows calls this; a user only gets a Solana
// deposit address by explicitly asking for one via this endpoint.
solanaWalletRouter.get("/wallets/solana", requireAuth, async (req: Request, res: Response) => {
  try {
    const wallet = await ensureSolanaWallet(req.authUser!.id);
    res.json({ address: wallet.address });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
