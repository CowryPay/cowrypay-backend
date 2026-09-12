import { Router, type Request, type Response } from "express";
import { env } from "../config/env.js";
import { ledgerRepo } from "../domain/ledger/repository.js";
import { usersRepo } from "../domain/users/repository.js";
import { toPublicUser } from "../domain/users/publicUser.js";
import { walletsRepo } from "../domain/wallets/repository.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { clearSession } from "../domain/chat/sessionRepository.js";

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

// Real gap (2026-09-12): this backend has NO visibility into "the user
// logged out" at all — auth is entirely Supabase's own client-side
// signOut(), which never touches this backend, so a pending chat draft
// (an in-progress withdrawal/remittance/etc., chat_sessions) survives a
// logout exactly as if nothing happened, still active for up to
// CHAT_SESSION_IDLE_MINUTES if the same user logs back in. Not a
// cross-user leak — chat_sessions is keyed by user_id, not device, so a
// DIFFERENT user logging in on the same device never sees this at all —
// but the SAME user's own stale context surviving their own logout is a
// real, requested UX gap. This endpoint exists so the frontend can close
// it: call this at logout time (alongside Supabase's own signOut()) and
// the next login starts with a genuinely clean slate rather than
// whatever was mid-flow before. No-ops harmlessly if nothing was pending.
usersRouter.post("/logout", requireAuth, async (req: Request, res: Response) => {
  await clearSession(req.authUser!.id);
  res.json({ ok: true });
});
