import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdminKey } from "../middleware/requireAdminKey.js";
import { resolveKyc, startKyc } from "../domain/kyc/service.js";
import { getKycAdapter } from "../domain/kyc/index.js";

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

// Stub for the real KYC vendor's result callback. Two layers now, not one:
// the admin-key gate (a real, non-negotiable stopgap — POST /kyc/start
// hands the calling user their own providerReference, and this endpoint
// used to take a client-supplied `decision` straight into resolveKyc with
// zero auth at all, so any authenticated user could self-verify their own
// KYC status), plus getKycAdapter().verifyWebhookSignature — a no-op today
// since only the mock provider exists (see mockAdapter.ts's own comment),
// but wired in now so a real vendor's real signature check (mirroring
// verifyPaycrestSignature/verifyBlockradarSignature) activates the moment
// one is plugged in, without anyone having to remember to touch this route
// again. Not currently exploitable into moving funds regardless
// (sendAuthorization.ts's canInitiateSend only checks PIN, not KYC status —
// a deliberate product decision, not an oversight), but a fintech
// shouldn't let users mint their own compliance status either way.
kycRouter.post("/webhooks/kyc", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  if (!getKycAdapter().verifyWebhookSignature({ rawBody: req.rawBody, headers: req.headers as Record<string, string | undefined> })) {
    res.status(401).json({ error: "invalid webhook signature" });
    return;
  }
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
