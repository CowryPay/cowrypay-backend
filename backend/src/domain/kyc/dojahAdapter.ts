import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { KycAdapter, KycSession, WebhookRequest } from "./adapter.js";

// Widget SDK is launched entirely client-side — app_id + public key +
// widget_id handed straight into the frontend's widget component (see KYC
// issue #2: confirmed the frontend has a real screen to mount it in).
// Unlike a redirect-link vendor, there's no "create a verification
// session" API call to make here; startVerification's only real job is
// minting the reference_id the frontend passes into the widget and we
// later match the webhook against (see parseWebhookResult).
function requireConfig(): { appId: string; publicKey: string; secretKey: string; widgetId: string } {
  if (!env.dojahAppId || !env.dojahPublicKey || !env.dojahSecretKey || !env.dojahWidgetId) {
    throw new Error(
      "DOJAH_APP_ID, DOJAH_PUBLIC_KEY, DOJAH_SECRET_KEY and DOJAH_WIDGET_ID must all be set for KYC_PROVIDER=dojah",
    );
  }
  return { appId: env.dojahAppId, publicKey: env.dojahPublicKey, secretKey: env.dojahSecretKey, widgetId: env.dojahWidgetId };
}

// docs.dojah.io/docs/technical-reference/verify-events — HMAC-SHA256 over
// the raw request body (never a re-serialized JSON.stringify(req.body):
// re-serializing can reorder keys or change spacing, producing a
// different signature than the one Dojah computed), hex digest, carried
// in the x-dojah-signature header. Same timingSafeEqual-guarded shape as
// verifyPaycrestSignature/verifyBlockradarSignature.
function verifySignature(rawBody: Buffer | undefined, signature: string | undefined, secretKey: string): boolean {
  if (!rawBody || !signature) return false;

  const expectedHex = createHmac("sha256", secretKey).update(rawBody).digest("hex").trim().toLowerCase();
  const providedHex = signature.trim().toLowerCase();

  const expected = Buffer.from(expectedHex, "utf8");
  const provided = Buffer.from(providedHex, "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

// Only these mean Dojah is actually done with this attempt. "Ongoing"/
// "Pending" are legitimate intermediate events, not a result — resolving
// the KYC attempt on one of those would reject (or worse, half-verify) a
// user who hasn't finished yet.
const TERMINAL_STATUSES = new Set(["Completed", "Failed", "Abandoned"]);

// Deliberately loose on `data`'s exact keys (id, selfie, government_data,
// address, additional_document, business_data, email — not all present on
// every flow, and EasyOnboard's configured steps decide which ones show
// up) — z.record + a permissive per-entry check below is more robust to a
// step Dojah adds later than hardcoding every key name.
const DojahWebhookSchema = z
  .object({
    reference_id: z.string(),
    verification_status: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// The real gotcha this issue exists to close: verification_status
// "Completed" means the FLOW finished, not that it PASSED — a user can
// complete every step and still fail ID or selfie match. Actual pass/fail
// is: did every per-step result under `data` come back status === true.
// A step with no `status` field at all (stray metadata, not a check
// result) doesn't gate the decision either way.
function allStepsPassed(data: Record<string, unknown> | undefined): boolean {
  if (!data) return true;
  return Object.values(data).every((step) => {
    if (typeof step !== "object" || step === null || !("status" in step)) return true;
    return (step as { status: unknown }).status === true;
  });
}

export const dojahKycAdapter: KycAdapter = {
  async startVerification({ userId }): Promise<KycSession> {
    const { appId, publicKey, widgetId } = requireConfig();
    return {
      providerReference: `dojah_${userId}_${randomUUID()}`,
      widget: { appId, publicKey, widgetId },
    };
  },

  verifyWebhookSignature(req: WebhookRequest): boolean {
    const { secretKey } = requireConfig();
    return verifySignature(req.rawBody, req.headers["x-dojah-signature"], secretKey);
  },

  parseWebhookResult(body: unknown): { providerReference: string; decision: "verified" | "rejected" } | null {
    const parsed = DojahWebhookSchema.safeParse(body);
    if (!parsed.success) return null;

    const { reference_id, verification_status, data } = parsed.data;
    if (!TERMINAL_STATUSES.has(verification_status)) return null;

    const decision: "verified" | "rejected" =
      verification_status === "Completed" && allStepsPassed(data) ? "verified" : "rejected";

    return { providerReference: reference_id, decision };
  },
};
