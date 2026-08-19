import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { getReceiptStatus } from "../wallets/receiptStatus.js";
import { ledgerRepo } from "../ledger/repository.js";
import { sendsRepo } from "./repository.js";

// Closes the gap Phase 2 left open on purpose: aws-kms withdraw() broadcasts
// and returns immediately without waiting for on-chain confirmation (see
// awsKmsAdapter.ts), so nothing else would ever notice a send that later
// reverts — and critically, the user's balance was already debited up front
// and would never get refunded. This runs periodically (see index.ts) to
// close that loop.
export async function checkPendingWithdrawals(): Promise<void> {
  const pending = await sendsRepo.findPendingKmsWithdrawals();

  for (const send of pending) {
    try {
      if (!send.withdrawTxHash) continue; // findPendingKmsWithdrawals already filters this, guarding for TS
      const status = await getReceiptStatus(send.chain, send.withdrawTxHash);

      if (status === "pending") {
        continue; // not yet mined — try again next cycle
      }

      if (status === "success") {
        // State intentionally stays PAYOUT_INITIATED — mirrors Blockradar's
        // own withdraw.success webhook, which backfills confirmation but
        // never advances state itself; SETTLING/COMPLETE only ever come
        // from Paycrest's payment_order.* webhook (fiat settlement is a
        // separate concern from the on-chain broadcast succeeding).
        await withTransaction(async (client) => {
          await sendsRepo.markWithdrawConfirmed(client, send.id);
          await sendsRepo.logTransition(
            client,
            send.id,
            send.state,
            send.state,
            `kms_withdraw_confirmed:${send.withdrawTxHash}`,
          );
        });
        continue;
      }

      // status === "reverted" — a definitive, final on-chain outcome
      // (unlike the ambiguous "200, no hash yet" pending state that caused
      // the earlier Blockradar double-spend bug), so refunding and marking
      // FAILED automatically here is safe. CAS-guarded via
      // updateStateIfCurrent (same pattern already established in
      // sendStateTransition.ts's applyTerminalFailureTransition) — a
      // plain unconditional updateState here would let an overlapping
      // poller tick (a slow RPC call overrunning the 30s interval) credit
      // the same reverted send's refund twice.
      await withTransaction(async (client) => {
        const updated = await sendsRepo.updateStateIfCurrent(client, send.id, send.state, { state: "FAILED" });
        if (!updated) return; // lost the race — another tick already handled this
        await ledgerRepo.creditAvailable(client, send.userId, send.tokenSymbol, send.chain, send.amountHuman);
        await sendsRepo.logTransition(client, send.id, send.state, "FAILED", `kms_withdraw_reverted:${send.withdrawTxHash}`);
      });
    } catch (err) {
      // One bad entry (e.g. a transient RPC error) must not block the rest
      // of the batch from being checked this cycle.
      console.error(`[withdraw-confirmation-poller] failed to check send ${send.id}:`, err);
    }
  }
}

const POLL_INTERVAL_MS = 30_000;

// A complete no-op unless WALLET_PROVIDER=aws-kms is explicitly set — never
// the case on Railway/production today, so this never runs there.
export function startWithdrawConfirmationPoller(): void {
  if (env.walletProvider !== "aws-kms") return;
  setInterval(() => {
    checkPendingWithdrawals().catch((err) => console.error("[withdraw-confirmation-poller]", err));
  }, POLL_INTERVAL_MS);
}
