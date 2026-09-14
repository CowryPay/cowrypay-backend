import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { KycAdapter, KycSession, WebhookRequest } from "./adapter.js";

// Dojah EasyOnboard, launched via the embedded Widget SDK (Connect class)
// on the frontend's own KYC screen — see KYC issues #2/#3. There's no
// "create a verification session" API call: the widget only needs app_id +
// public key + widget_id (all static, live in frontend config) plus a
// reference_id. So this adapter's server-side job is minting that
// reference, verifying the completion webhook, and parsing its result.
function requireSecretKey(): string {
  if (!env.dojahSecretKey) {
    throw new Error("DOJAH_SECRET_KEY must be set for KYC_PROVIDER=dojah");
  }
  return env.dojahSecretKey;
}

// docs.dojah.io/docs/technical-reference/verify-events — x-dojah-signature
// is HMAC-SHA256 (hex) of the body keyed with the secret key. Computed over
// the RAW body, never a re-serialized JSON.stringify(req.body), which can
// reorder keys or change spacing and produce a different digest than the
// one Dojah signed. Same timingSafeEqual-guarded shape as
// verifyPaycrestSignature/verifyBlockradarSignature.
function verifySignature(rawBody: Buffer | undefined, signature: string | undefined, secretKey: string): boolean {
  if (!rawBody || !signature) return false;

  const expectedHex = createHmac("sha256", secretKey).update(rawBody).digest("hex").trim().toLowerCase();
  const providedHex = signature.trim().toLowerCase();

  const expected = Buffer.from(expectedHex, "utf8");
  const provided = Buffer.from(providedHex, "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

// Dojah's documented verification_status values. Ongoing/Pending are
// legitimate non-terminal events (still in the flow / awaiting review) —
// resolving the attempt on one of those would reject a user who hasn't
// actually finished. Failed/Abandoned are terminal but never a pass.
const REJECTED_STATUSES = new Set(["Failed", "Abandoned"]);

// Loose on `data`'s keys on purpose: which steps appear (id, selfie,
// government_data, address, phone_number, ...) depends on how the
// EasyOnboard flow is configured in Dojah's dashboard, and a step added
// there later shouldn't need a code change here.
const DojahWebhookSchema = z
  .object({
    reference_id: z.string().min(1),
    verification_status: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// The real gotcha from KYC issue #4: verification_status "Completed" means
// the FLOW finished, not that it PASSED — Dojah's own sample payload is
// "Completed" with a failed address step. Actual pass/fail is every
// per-step check under `data` reporting status === true.
//
// Entries without a `status` field (business_data, business_id,
// additional_document — captured data, not a check result) don't gate the
// decision. Fails closed: a "Completed" payload with no status-bearing
// step at all is treated as not passed, rather than vacuously verified.
function allStepsPassed(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  const checks = Object.values(data).filter(
    (step): step is { status: unknown } => typeof step === "object" && step !== null && "status" in step,
  );
  return checks.length > 0 && checks.every((step) => step.status === true);
}

export const dojahKycAdapter: KycAdapter = {
  // No redirectUrl — the widget is embedded, not a redirect. The frontend
  // passes providerReference into the widget as reference_id (Dojah
  // requires min 10 chars), and Dojah echoes it back on the webhook.
  async startVerification(): Promise<KycSession> {
    // Checked here too, not just on the webhook, so a misconfigured
    // environment fails before a user sits through a flow whose result
    // could never be verified.
    requireSecretKey();
    return { providerReference: `dojah_${randomUUID()}` };
  },

  verifyWebhookSignature(req: WebhookRequest): boolean {
    return verifySignature(req.rawBody, req.headers["x-dojah-signature"], requireSecretKey());
  },

  parseWebhookResult(body: unknown): { providerReference: string; decision: "verified" | "rejected" } | null {
    const parsed = DojahWebhookSchema.safeParse(body);
    if (!parsed.success) return null;

    const { reference_id, verification_status, data } = parsed.data;
    if (verification_status === "Completed") {
      return { providerReference: reference_id, decision: allStepsPassed(data) ? "verified" : "rejected" };
    }
    if (REJECTED_STATUSES.has(verification_status)) {
      return { providerReference: reference_id, decision: "rejected" };
    }
    return null;
  },
};
