import { randomUUID } from "node:crypto";
import { withTransaction } from "../../db/pool.js";
import type { KycStatus } from "../../types.js";
import type { KycSubject } from "../kyc/adapter.js";
import { usersRepo } from "../users/repository.js";
import { decideScreening, screenIndividual, type ScreeningStatus } from "./dojahScreening.js";
import { amlScreeningsRepo, type AmlReviewDecision, type AmlScreening } from "./repository.js";

export interface ScreeningOutcome {
  provider: string;
  status: ScreeningStatus;
  matchStatus: string | null;
  riskLevel: string | null;
  screenedName: string | null;
  screenedDateOfBirth: string | null;
  entityId: string | null;
  response: unknown;
  error: string | null;
}

// Runs the screen but persists nothing — resolveKyc stores the outcome in
// the same transaction as the KYC status change, and this network call
// stays outside that transaction.
//
// Fails closed: no verified name to screen, or Dojah erroring / timing out
// / out of wallet balance (402), all land in "review" rather than letting
// an unscreened user through. An admin sees the error in the queue.
export async function runAmlScreening(subject: KycSubject | undefined): Promise<ScreeningOutcome> {
  const base = {
    provider: "dojah",
    screenedName: subject?.name ?? null,
    screenedDateOfBirth: subject?.dateOfBirth ?? null,
  };

  if (!subject) {
    return {
      ...base,
      status: "review",
      matchStatus: null,
      riskLevel: null,
      entityId: null,
      response: null,
      error: "KYC result carried no verified name to screen",
    };
  }

  try {
    const response = await screenIndividual(subject, `aml_${randomUUID()}`);
    return { ...base, ...decideScreening(response), response, error: null };
  } catch (err) {
    return {
      ...base,
      status: "review",
      matchStatus: null,
      riskLevel: null,
      entityId: null,
      response: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// What the user's kyc_status becomes once screening has run. Sends are the
// only thing KYC gates, so "held for review" is just staying pending until
// an admin decides.
export function kycStatusForScreening(status: ScreeningStatus): KycStatus {
  if (status === "clear") return "verified";
  if (status === "blocked") return "rejected";
  return "pending";
}

export function listScreeningsAwaitingReview(): Promise<AmlScreening[]> {
  return amlScreeningsRepo.listAwaitingReview();
}

// An admin's final call on a held or blocked screen. The note is required —
// who decided, and why, is what a regulator asks for. Clearing verifies the
// user (screening only ever runs after the vendor already verified their
// identity); blocking rejects them.
export async function reviewScreening(id: string, decision: AmlReviewDecision, note: string): Promise<AmlScreening> {
  const screening = await amlScreeningsRepo.findById(id);
  if (!screening) throw new Error("AML screening not found");
  if (screening.status === "clear") throw new Error("AML screening is clear — nothing to review");
  if (screening.reviewDecision) throw new Error(`AML screening ${id} is already reviewed (${screening.reviewDecision})`);

  const user = await usersRepo.findById(screening.userId);
  if (!user) throw new Error("User not found");

  return withTransaction(async (client) => {
    const reviewed = await amlScreeningsRepo.recordReview(client, id, decision, note);
    if (!reviewed) throw new Error(`AML screening ${id} is already reviewed`);
    await usersRepo.updateKycStatus(
      client,
      user.id,
      decision === "cleared" ? "verified" : "rejected",
      user.kycReference,
    );
    return reviewed;
  });
}
