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
});

// REST-only by design — unlike the off-ramp send flow, this never goes
// through the chat assistant. A wrong destination address here is
// unrecoverable money loss, and an LLM extracting an address from free
// text is exactly the wrong place to introduce that risk.
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
