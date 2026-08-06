import { Router, type Request, type Response } from "express";
import { env } from "../config/env.js";
import { ledgerRepo } from "../domain/ledger/repository.js";
import { usersRepo } from "../domain/users/repository.js";
import { toPublicUser } from "../domain/users/publicUser.js";
import { walletsRepo } from "../domain/wallets/repository.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const usersRouter = Router();

// Self-lookup only — identity comes from the verified token, never from a
// path param, so there's no way to enumerate or read another user's balance.
usersRouter.get("/me", requireAuth, async (req: Request, res: Response) => {
  const userId = req.authUser!.id;
  const user = await usersRepo.findById(userId);
  if (!user) {
    res.status(404).json({ error: "no profile yet — call POST /signup first" });
    return;
  }
  const [wallet, balances] = await Promise.all([
    walletsRepo.findByUserIdAndChain(user.id, env.defaultChain),
    ledgerRepo.getBalancesForUser(user.id),
  ]);
  res.json({ user: toPublicUser(user), wallet, balances });
});
