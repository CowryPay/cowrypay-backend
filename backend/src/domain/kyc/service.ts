import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { usersRepo } from "../users/repository.js";
import { getKycAdapter } from "./index.js";
import { kycAttemptsRepo } from "./repository.js";
import type { KycSession } from "./adapter.js";

// KYC gates sends, not signup/wallet/deposits (§7.3) — this is only ever
// called on user action, never automatically at signup.
export async function startKyc(userId: string): Promise<KycSession> {
  const user = await usersRepo.findById(userId);
  if (!user) throw new Error("User not found");
  if (user.kycStatus === "verified") {
    throw new Error("KYC is already verified for this user");
  }

  const adapter = getKycAdapter();
  const session = await adapter.startVerification({ userId, email: user.email });

  await withTransaction(async (client) => {
    await kycAttemptsRepo.create(client, {
      userId,
      provider: env.kycProvider,
      providerReference: session.providerReference,
    });
    await usersRepo.updateKycStatus(client, userId, "pending", null);
  });

  return session;
}

// Called by the KYC vendor's result callback (mocked via /webhooks/kyc for
// now). Looks the attempt up by the reference the vendor hands back, not by
// user id, since that's all a webhook payload reliably carries.
export async function resolveKyc(
  providerReference: string,
  decision: "verified" | "rejected",
): Promise<void> {
  const attempt = await kycAttemptsRepo.findByProviderReference(providerReference);
  if (!attempt) throw new Error("KYC attempt not found for that provider reference");
  if (attempt.status !== "pending") {
    throw new Error(`KYC attempt ${attempt.id} is already resolved (${attempt.status})`);
  }

  await withTransaction(async (client) => {
    await kycAttemptsRepo.resolve(client, attempt.id, decision);
    await usersRepo.updateKycStatus(client, attempt.userId, decision, providerReference);
  });
}
