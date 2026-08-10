import { withTransaction } from "../../db/pool.js";
import type { SendState } from "../../types.js";
import { getOrderStatus } from "./quidaxAdapter.js";
import { sendsRepo } from "./repository.js";
import { resolveNextSendState } from "./sendStateTransition.js";

// Same safety net as paycrestSettlementPoller.ts, for the same reason: a
// webhook can silently never arrive (already proven true once this
// session, for Paycrest — see that poller's own comment). Deliberately
// narrower than Paycrest's version, though: unlike Paycrest, Quidax's REST
// status field doesn't use the same vocabulary as its webhook event names
// (e.g. top-level status "completed" vs the webhook's
// "sell_transaction.successful" — confirmed different, not assumed), so
// there's no single string transform that reuses the webhook's own event
// map safely. Only "completed" is mapped here, since that's the one value
// directly confirmed in Quidax's docs — everything else (their docs
// mention "needs_attention" as a transaction-level status on failure) is
// left alone rather than guessed at, since a wrong auto-refund on a
// transaction Quidax later actually pays out would be worse than leaving
// it for the webhook or manual review to resolve.
const STATUS_STATE_MAP: Partial<Record<string, SendState>> = {
  completed: "COMPLETE",
};

export async function pollPendingSettlements(): Promise<void> {
  const pending = await sendsRepo.findAwaitingSettlement("quidax");

  for (const send of pending) {
    if (!send.providerOrderId) continue; // findAwaitingSettlement already filters this, guarding for TS
    try {
      const orderStatus = await getOrderStatus(send.providerOrderId);
      const nextState = resolveNextSendState(STATUS_STATE_MAP, orderStatus.status, send.state);
      if (!nextState) continue; // same status as last check, or not a recognized/forward-moving one

      await withTransaction(async (client) => {
        await sendsRepo.updateState(client, send.id, { state: nextState });
        await sendsRepo.logTransition(
          client,
          send.id,
          send.state,
          nextState,
          `status:${orderStatus.status}`,
          "quidax_settlement_poller",
        );
      });
    } catch (err) {
      // One bad lookup (e.g. a transient Quidax API error) must not block
      // the rest of the batch from being checked this cycle.
      console.error(`[quidax-settlement-poller] failed to check send ${send.id}:`, err);
    }
  }
}

const POLL_INTERVAL_MS = 60_000;

export function startQuidaxSettlementPoller(): void {
  setInterval(() => {
    pollPendingSettlements().catch((err) => console.error("[quidax-settlement-poller]", err));
  }, POLL_INTERVAL_MS);
}
