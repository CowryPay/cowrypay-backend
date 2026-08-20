import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { initiateCrossChainSend } from "../domain/crossChainSend/service.js";
import { crossChainSendsRepo } from "../domain/crossChainSend/repository.js";

export const crossChainSendsRouter = Router();

const CreateCrossChainSendSchema = z.object({
  sourceChain: z.string().min(1),
  destinationChain: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a decimal string"),
  toAddress: z.string().min(1),
  pin: z.string().regex(/^\d{4,6}$/, "pin must be 4-6 digits"),
  tokenSymbol: z.string().min(1).optional(),
});

// API-only for now (Phase 1) — no chat integration yet, deliberately: the
// "real funds mid-flight, no instant fallback" risk surface this
// introduces (see the plan's risk-handling section) needs to be proven
// safe with real, small test transfers before a conversational UI sits
// on top of it. Same §9 boundary as crypto-withdrawals: a wrong
// destination address here is unrecoverable, so whatever calls this must
// show the user the exact address + both chains + fee, and collect a
// real PIN, before submitting.
crossChainSendsRouter.post("/cross-chain-sends", requireAuth, async (req: Request, res: Response) => {
  const parsed = CreateCrossChainSendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    const send = await initiateCrossChainSend(req.authUser!.id, parsed.data);
    res.json({ send });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

crossChainSendsRouter.get("/cross-chain-sends/:id", requireAuth, async (req: Request, res: Response) => {
  const send = await crossChainSendsRepo.findById(req.params.id);
  if (!send || send.userId !== req.authUser!.id) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const transitions = await crossChainSendsRepo.getTransitions(send.id);
  res.json({ send, transitions });
});

crossChainSendsRouter.get("/cross-chain-sends", requireAuth, async (req: Request, res: Response) => {
  const sends = await crossChainSendsRepo.getForUser(req.authUser!.id);
  res.json({ sends });
});
