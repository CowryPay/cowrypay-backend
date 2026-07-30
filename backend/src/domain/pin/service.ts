import { withTransaction } from "../../db/pool.js";
import { usersRepo } from "../users/repository.js";
import { hashPin, verifyPin } from "./hash.js";

// Mandatory setup step — no longer gated on KYC (product decision: PIN
// alone gates sends, see sendAuthorization.ts).
export async function setTransactionPin(userId: string, pin: string): Promise<void> {
  const user = await usersRepo.findById(userId);
  if (!user) throw new Error("User not found");

  const pinHash = await hashPin(pin);
  await withTransaction(async (client) => {
    await usersRepo.setPinHash(client, userId, pinHash);
  });
}

// Used for both the app auto-lock/unlock flow and, later, send-time
// authorization. No rate limiting yet — fine for gating "unlock the app"
// (re-proving presence on an already-authenticated session), but a real
// attempt-throttling/lockout mechanism needs to exist before this is relied
// on to authorize an actual fund-moving action.
export async function verifyTransactionPin(userId: string, pin: string): Promise<boolean> {
  const user = await usersRepo.findById(userId);
  if (!user?.pinHash) return false;
  return verifyPin(pin, user.pinHash);
}

// Biometric is optional and supplementary — the PIN is the account-level
// fallback that must always exist (§9), so biometric can't be turned on
// before a PIN is set. No KYC gate (see setTransactionPin).
export async function setBiometricEnabled(userId: string, enabled: boolean): Promise<void> {
  const user = await usersRepo.findById(userId);
  if (!user) throw new Error("User not found");
  if (enabled && !user.pinHash) {
    throw new Error("Set a transaction PIN before enabling biometric authorization");
  }

  await withTransaction(async (client) => {
    await usersRepo.setBiometricEnabled(client, userId, enabled);
  });
}
