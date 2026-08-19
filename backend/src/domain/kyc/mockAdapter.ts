import { randomUUID } from "node:crypto";
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
};
