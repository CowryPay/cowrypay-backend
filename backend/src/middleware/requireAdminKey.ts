import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../config/env.js";

// Plain !== comparison leaks timing information per matching byte — this
// key is the only gate on routes that move real treasury funds and
// arbitrarily adjust user ledgers, so it gets the same constant-time
// treatment already used for PIN verification (pin/hash.ts). Length is
// checked first since timingSafeEqual throws (rather than just returning
// false) on a length mismatch.
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

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
  const provided = req.header("x-admin-key");
  if (!provided || !safeEqual(provided, env.adminApiKey)) {
    res.status(401).json({ error: "invalid admin key" });
    return false;
  }
  return true;
}

// Narrower than requireAdminKey — accepts a SEPARATE, read-only-scoped
// secret (ADMIN_METRICS_KEY) meant for the frontend admin dashboard's own
// backend, so a leaked dashboard key can't reach the write endpoints
// (correct-state, deposit resolve) that requireAdminKey alone guards. The
// full admin key also works here, since it's a strict superset.
export function requireMetricsKey(req: Request, res: Response): boolean {
  if (!env.adminApiKey && !env.adminMetricsKey) {
    res.status(503).json({ error: "admin endpoint not configured" });
    return false;
  }
  const provided = req.header("x-admin-key");
  const matchesAdmin = !!provided && !!env.adminApiKey && safeEqual(provided, env.adminApiKey);
  const matchesMetrics = !!provided && !!env.adminMetricsKey && safeEqual(provided, env.adminMetricsKey);
  if (!matchesAdmin && !matchesMetrics) {
    res.status(401).json({ error: "invalid admin key" });
    return false;
  }
  return true;
}
