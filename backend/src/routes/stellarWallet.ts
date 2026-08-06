import { Router, type Request, type Response } from "express";
import { ensureStellarWallet } from "../domain/users/service.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const stellarWalletRouter = Router();

// Opt-in — allocates this user's memo on first call (see
// ensureStellarWallet), idempotent on every call after. Nothing in the
// default signup/balance/chat flows calls this; a user only gets a Stellar
// deposit address by explicitly asking for one via this endpoint.
stellarWalletRouter.get("/wallets/stellar", requireAuth, async (req: Request, res: Response) => {
  try {
    const wallet = await ensureStellarWallet(req.authUser!.id);
    res.json({ address: wallet.address, memo: wallet.externalWalletId });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
