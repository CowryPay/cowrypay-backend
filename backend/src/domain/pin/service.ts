import { withTransaction } from "../../db/pool.js";
import { usersRepo } from "../users/repository.js";
import { hashPin } from "./hash.js";

// Mandatory setup step, and only after KYC clears (§5 step 6, §9) — this
// ordering is enforced here, not just assumed by callers.
export async function setTransactionPin(userId: string, pin: string): Promise<void> {
  const user = await usersRepo.findById(userId);
  if (!user) throw new Error("User not found");
  if (user.kycStatus !== "verified") {
    throw new Error("KYC must be verified before a transaction PIN can be set");
  }

  const pinHash = await hashPin(pin);
  await withTransaction(async (client) => {
    await usersRepo.setPinHash(client, userId, pinHash);
  });
}

// Biometric is optional and supplementary — the PIN is the account-level
// fallback that must always exist (§9), so biometric can't be turned on
// before a PIN is set.
export async function setBiometricEnabled(userId: string, enabled: boolean): Promise<void> {
  const user = await usersRepo.findById(userId);
  if (!user) throw new Error("User not found");
  if (user.kycStatus !== "verified") {
    throw new Error("KYC must be verified before biometric authorization can be enabled");
  }
  if (enabled && !user.pinHash) {
    throw new Error("Set a transaction PIN before enabling biometric authorization");
  }

  await withTransaction(async (client) => {
    await usersRepo.setBiometricEnabled(client, userId, enabled);
  });
}
