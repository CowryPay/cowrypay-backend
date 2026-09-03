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

// Real incident (2026-09-03): a send sat in BRIDGING for 24+ hours with no
// alert at all — unlike STUCK, nothing pages ops when a row simply never
// progresses, so this was invisible until a user complained, by which
// point the attestation had aged out (see cctpBridge.ts's own comment on
// the MessageExpired/reAttest recovery this same incident motivated).
// updated_at only changes when advanceCrossChainSend actually calls
// updateStateIfCurrent (a genuine phase change) — a no-progress tick
// returns early without touching it — so it's the right signal for "how
// long has this been stuck," not created_at (which would also flag a
// send that's just slow for a normal reason) and not something requiring
// its own extra query (findPendingBridgeAttestations already returns
// exactly the rows this needs to check).
const BRIDGING_AGE_ALERT_MS = 30 * 60 * 1000; // FAST-mode attestation normally completes in seconds to a few minutes — generous margin, not a tight SLA

// Same "alert once on state change" pattern gasStatusMonitor.ts uses —
// avoids re-alerting every 30s while a row stays stuck, and clears once
// the row moves on (recovers, or becomes STUCK/COMPLETE and drops out of
// findPendingBridgeAttestations entirely).
const currentlyAgedBridging = new Set<string>();

async function checkAgedBridging(row: CrossChainSend): Promise<void> {
  if (row.state !== "BRIDGING") {
    currentlyAgedBridging.delete(row.id);
    return;
  }
  const ageMs = Date.now() - new Date(row.updatedAt).getTime();
  if (ageMs <= BRIDGING_AGE_ALERT_MS) {
    currentlyAgedBridging.delete(row.id);
    return;
  }
  if (currentlyAgedBridging.has(row.id)) return; // already alerted, still stuck
  currentlyAgedBridging.add(row.id);
  await sendTelegramOpsAlert(
    `<b>Cross-chain send stuck in BRIDGING</b>\n\nSend ${row.id} (${row.sourceChain} -> ${row.destinationChain}, ${row.amountHuman} ${row.tokenSymbol}): no progress for over ${Math.round(ageMs / 60_000)} minutes. The source burn is already confirmed. This usually means fetchAttestation is failing on every tick — check logs for "fetchAttestation failed" for this send. Needs manual review before the attestation ages out and becomes unmintable.`,
  );
}

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

  // Independent of advanceCrossChainSend below — must run even on a tick
  // where checkStatus keeps throwing (the exact failure mode that hid the
  // 2026-09-03 incident for 24+ hours), so it's its own loop/try-catch
  // rather than nested inside advanceCrossChainSend's own early returns.
  for (const row of bridging) {
    try {
      await checkAgedBridging(row);
    } catch (err) {
      console.error(`[cross-chain-send-poller] aged-BRIDGING check failed for send ${row.id}:`, err);
    }
  }

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
