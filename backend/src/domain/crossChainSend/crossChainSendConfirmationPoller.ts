import { withTransaction } from "../../db/pool.js";
import type { CrossChainSend, CrossChainSendState } from "../../types.js";
import { ledgerRepo } from "../ledger/repository.js";
import { sendTelegramOpsAlert } from "../monitoring/telegram.js";
import { getBridgeAdapter } from "./bridge/index.js";
import { crossChainSendsRepo } from "./repository.js";

const PHASE_TO_STATE: Record<string, CrossChainSendState> = {
  SOURCE_PENDING: "SOURCE_BROADCAST",
  SOURCE_CONFIRMED: "SOURCE_CONFIRMED",
  ATTESTATION_PENDING: "BRIDGING",
  DESTINATION_PENDING: "DESTINATION_BROADCAST",
  DESTINATION_CONFIRMED: "COMPLETE",
};

// Single idempotent state-advancer, called on every poller tick for every
// non-terminal row regardless of which phase it's currently in — the
// underlying BridgeAdapter.checkStatus (cctpAdapter.ts's cctpEvm.ts
// implementation) already does "check as far as safely possible and take
// whatever action that implies" internally, so this function's only job
// is mapping whatever phase comes back onto this row's CAS-guarded DB
// state, and deciding refund-safety.
//
// The critical safety line: `row.state === "SOURCE_BROADCAST"` is the
// ONLY state a real refund (ledgerRepo.creditAvailable) is allowed to
// fire from. Once a row has left that state even once, the source-chain
// burn/lock is confirmed and final — every failure after that becomes
// STUCK, never FAILED, and is never auto-credited back (see the plan's
// own risk-handling section for why: a CCTP burn can't be silently
// un-burned, the only way to make the user whole is to keep retrying the
// destination-side completion).
async function advanceCrossChainSend(row: CrossChainSend): Promise<void> {
  const bridge = getBridgeAdapter(row.sourceChain, row.destinationChain);
  const reference = { ...(row.bridgeReference ?? {}), destinationTxHash: row.destinationTxHash ?? undefined };

  let result;
  try {
    result = await bridge.checkStatus(reference);
  } catch (err) {
    // Transient (RPC error, attestation API hiccup) — retry next tick, no
    // state change. Mirrors every other poller in this codebase's
    // per-item try/catch so one bad row never blocks the rest of the batch.
    console.error(`[cross-chain-send-poller] checkStatus failed for send ${row.id}:`, err);
    return;
  }

  const sourceAlreadyConfirmed = row.state !== "SOURCE_BROADCAST";

  if (result.phase === "FAILED") {
    if (!sourceAlreadyConfirmed) {
      // Source leg itself reverted — nothing irreversible happened, safe
      // to auto-refund exactly like a same-chain broadcast failure.
      await withTransaction(async (client) => {
        const updated = await crossChainSendsRepo.updateStateIfCurrent(client, row.id, row.state, { state: "FAILED" });
        if (!updated) return; // lost the race to another tick
        await ledgerRepo.creditAvailable(client, row.userId, row.tokenSymbol, row.sourceChain, row.amountHuman);
        await crossChainSendsRepo.logTransition(client, row.id, row.state, "FAILED", result.detail ?? "source_leg_failed");
      });
      return;
    }

    // Destination leg failed after the source burn already confirmed —
    // STUCK, not FAILED. Never credits the ledger. Keeps getting retried
    // on future ticks (checkStatus re-attempts the destination
    // completion from wherever it left off) until it either completes or
    // an admin resolves it via the manual-refund escape hatch.
    const wasAlreadyStuck = row.state === "STUCK";
    await withTransaction(async (client) => {
      const updated = await crossChainSendsRepo.updateStateIfCurrent(client, row.id, row.state, {
        state: "STUCK",
        destinationTxHash: result.destinationTxHash ?? null,
      });
      if (!updated) return;
      await crossChainSendsRepo.logTransition(client, row.id, row.state, "STUCK", result.detail ?? "destination_leg_failed");
    });
    if (!wasAlreadyStuck) {
      await sendTelegramOpsAlert(
        `<b>Cross-chain send STUCK</b>\n\nSend ${row.id} (${row.sourceChain} -> ${row.destinationChain}, ${row.amountHuman} ${row.tokenSymbol}): source leg confirmed but the destination leg failed (${result.detail ?? "no detail"}). Ledger was NOT refunded — the burned funds are only recoverable by completing the bridge. Needs manual review.`,
      );
    }
    return;
  }

  const nextState = PHASE_TO_STATE[result.phase];
  if (!nextState || nextState === row.state) return; // no progress this tick

  await withTransaction(async (client) => {
    const updated = await crossChainSendsRepo.updateStateIfCurrent(client, row.id, row.state, {
      state: nextState,
      destinationTxHash: result.destinationTxHash ?? null,
      sourceConfirmedAt: row.state === "SOURCE_BROADCAST",
      destinationConfirmedAt: nextState === "COMPLETE",
    });
    if (!updated) return; // lost the race to another tick
    await crossChainSendsRepo.logTransition(client, row.id, row.state, nextState, result.detail ?? `phase:${result.phase}`);
  });
}

export async function checkPendingCrossChainSends(): Promise<void> {
  const [sourcePending, bridging, destinationPending, stuck] = await Promise.all([
    crossChainSendsRepo.findPendingSourceConfirmations(),
    crossChainSendsRepo.findPendingBridgeAttestations(),
    crossChainSendsRepo.findPendingDestinationConfirmations(),
    crossChainSendsRepo.findStuck(),
  ]);

  for (const row of [...sourcePending, ...bridging, ...destinationPending, ...stuck]) {
    try {
      await advanceCrossChainSend(row);
    } catch (err) {
      console.error(`[cross-chain-send-poller] failed to advance send ${row.id}:`, err);
    }
  }
}

const POLL_INTERVAL_MS = 30_000;

export function startCrossChainSendConfirmationPoller(): void {
  setInterval(() => {
    checkPendingCrossChainSends().catch((err) => console.error("[cross-chain-send-poller]", err));
  }, POLL_INTERVAL_MS);
}
