import { env } from "../../config/env.js";
import type { KycAdapter } from "./adapter.js";
import { mockKycAdapter } from "./mockAdapter.js";

export function getKycAdapter(): KycAdapter {
  switch (env.kycProvider) {
    case "mock":
      return mockKycAdapter;
    // Sandbox credentials + EasyOnboard flow configuration land first
    // (that issue blocks this one) — dojahAdapter.ts doesn't exist yet.
    // A distinct error from the generic "unknown provider" one below, so
    // setting KYC_PROVIDER=dojah too early fails with a clear reason
    // instead of looking like a typo.
    case "dojah":
      throw new Error("KYC_PROVIDER=dojah is set but dojahAdapter.ts isn't implemented yet — see issue #2/#3");
    default:
      throw new Error(`Unknown KYC_PROVIDER: ${env.kycProvider}`);
  }
}
