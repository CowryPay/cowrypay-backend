import { randomUUID } from "node:crypto";
import type { KycAdapter, KycSession } from "./adapter.js";

export const mockKycAdapter: KycAdapter = {
  async startVerification({ userId }): Promise<KycSession> {
    return {
      providerReference: `mock_kyc_${userId}_${randomUUID()}`,
    };
  },
};
