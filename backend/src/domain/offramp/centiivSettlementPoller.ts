import { withTransaction } from "../../db/pool.js";
import { getOrderStatus } from "./centiivAdapter.js";
import { sendsRepo } from "./repository.js";

// Same safety net as paycrestSettlementPoller.ts / quidaxSettlementPoller.ts
// (a webhook silently never arriving is a proven real failure mode in this
// codebase, not theoretical) — except no webhook configuration was even
// found for Centiiv via their API (only their dashboard, which isn't
// reachable here), so this poller is the ONLY detection mechanism for
// Centiiv sends right now, not a backstop for one that also exists.
//
// Deliberately does not map any Centiiv `status` string to COMPLETE/FAILED
// — every real order created live during integration testing stayed
// "PENDING" (nothing was ever actually funded), so no terminal status
// string has been observed to build a real mapping from, and guessing one
// risks either never completing a real send or wrongly completing/failing
// one on a status that meant something else. Instead, uses the one signal
// that IS confirmed: metadata.rate starts null on every order and is
// presumably only populated once Centiiv has actually determined a real
// settlement rate — a fact directly observed on a real live order, not
// inferred. Every non-PENDING status is logged loudly regardless, so the
// real terminal string(s) can be read from production logs and this
// mapping tightened with actual evidence instead of another guess.
export async function pollPendingSettlements(): Promise<void> {
  const pending = await sendsRepo.findAwaitingSettlement("centiiv");

  for (const send of pending) {
    if (!send.providerOrderId) continue; // findAwaitingSettlement already filters this, guarding for TS
    try {
      const status = await getOrderStatus(send.providerOrderId);

      if (status.status !== "PENDING") {
        console.log(
          `[centiiv-settlement-poller] send ${send.id} (order ${send.providerOrderId}) has non-PENDING status "${status.status}" — no mapping exists for this yet, needs manual review. Full status: ${JSON.stringify(status)}`,
        );
      }

      if (status.rate == null) continue; // no settlement signal yet

      await withTransaction(async (client) => {
        await sendsRepo.updateState(client, send.id, { state: "COMPLETE", rate: status.rate });
        await sendsRepo.logTransition(
          client,
          send.id,
          send.state,
          "COMPLETE",
          `centiiv_rate_settled:${status.rate}`,
          "centiiv_settlement_poller",
        );
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
