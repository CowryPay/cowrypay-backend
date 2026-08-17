import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { initiateCryptoWithdrawal } from "../domain/cryptoWithdrawals/service.js";
import { cryptoWithdrawalsRepo } from "../domain/cryptoWithdrawals/repository.js";

export const cryptoWithdrawalsRouter = Router();

const CreateCryptoWithdrawalSchema = z.object({
  chain: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a decimal string"),
  toAddress: z.string().min(1),
  pin: z.string().regex(/^\d{4,6}$/, "pin must be 4-6 digits"),
  // Omitted means USDC — see InitiateCryptoWithdrawalInput's own comment.
  tokenSymbol: z.string().min(1).optional(),
});

// This endpoint itself is still never called from chat directly — a
// wrong destination address here is unrecoverable money loss, so chat
// can build a WITHDRAW_TO_WALLET draft (domain/chat/cryptoWithdrawalDraft.ts)
// but that draft is only ever a suggestion the frontend must show the
// user in full, requiring explicit confirmation of the exact address
// plus a real PIN entry, before it calls this endpoint itself — same §9
// boundary as an off-ramp send's pendingSend, chat only ever proposes,
// the app (with the user looking at it) is what actually submits.
cryptoWithdrawalsRouter.post("/crypto-withdrawals", requireAuth, async (req: Request, res: Response) => {
  const parsed = CreateCryptoWithdrawalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    const withdrawal = await initiateCryptoWithdrawal(req.authUser!.id, parsed.data);
    res.json({ withdrawal });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

cryptoWithdrawalsRouter.get("/crypto-withdrawals/:id", requireAuth, async (req: Request, res: Response) => {
  const withdrawal = await cryptoWithdrawalsRepo.findById(req.params.id);
  if (!withdrawal || withdrawal.userId !== req.authUser!.id) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const transitions = await cryptoWithdrawalsRepo.getTransitions(withdrawal.id);
  res.json({ withdrawal, transitions });
});

cryptoWithdrawalsRouter.get("/crypto-withdrawals", requireAuth, async (req: Request, res: Response) => {
  const withdrawals = await cryptoWithdrawalsRepo.getForUser(req.authUser!.id);
  res.json({ withdrawals });
});
