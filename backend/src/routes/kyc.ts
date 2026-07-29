import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { resolveKyc, startKyc } from "../domain/kyc/service.js";

export const kycRouter = Router();

kycRouter.post("/kyc/start", requireAuth, async (req: Request, res: Response) => {
  try {
    const session = await startKyc(req.authUser!.id);
    res.json(session);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const KycWebhookSchema = z.object({
  providerReference: z.string(),
  decision: z.enum(["verified", "rejected"]),
});

// Stub for the real KYC vendor's result callback — same idea as the deposit
// webhook stub, swap the caller later without touching this shape.
kycRouter.post("/webhooks/kyc", async (req: Request, res: Response) => {
  const parsed = KycWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    await resolveKyc(parsed.data.providerReference, parsed.data.decision);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
