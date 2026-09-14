import { env } from "../../config/env.js";
import type { KycAdapter } from "./adapter.js";
import { mockKycAdapter } from "./mockAdapter.js";

export function getKycAdapter(): KycAdapter {
  switch (env.kycProvider) {
    case "mock":
      return mockKycAdapter;
    // #3 (dojahAdapter.ts) is Anuoluwapo's issue, not built here — a
    // distinct error from the generic "unknown provider" one below, so
    // setting KYC_PROVIDER=dojah too early fails with a clear reason
    // instead of looking like a typo.
    case "dojah":
      throw new Error("KYC_PROVIDER=dojah is set but dojahAdapter.ts isn't implemented yet — see issue #3");
    default:
      throw new Error(`Unknown KYC_PROVIDER: ${env.kycProvider}`);
  }
}
