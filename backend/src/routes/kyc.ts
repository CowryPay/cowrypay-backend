import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdminKey } from "../middleware/requireAdminKey.js";
import { resolveKyc, startKyc } from "../domain/kyc/service.js";
import { getKycAdapter } from "../domain/kyc/index.js";

export const kycRouter = Router();

const StartKycSchema = z.object({ country: z.string().min(1) });

kycRouter.post("/kyc/start", requireAuth, async (req: Request, res: Response) => {
  const parsed = StartKycSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "country is required" });
    return;
  }
  try {
    const session = await startKyc(req.authUser!.id, parsed.data.country);
    res.json(session);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// The real KYC vendor's result callback. Which gate protects it depends on
// the provider:
//
// - mock: the admin-key gate. POST /kyc/start hands the calling user their
//   own providerReference and mockAdapter.verifyWebhookSignature is
//   permissive, so without this any authenticated user could self-verify
//   their own KYC status. Still non-negotiable in mock mode.
// - a real vendor (dojah): the vendor's own signature check is the gate.
//   The vendor's servers can't send our x-admin-key (and that key also
//   guards treasury routes, so it must never sit in a vendor dashboard) —
//   requiring it here would 401 every genuine result and leave users stuck
//   "pending". A forged request can't pass without the vendor secret.
//
// Not currently exploitable into moving funds regardless
// (sendAuthorization.ts's canInitiateSend only checks PIN, not KYC status
// — a deliberate product decision, not an oversight), but a fintech
// shouldn't let users mint their own compliance status either way.
//
// Parsing itself is adapter-owned (parseWebhookResult), not a shared
// schema here — each vendor's real payload shape lives inside its own
// adapter (see KYC issue #4). A null result means either an unparseable
// body OR a legitimate non-terminal event (e.g. Dojah's flow still in
// progress) — both ack with 200 and do nothing, since neither is this
// endpoint's caller's fault and retrying won't change that.
kycRouter.post("/webhooks/kyc", async (req: Request, res: Response) => {
  if (env.kycProvider === "mock" && !requireAdminKey(req, res)) return;
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
    await resolveKyc(result.providerReference, result.decision, result.subject);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
