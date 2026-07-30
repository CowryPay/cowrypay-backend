import type { NextFunction, Request, Response } from "express";

const RECENT_AUTH_WINDOW_SECONDS = 10 * 60;

// Gates PIN/biometric changes on a genuinely fresh login (see authTime in
// auth/verifyToken.ts), not just a live session — a session kept alive by
// silent token refresh does NOT count. The user must have just completed
// email-OTP verification. This is what makes "forgot PIN" and "change PIN"
// the same flow, and stops a leaked long-lived token from silently
// resetting the PIN. Must run after requireAuth.
export function requireRecentAuth(req: Request, res: Response, next: NextFunction): void {
  const authTime = req.authUser?.authTime;
  if (authTime == null || Date.now() / 1000 - authTime > RECENT_AUTH_WINDOW_SECONDS) {
    res.status(401).json({ error: "reauth_required" });
    return;
  }
  next();
}
