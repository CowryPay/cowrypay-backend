import { adminRepo } from "../admin/repository.js";
import { sendTelegramOpsAlert } from "./telegram.js";

// Seeded with the two real cases already found and handled before this
// monitor existed (see the deposit-screening race fixed in
// stateMachine.ts's runScreening) — otherwise the first run here would
// immediately re-alert on something already known, including one case
// already corrected. Resets on deploy/restart — same acceptable tradeoff
// gasStatusMonitor.ts's own currentlyBreached set already makes: at most
// one avoidable re-alert right after a deploy, never an ongoing spam risk.
const alreadyAlerted = new Set<string>([
  "95730b99-c809-423a-a9fa-5a336717550d",
  "519dfd50-73c2-461f-843f-7a05d0ce032e",
]);

// Detection, not prevention — the actual race that caused this is closed
// structurally now (runScreening's CAS guard makes double-crediting via
// that mechanism impossible, not just unlikely). This exists as a second
// layer: it checks the SYMPTOM (a deposit credited more than once)
// regardless of cause, so a different future bug producing the same
// outcome gets caught within minutes instead of sitting unnoticed until a
// user reports a wrong balance again.
export async function runDoubleCreditCheck(): Promise<void> {
  const affected = await adminRepo.findDoubleCreditedDeposits();
  const newlyFound = affected.filter((d) => !alreadyAlerted.has(d.depositId));
  if (newlyFound.length === 0) return;

  for (const d of newlyFound) alreadyAlerted.add(d.depositId);

  const lines = newlyFound.map(
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
