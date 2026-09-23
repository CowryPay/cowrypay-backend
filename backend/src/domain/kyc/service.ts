import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { usersRepo } from "../users/repository.js";
import { resolveCountry } from "../../ai-agent/offramp/countries.js";
import { getKycAdapter } from "./index.js";
import { kycAttemptsRepo } from "./repository.js";
import type { KycSession, KycSubject } from "./adapter.js";
import { amlScreeningsRepo } from "../aml/repository.js";
import { kycStatusForScreening, runAmlScreening } from "../aml/service.js";

// KYC gates sends, not signup/wallet/deposits (§7.3) — this is only ever
// called on user action, never automatically at signup.
//
// country decides which Dojah workflow gets used (dojahAdapter.ts) — the
// Government Data step only exists for Nigeria/Kenya, confirmed live with
// Dojah (2026-09-22/23), so every other country needs a different
// workflow entirely. Validated with the same resolveCountry() remittance
// already uses for its own country input, rather than trusting a raw
// string straight through — a garbage value should fail clean here, not
// silently route to whichever widget the adapter happens to fall back to.
export async function startKyc(userId: string, countryInput: string): Promise<KycSession> {
  const user = await usersRepo.findById(userId);
  if (!user) throw new Error("User not found");
  if (user.kycStatus === "verified") {
    throw new Error("KYC is already verified for this user");
  }
  const country = resolveCountry(countryInput);
  if (!country) {
    throw new Error(`"${countryInput}" isn't a country we support — please check the spelling and try again.`);
  }

  const adapter = getKycAdapter();
  const session = await adapter.startVerification({ userId, email: user.email, country: country.name });

  await withTransaction(async (client) => {
    await kycAttemptsRepo.create(client, {
      userId,
      provider: env.kycProvider,
      providerReference: session.providerReference,
      country: country.name,
    });
    await usersRepo.updateKycStatus(client, userId, "pending", null);
  });

  return session;
}

// Called by the KYC vendor's result callback (mocked via /webhooks/kyc for
// now). Looks the attempt up by the reference the vendor hands back, not by
// user id, since that's all a webhook payload reliably carries.
//
// When AML_SCREENING_ENABLED and the vendor verified the user, their
// verified identity is screened before kyc_status changes (KYC issue #6):
// clear → verified, held → stays pending for admin review, confirmed
// sanctions match → rejected. The attempt row still records the vendor's
// own verdict; the screening row records the AML outcome.
export async function resolveKyc(
  providerReference: string,
  decision: "verified" | "rejected",
  subject?: KycSubject,
): Promise<void> {
  const attempt = await kycAttemptsRepo.findByProviderReference(providerReference);
  if (!attempt) throw new Error("KYC attempt not found for that provider reference");
  if (attempt.status !== "pending") {
    throw new Error(`KYC attempt ${attempt.id} is already resolved (${attempt.status})`);
  }

  // A billed network call, so it runs outside the transaction below.
  const screening = decision === "verified" && env.amlScreeningEnabled ? await runAmlScreening(subject) : null;
  const userStatus = screening ? kycStatusForScreening(screening.status) : decision;

  await withTransaction(async (client) => {
    // Re-checked inside the transaction: a vendor retrying the webhook while
    // the screen above was in flight must not resolve (or screen) twice.
    const resolved = await kycAttemptsRepo.resolve(client, attempt.id, decision);
    if (!resolved) throw new Error(`KYC attempt ${attempt.id} is already resolved`);
    if (screening) await amlScreeningsRepo.create(client, { userId: attempt.userId, ...screening });
    await usersRepo.updateKycStatus(client, attempt.userId, userStatus, providerReference);
  });
}
