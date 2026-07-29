import { env } from "../../config/env.js";
import type { KycAdapter } from "./adapter.js";
import { mockKycAdapter } from "./mockAdapter.js";

export function getKycAdapter(): KycAdapter {
  switch (env.kycProvider) {
    case "mock":
      return mockKycAdapter;
    default:
      throw new Error(`Unknown KYC_PROVIDER: ${env.kycProvider}`);
  }
}
