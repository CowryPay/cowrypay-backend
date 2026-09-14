import { Router, type Request, type Response } from "express";
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

// The real KYC vendor's result callback. Two layers, not one: the
// admin-key gate (a real, non-negotiable stopgap — POST /kyc/start hands
// the calling user their own providerReference, and this endpoint used to
// take a client-supplied `decision` straight into resolveKyc with zero
// auth at all, so any authenticated user could self-verify their own KYC
// status), plus getKycAdapter().verifyWebhookSignature — a real HMAC check
// once a real vendor is plugged in (mock mode stays permissive there, see
// mockAdapter.ts's own comment). Not currently exploitable into moving
// funds regardless (sendAuthorization.ts's canInitiateSend only checks
// PIN, not KYC status — a deliberate product decision, not an oversight),
// but a fintech shouldn't let users mint their own compliance status
// either way.
//
// Parsing itself is adapter-owned (parseWebhookResult), not a shared
// schema here — each vendor's real payload shape lives inside its own
// adapter (see KYC issue #4). A null result means either an unparseable
// body OR a legitimate non-terminal event (e.g. Dojah's flow still in
// progress) — both ack with 200 and do nothing, since neither is this
// endpoint's caller's fault and retrying won't change that.
kycRouter.post("/webhooks/kyc", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const adapter = getKycAdapter();
  if (!adapter.verifyWebhookSignature({ rawBody: req.rawBody, headers: req.headers as Record<string, string | undefined> })) {
    res.status(401).json({ error: "invalid webhook signature" });
    return;
  }
  const result = adapter.parseWebhookResult(req.body);
  if (!result) {
    res.json({ ok: true, skipped: true });
    return;
  }
  try {
    await resolveKyc(result.providerReference, result.decision);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
