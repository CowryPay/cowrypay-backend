import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { depositsRepo } from "../domain/deposits/repository.js";
import { ingestDeposit, resolveManualReview } from "../domain/deposits/stateMachine.js";
import { walletsRepo } from "../domain/wallets/repository.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const depositsRouter = Router();

const DepositWebhookSchema = z.object({
  address: z.string(),
  chain: z.string().optional(),
  txHash: z.string(),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a decimal string"),
  tokenSymbol: z.string().optional(),
});

// Stub for the real Blockradar deposit webhook (§7.4) — same request shape
// and idempotency contract, so swapping the caller later is a no-op here.
depositsRouter.post("/webhooks/deposit", async (req: Request, res: Response) => {
  const parsed = DepositWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  const { address, txHash, amount } = parsed.data;
  const chain = parsed.data.chain ?? env.defaultChain;
  const tokenSymbol = parsed.data.tokenSymbol ?? env.defaultTokenSymbol;

  const wallet = await walletsRepo.findByAddress(address);
  if (!wallet) {
    res.status(404).json({ error: "no wallet registered for this address" });
    return;
  }

  try {
    const result = await ingestDeposit({
      userId: wallet.userId,
      walletId: wallet.id,
      tokenSymbol,
      amount,
      chain,
      txHash,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

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

// No role/permission system exists yet — gated by a shared secret header
// instead of requireAuth (a real user JWT proves identity, not admin
// privilege). Without this, anyone on the internet could force-approve or
// reject a flagged deposit with no authorization at all.
function requireAdminKey(req: Request, res: Response): boolean {
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
