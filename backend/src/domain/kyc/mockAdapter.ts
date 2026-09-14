import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { KycAdapter, KycSession } from "./adapter.js";

export const mockKycAdapter: KycAdapter = {
  async startVerification({ userId }): Promise<KycSession> {
    return {
      providerReference: `mock_kyc_${userId}_${randomUUID()}`,
    };
  },

  // Deliberately permissive — there's no real vendor secret to check a
  // signature against in mock mode, and /webhooks/kyc's admin-key gate
  // (see routes/kyc.ts) is what actually protects this while KYC_PROVIDER
  // stays "mock". A REAL adapter must not copy this: it has to verify a
  // genuine vendor-issued signature, since this method existing on the
  // interface at all is what stops that from being forgotten.
  verifyWebhookSignature(): boolean {
    return true;
  },

  // The old flat stub shape (see routes/kyc.ts's KYC issue #4 history) —
  // kept here, not in the route, now that parsing is adapter-owned. Lets
  // a manual POST to /webhooks/kyc with {providerReference, decision}
  // keep working exactly as before while KYC_PROVIDER=mock.
  parseWebhookResult(body: unknown) {
    const parsed = z
      .object({ providerReference: z.string(), decision: z.enum(["verified", "rejected"]) })
      .safeParse(body);
    return parsed.success ? parsed.data : null;
  },
};
