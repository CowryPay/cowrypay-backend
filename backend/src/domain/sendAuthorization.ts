import type { User } from "../types.js";

export type SendAuthorizationDenialReason = "kyc_not_verified" | "pin_not_set";

export interface SendAuthorizationResult {
  allowed: boolean;
  reason?: SendAuthorizationDenialReason;
}

// The gate the future send flow checks before allowing a user to initiate
// anything — pure and side-effect free, nothing about sends/routing/off-ramp
// touches this yet, it's just the predicate they'll call first.
export function canInitiateSend(user: User): SendAuthorizationResult {
  if (user.kycStatus !== "verified") {
    return { allowed: false, reason: "kyc_not_verified" };
  }
  if (!user.pinHash) {
    return { allowed: false, reason: "pin_not_set" };
  }
  return { allowed: true };
}
