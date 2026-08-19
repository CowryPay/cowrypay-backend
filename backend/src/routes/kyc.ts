import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdminKey } from "../middleware/requireAdminKey.js";
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

// Stub for the real KYC vendor's result callback, gated behind the admin
// key for now — the real fix (a vendor-issued HMAC signature, mirroring
// verifyPaycrestSignature/verifyBlockradarSignature) needs an actual vendor
// integration to verify against, which doesn't exist yet (getKycAdapter
// only has a "mock" provider registered). Until then this was reachable
// with zero auth at all: POST /kyc/start hands the calling user their own
// providerReference, and this endpoint took a client-supplied `decision`
// straight into resolveKyc — any authenticated user could self-verify
// their own KYC status. Not currently exploitable into moving funds
// (sendAuthorization.ts's canInitiateSend only checks PIN, not KYC status —
// a deliberate product decision, not an oversight), but a fintech
// shouldn't let users mint their own compliance status regardless.
kycRouter.post("/webhooks/kyc", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
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
