import type { Request, Response } from "express";
import { env } from "../config/env.js";

// No role/permission system exists yet — gated by a shared secret header
// instead of requireAuth (a real user JWT proves identity, not admin
// privilege). Shared across every /admin/* route (originally lived only in
// routes/deposits.ts for the manual-review endpoint; extracted here once a
// second admin route needed the exact same check).
export function requireAdminKey(req: Request, res: Response): boolean {
  if (!env.adminApiKey) {
    res.status(503).json({ error: "admin endpoint not configured" });
    return false;
  }
  if (req.header("x-admin-key") !== env.adminApiKey) {
    res.status(401).json({ error: "invalid admin key" });
    return false;
  }
  return true;
}
