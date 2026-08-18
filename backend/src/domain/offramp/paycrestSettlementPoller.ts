import { withTransaction } from "../../db/pool.js";
import { getOrderStatus } from "./paycrestAdapter.js";
import { resolveNextSendState } from "./paycrestWebhook.js";
import { sendsRepo } from "./repository.js";
import { applyTerminalFailureTransition } from "./sendStateTransition.js";

// Closes the gap left when Paycrest's payment_order.* webhook doesn't
// arrive — confirmed live that it wasn't (zero hits on /webhooks/paycrest
// across staging and production, ever, per Railway's HTTP logs), while
// Paycrest's own dashboard showed the very same orders as settled. Polls
// Paycrest's order-status API directly instead, reusing the exact same
// event->state mapping the webhook handler uses (Paycrest's REST status
// field uses the same words as its webhook event suffixes, e.g. "settled"
// for both a `status` value and a `payment_order.settled` event) so the
// two paths can never disagree about what a given status means.
export async function pollPendingSettlements(): Promise<void> {
  const pending = await sendsRepo.findAwaitingSettlement("paycrest");

  for (const send of pending) {
    if (!send.providerOrderId) continue; // findAwaitingSettlement already filters this, guarding for TS
    try {
      const orderStatus = await getOrderStatus(send.providerOrderId);
      const event = `payment_order.${orderStatus.status}`;
      const nextState = resolveNextSendState(event, send.state);
      if (!nextState) continue; // same status as last check, or not a recognized/forward-moving one

      // Mirrors centiivSettlementPoller.ts's own fix, for the same reason:
      // amountPaid is Paycrest's equivalent "did money actually move"
      // signal, separate from the top-level status string. A refunded/
      // expired order that still shows a real amountPaid would mean their
      // own data disagrees with itself — auto-crediting the user in that
      // case risks double-paying them, so it's held for manual review
      // instead of trusted blindly.
      if ((nextState === "FAILED" || nextState === "REFUNDED") && Number(orderStatus.amountPaid ?? 0) > 0) {
        console.error(
          `[paycrest-settlement-poller] send ${send.id} (order ${send.providerOrderId}) has status "${orderStatus.status}" but a non-zero amountPaid (${orderStatus.amountPaid}) — Paycrest's own data contradicts itself. NOT auto-crediting; needs manual review.`,
        );
        continue;
      }

      await withTransaction(async (client) => {
        if (nextState === "FAILED" || nextState === "REFUNDED") {
          await applyTerminalFailureTransition(
            client,
            send,
            nextState,
            event,
            "paycrest_settlement_poller",
            orderStatus.txHash ? { txHash: orderStatus.txHash } : undefined,
          );
        } else {
          await sendsRepo.updateState(client, send.id, { state: nextState });
          await sendsRepo.logTransition(client, send.id, send.state, nextState, event, "paycrest_settlement_poller");
        }
      });
    } catch (err) {
      // One bad lookup (e.g. a transient Paycrest API error) must not block
      // the rest of the batch from being checked this cycle.
      console.error(`[paycrest-settlement-poller] failed to check send ${send.id}:`, err);
    }
  }
}

const POLL_INTERVAL_MS = 60_000;

export function startPaycrestSettlementPoller(): void {
  setInterval(() => {
    pollPendingSettlements().catch((err) => console.error("[paycrest-settlement-poller]", err));
  }, POLL_INTERVAL_MS);
}
