import { withTransaction } from "../../db/pool.js";
import type { SendState } from "../../types.js";
import { getOrderStatus } from "./centiivAdapter.js";
import { sendsRepo } from "./repository.js";
import { applyTerminalFailureTransition, resolveNextSendState } from "./sendStateTransition.js";

// Same safety net as paycrestSettlementPoller.ts / quidaxSettlementPoller.ts
// (a webhook silently never arriving is a proven real failure mode in this
// codebase, not theoretical) — except no webhook configuration was even
// found for Centiiv via their API (only their dashboard, which isn't
// reachable here), so this poller is the ONLY detection mechanism for
// Centiiv sends right now, not a backstop for one that also exists.
//
// Real incident that replaced the original "rate populated = settled"
// heuristic this file used to use: a live UGX/Base order had a real rate
// in metadata.rate (3697.343) despite Centiiv's own status for it being
// REFUNDED, not fulfilled — the send sat as COMPLETE in our system for
// almost a day before that was caught. FULFILLED and REFUNDED (below) are
// both real status strings read directly from Centiiv's live API for
// actual orders, not guessed. Anything else is logged loudly rather than
// assumed, same conservative stance as before.
const STATUS_STATE_MAP: Partial<Record<string, SendState>> = {
  FULFILLED: "COMPLETE",
  REFUNDED: "REFUNDED",
};

export async function pollPendingSettlements(): Promise<void> {
  const pending = await sendsRepo.findAwaitingSettlement("centiiv");

  for (const send of pending) {
    if (!send.providerOrderId) continue; // findAwaitingSettlement already filters this, guarding for TS
    try {
      const status = await getOrderStatus(send.providerOrderId);
      const nextState = resolveNextSendState(STATUS_STATE_MAP, status.status, send.state);

      if (!nextState) {
        if (status.status !== "PENDING") {
          console.log(
            `[centiiv-settlement-poller] send ${send.id} (order ${send.providerOrderId}) has unmapped status "${status.status}" — needs manual review. Full status: ${JSON.stringify(status)}`,
          );
        }
        continue;
      }

      // Real incident: a live order's status said "REFUNDED" while its own
      // fulfillments array showed Centiiv had actually paid the recipient
      // in full — confirmed by the payout amount matching this order's
      // amount at their own quoted rate almost exactly. Auto-crediting the
      // user in that case would double-pay them (real fiat already landed
      // in their bank AND their CowryPay balance restored) — held for
      // manual review instead, same conservative stance Quidax's poller
      // already takes for its own less-trustworthy status field.
      if ((nextState === "FAILED" || nextState === "REFUNDED") && status.fulfillments.length > 0) {
        console.error(
          `[centiiv-settlement-poller] send ${send.id} (order ${send.providerOrderId}) has status "${status.status}" but a non-empty fulfillments array — Centiiv's own data contradicts itself. NOT auto-crediting; needs manual review. Fulfillments: ${JSON.stringify(status.fulfillments)}`,
        );
        continue;
      }

      await withTransaction(async (client) => {
        if (nextState === "FAILED" || nextState === "REFUNDED") {
          // Credits the user back the full original amount, same policy as
          // Paycrest/Quidax/Blockradar (see sendStateTransition.ts) — a
          // deliberate choice even knowing Centiiv's own "refunded" claim
          // doesn't always mean the crypto actually came back to us; that
          // gap gets chased down against Centiiv separately, not left for
          // the user to eat.
          await applyTerminalFailureTransition(client, send, nextState, `status:${status.status}`, "centiiv_settlement_poller");
        } else {
          await sendsRepo.updateState(client, send.id, { state: nextState, rate: status.rate });
          await sendsRepo.logTransition(
            client,
            send.id,
            send.state,
            nextState,
            `status:${status.status}`,
            "centiiv_settlement_poller",
          );
        }
      });
    } catch (err) {
      // One bad lookup (e.g. a transient Centiiv API error) must not block
      // the rest of the batch from being checked this cycle.
      console.error(`[centiiv-settlement-poller] failed to check send ${send.id}:`, err);
    }
  }
}

const POLL_INTERVAL_MS = 60_000;

export function startCentiivSettlementPoller(): void {
  setInterval(() => {
    pollPendingSettlements().catch((err) => console.error("[centiiv-settlement-poller]", err));
  }, POLL_INTERVAL_MS);
}
