import type { User } from "../types.js";

export type SendAuthorizationDenialReason = "pin_not_set";

export interface SendAuthorizationResult {
  allowed: boolean;
  reason?: SendAuthorizationDenialReason;
}

// The gate the send flow checks before allowing a user to initiate anything —
// pure and side-effect free. KYC is not required to send (product decision —
// PIN alone gates sends for now).
export function canInitiateSend(user: User): SendAuthorizationResult {
  if (!user.pinHash) {
    return { allowed: false, reason: "pin_not_set" };
  }
  return { allowed: true };
}
