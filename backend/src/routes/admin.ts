import { Router, type Request, type Response } from "express";
import { adminRepo } from "../domain/admin/repository.js";
import { requireAdminKey } from "../middleware/requireAdminKey.js";

export const adminRouter = Router();

// Backs an internal ops dashboard (wallets created, chains/tokens in use,
// send/deposit activity) — same shape of need as Blockradar's own wallet
// overview page, but across every provider we actually use (aws-kms,
// Blockradar, Stellar, Solana), which no third-party dashboard can show.
adminRouter.get("/admin/overview", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const overview = await adminRepo.getOverview();
  res.json(overview);
});

// Investor/funding-facing numbers — narrower and more curated than
// /admin/overview's ops-health snapshot: settled volume and captured
// revenue only, never counting failed/pending attempts as if they were
// real activity.
adminRouter.get("/admin/metrics", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const metrics = await adminRepo.getMetrics();
  res.json(metrics);
});

// Day-by-day trend for growth charts (volume/revenue over time) — /admin/metrics
// only ever answers "what's the total right now," a single point that can't
// distinguish flat from growing. Clamped to [1, 365] so a bad/absent query
// param can't trigger an unbounded table scan.
adminRouter.get("/admin/metrics/timeseries", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const timeseries = await adminRepo.getTimeseries(days);
  res.json({ days, timeseries });
});

// Diagnostic: "why didn't the fee reach treasury" — shows each send's fee
// amount next to what the fee-sweep step actually logged, since a send
// reaching PAYOUT_INITIATED/COMPLETE says nothing about the fee sweep
// specifically (it's a best-effort step separate from the main payout).
adminRouter.get("/admin/sends", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const chain = typeof req.query.chain === "string" ? req.query.chain : undefined;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const sends = await adminRepo.listRecentSends(chain, limit);
  res.json({ sends });
});
