import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { initiateStellarInternalTransfer } from "../domain/internalTransfers/service.js";
import { internalTransfersRepo } from "../domain/internalTransfers/repository.js";

export const internalTransfersRouter = Router();

const CreateStellarInternalTransferSchema = z.object({
  recipientMemoId: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a decimal string"),
  pin: z.string().regex(/^\d{4,6}$/, "pin must be 4-6 digits"),
  // Omitted means USDC — see InitiateStellarInternalTransferInput's own comment.
  tokenSymbol: z.string().min(1).optional(),
});

// Same §9 boundary as /crypto-withdrawals: chat can build a draft
// (domain/chat/internalTransferDraft.ts) but never calls this itself —
// the app shows the user the full recipient + amount and requires a real
// PIN entry before it calls this endpoint.
internalTransfersRouter.post("/internal-transfers/stellar", requireAuth, async (req: Request, res: Response) => {
  const parsed = CreateStellarInternalTransferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    const transfer = await initiateStellarInternalTransfer(req.authUser!.id, parsed.data);
    res.json({ transfer });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

internalTransfersRouter.get("/internal-transfers/:id", requireAuth, async (req: Request, res: Response) => {
  const transfer = await internalTransfersRepo.findById(req.params.id);
  if (!transfer || (transfer.fromUserId !== req.authUser!.id && transfer.toUserId !== req.authUser!.id)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ transfer });
});

internalTransfersRouter.get("/internal-transfers", requireAuth, async (req: Request, res: Response) => {
  const transfers = await internalTransfersRepo.getForUser(req.authUser!.id);
  res.json({ transfers });
});
