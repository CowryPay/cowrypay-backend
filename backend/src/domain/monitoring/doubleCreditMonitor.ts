import { adminRepo } from "../admin/repository.js";
import { sendTelegramOpsAlert } from "./telegram.js";

// Detection, not prevention — the actual race that caused this is closed
// structurally now (runScreening's CAS guard makes double-crediting via
// that mechanism impossible, not just unlikely — plus the advisory-lock
// fix on both deposit scanners for the separate concurrent-scan race
// found 2026-09-08). This exists as a second layer: it checks the
// SYMPTOM (a deposit credited more than once) regardless of cause, so a
// different future bug producing the same outcome gets caught within
// minutes instead of sitting unnoticed until a user reports a wrong
// balance again.
//
// "Already alerted" is persisted (double_credit_alerts table, migration
// 0021) — real incident (2026-09-08): this used to be an in-memory Set,
// which reset on every deploy. findDoubleCreditedDeposits' underlying
// signal is a permanent historical fact (a deposit's deposit_state_
// transitions row count for BALANCE_CREDITED, which never goes back down
// once it's >1, even after the balance is manually corrected) — so every
// deploy's first check re-"discovered" every already-known, already-fixed
// deposit as new and re-alerted on Telegram, forever. Unlike
// gasStatusMonitor.ts's own in-memory set (a transient gas dip that
// naturally stops recurring, so a reset costs at most one avoidable
// re-alert), this signal never resolves itself — an in-memory set here
// meant a genuine forever-repeating false alarm after every single
// deploy, not a one-off.
export async function runDoubleCreditCheck(): Promise<void> {
  const affected = await adminRepo.findDoubleCreditedDeposits();
  if (affected.length === 0) return;

  const newlyFound = await adminRepo.filterUnalertedDoubleCredits(affected.map((d) => d.depositId));
  if (newlyFound.length === 0) return;

  const newRows = affected.filter((d) => newlyFound.includes(d.depositId));

  // Marked BEFORE sending, not after — a Telegram failure must never
  // leave this un-marked and re-attempted forever on a genuinely
  // unreachable send; the alert itself getting lost is a smaller problem
  // than re-alerting every 5 minutes indefinitely (sendTelegramOpsAlert's
  // own errors are swallowed internally already, see telegram.ts, so this
  // call can't actually throw either way — belt and suspenders).
  await adminRepo.markDoubleCreditsAlerted(newlyFound);

  const lines = newRows.map(
    (d) =>
      `🚨 Deposit <code>${d.depositId}</code> (${d.chain}, tx <code>${d.txHash}</code>) credited ${d.creditCount}x — user <code>${d.userId}</code>, amount ${d.amount}. Check GET /admin/deposits/by-hash?chain=${d.chain}&txHash=${d.txHash} and correct via POST /admin/users/${d.userId}/adjust-ledger if the user hasn't already spent it.`,
  );
  await sendTelegramOpsAlert(`<b>CowryPay double-credit detected</b>\n\n${lines.join("\n\n")}`);
}

const CHECK_INTERVAL_MS = 5 * 60_000;

export function startDoubleCreditMonitor(): void {
  setInterval(() => {
    runDoubleCreditCheck().catch((err) => console.error("[double-credit-monitor]", err));
  }, CHECK_INTERVAL_MS);
}
