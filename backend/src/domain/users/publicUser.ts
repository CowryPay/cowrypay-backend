import type { KycStatus, User } from "../../types.js";

export interface PublicUser {
  id: string;
  email: string | null;
  phone: string | null;
  kycStatus: KycStatus;
  pinSet: boolean;
  biometricEnabled: boolean;
  passwordSet: boolean;
  createdAt: string;
}

// Never return pin_hash over the API, even hashed — clients only need to
// know whether a PIN exists, not its value.
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    kycStatus: user.kycStatus,
    pinSet: user.pinHash !== null,
    biometricEnabled: user.biometricEnabled,
    passwordSet: user.passwordSet,
    createdAt: user.createdAt,
  };
}
