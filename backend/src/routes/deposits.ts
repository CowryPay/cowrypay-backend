import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { depositsRepo } from "../domain/deposits/repository.js";
import { resolveManualReview } from "../domain/deposits/stateMachine.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdminKey } from "../middleware/requireAdminKey.js";

export const depositsRouter = Router();

// The original POST /webhooks/deposit stub that lived here (§7.4, pre-dating
// the real Blockradar/Stellar/Solana deposit paths) was removed — it had no
// signature or auth check of any kind and called ingestDeposit directly, so
// anyone could credit their own ledger with an arbitrary amount by POSTing
// a fake txHash. Every real deposit path (routes/blockradarWebhook.ts,
// routes/solanaWebhook.ts, the Stellar/EVM scanners) verifies a signature
// or reads directly from a chain before crediting anything; this stub
// verified nothing and was never referenced anywhere else in the codebase.

depositsRouter.get("/deposits", requireAuth, async (req: Request, res: Response) => {
  const deposits = await depositsRepo.getForUser(req.authUser!.id, 20);
  res.json({ deposits });
});

depositsRouter.get("/deposits/:id", requireAuth, async (req: Request, res: Response) => {
  const deposit = await depositsRepo.findById(req.params.id);
  if (!deposit || deposit.userId !== req.authUser!.id) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const transitions = await depositsRepo.getTransitions(deposit.id);
  res.json({ deposit, transitions });
});

const ReviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  actor: z.string().optional(),
});

// Closes the MANUAL_REVIEW branch of the state machine — without this, a
// flagged deposit would have no way back to a terminal state.
depositsRouter.post("/admin/deposits/:id/review", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;

  const parsed = ReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    const deposit = await resolveManualReview(req.params.id, parsed.data.decision, parsed.data.actor ?? "admin");
    res.json({ deposit });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
