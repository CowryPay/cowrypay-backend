import { withTransaction } from "../../db/pool.js";
import { getOrderStatus } from "./paycrestAdapter.js";
import { resolveNextSendState } from "./paycrestWebhook.js";
import { sendsRepo } from "./repository.js";

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
  const pending = await sendsRepo.findAwaitingSettlement();

  for (const send of pending) {
    if (!send.providerOrderId) continue; // findAwaitingSettlement already filters this, guarding for TS
    try {
      const orderStatus = await getOrderStatus(send.providerOrderId);
      const event = `payment_order.${orderStatus.status}`;
      const nextState = resolveNextSendState(event, send.state);
      if (!nextState) continue; // same status as last check, or not a recognized/forward-moving one

      await withTransaction(async (client) => {
        await sendsRepo.updateState(client, send.id, { state: nextState });
        await sendsRepo.logTransition(client, send.id, send.state, nextState, event, "paycrest_settlement_poller");
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
