import type { NextFunction, Request, Response } from "express";
import { verifySupabaseToken, type AuthenticatedUser } from "../auth/verifyToken.js";
import { usersRepo } from "../domain/users/repository.js";
import { ensureAccount } from "../domain/users/service.js";

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
    }
  }
}

// The client's own signup flow is two steps it doesn't fully control
// together: verify email-OTP directly against Supabase Auth (creating
// auth.users), then separately call POST /signup with the resulting
// token (creating OUR users row + wallet, via ensureAccount). Nothing
// guarantees the second call ever lands — a dropped network request or a
// closed app between the two steps leaves a real, valid Supabase identity
// with no account here at all. Confirmed live (2026-08-26): 5 of 56
// Supabase Auth users had no matching row in our own users table, each
// permanently unable to use the app despite a working login.
//
// Self-heals here rather than only at POST /signup: ensureAccount is
// already idempotent and cheap for the normal case (one indexed lookup),
// so paying that cost on every authenticated request — not just the
// explicit signup call — means ANY route the client happens to hit first
// after auth finishes provisioning the account, regardless of which
// specific request got lost.
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }
  try {
    req.authUser = await verifySupabaseToken(token);
  } catch {
    res.status(401).json({ error: "invalid or expired token" });
    return;
  }
  // POST /signup is excluded deliberately — it needs ensureAccount's own
  // `created` flag to correctly tell the client apart a brand-new signup
  // (201) from a returning one (200). Self-healing here first would mean
  // that route never sees `created: true` again, even for a genuinely
  // first-time signup.
  if (req.path === "/signup") {
    next();
    return;
  }
  try {
    const existing = await usersRepo.findById(req.authUser.id);
    if (!existing) {
      console.log(`[require-auth] no users row for authenticated Supabase identity ${req.authUser.id} — self-healing via ensureAccount`);
      await ensureAccount(req.authUser);
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
