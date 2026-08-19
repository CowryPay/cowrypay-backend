import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { getReceiptStatus } from "../wallets/receiptStatus.js";
import { ledgerRepo } from "../ledger/repository.js";
import { cryptoWithdrawalsRepo } from "./repository.js";

// Mirrors offramp/withdrawConfirmationPoller.ts almost exactly — same gap
// to close (aws-kms withdraw() broadcasts and returns before on-chain
// confirmation, see awsKmsAdapter.ts), same "reverted is a definitive final
// outcome, safe to auto-refund" reasoning. One real difference: a crypto
// withdrawal has no further off-chain leg the way a `send` has Paycrest
// settlement — once it's confirmed on-chain, it IS done, so this actually
// advances state to CONFIRMED (terminal) rather than leaving it parked the
// way sends deliberately stay at PAYOUT_INITIATED pending a separate
// fiat-settlement webhook.
export async function checkPendingCryptoWithdrawals(): Promise<void> {
  const pending = await cryptoWithdrawalsRepo.findPendingKmsWithdrawals();

  for (const withdrawal of pending) {
    try {
      if (!withdrawal.withdrawTxHash) continue; // findPendingKmsWithdrawals already filters this, guarding for TS
      const status = await getReceiptStatus(withdrawal.chain, withdrawal.withdrawTxHash);

      if (status === "pending") {
        continue; // not yet mined — try again next cycle
      }

      if (status === "success") {
        await withTransaction(async (client) => {
          await cryptoWithdrawalsRepo.markWithdrawConfirmed(client, withdrawal.id);
          await cryptoWithdrawalsRepo.updateState(client, withdrawal.id, { state: "CONFIRMED" });
          await cryptoWithdrawalsRepo.logTransition(
            client,
            withdrawal.id,
            withdrawal.state,
            "CONFIRMED",
            `kms_withdraw_confirmed:${withdrawal.withdrawTxHash}`,
          );
        });
        continue;
      }

      // status === "reverted" — definitive and final, safe to auto-refund.
      // CAS-guarded: an overlapping poller tick (e.g. a slow RPC call
      // overrunning the 30s interval) could otherwise read this same
      // still-BROADCAST row twice and credit the ledger twice for one
      // reverted withdrawal.
      await withTransaction(async (client) => {
        const updated = await cryptoWithdrawalsRepo.updateStateIfCurrent(client, withdrawal.id, withdrawal.state, {
          state: "FAILED",
        });
        if (!updated) return; // lost the race — another tick already handled this
        await ledgerRepo.creditAvailable(client, withdrawal.userId, withdrawal.tokenSymbol, withdrawal.chain, withdrawal.amountHuman);
        await cryptoWithdrawalsRepo.logTransition(
          client,
          withdrawal.id,
          withdrawal.state,
          "FAILED",
          `kms_withdraw_reverted:${withdrawal.withdrawTxHash}`,
        );
      });
    } catch (err) {
      // One bad entry (e.g. a transient RPC error) must not block the rest
      // of the batch from being checked this cycle.
      console.error(`[crypto-withdrawal-confirmation-poller] failed to check withdrawal ${withdrawal.id}:`, err);
    }
  }
}

const POLL_INTERVAL_MS = 30_000;

// Same gating as withdrawConfirmationPoller.ts — a no-op unless
// WALLET_PROVIDER=aws-kms, since only that adapter broadcasts without
// waiting for confirmation.
export function startCryptoWithdrawalConfirmationPoller(): void {
  if (env.walletProvider !== "aws-kms") return;
  setInterval(() => {
    checkPendingCryptoWithdrawals().catch((err) => console.error("[crypto-withdrawal-confirmation-poller]", err));
  }, POLL_INTERVAL_MS);
}
