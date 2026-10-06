import { env } from "../../config/env.js";
import { abandonKycAttempt } from "./service.js";
import { kycAttemptsRepo } from "./repository.js";

// The safety net for a user who closes the app/browser entirely before
// finishing KYC — POST /kyc/cancel (the frontend-driven path) never fires
// for them, so nothing else would ever clear their stuck "pending"
// attempt. Same TTL startKyc's own dedupe/reuse check uses (env.ts's
// kycPendingTtlMinutes), not a second number to keep in sync.
export async function abandonStalePendingKycAttempts(): Promise<void> {
  const cutoff = new Date(Date.now() - env.kycPendingTtlMinutes * 60_000);
  const stale = await kycAttemptsRepo.findStalePending(cutoff);

  for (const attempt of stale) {
    try {
      await abandonKycAttempt(attempt.id, attempt.userId);
    } catch (err) {
      // One bad row must not block the rest of the batch from being
      // checked this cycle.
      console.error(`[kyc-pending-ttl-poller] failed to abandon attempt ${attempt.id}:`, err);
    }
  }
}

const POLL_INTERVAL_MS = 5 * 60_000;

export function startKycPendingTtlPoller(): void {
  setInterval(() => {
    abandonStalePendingKycAttempts().catch((err) => console.error("[kyc-pending-ttl-poller]", err));
  }, POLL_INTERVAL_MS);
}
