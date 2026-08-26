import { getTreasurySnapshot } from "../admin/treasury.js";
import { sendTelegramOpsAlert } from "./telegram.js";

// Alert-on-change, not every cycle — same reasoning and the same
// in-memory (resets on deploy/restart) cost as gasStatusMonitor.ts's own
// currentlyBreached. A SHORTFALL row means the shared operational wallet
// for that chain/token currently holds less than the ledger says users
// are owed, verified against a live on-chain read (see treasury.ts's
// computeReconciliation) — the exact thing an investor/auditor would
// otherwise have to take on trust from internal bookkeeping alone.
const currentlyBreached = new Set<string>();

function keyFor(row: { chain: string; tokenSymbol: string }): string {
  return `${row.chain}-${row.tokenSymbol}`;
}

// Deliberately does NOT alert on UNKNOWN rows (on-chain read failed) —
// that's an RPC/connectivity problem, a different failure class from an
// actual reserve shortfall, and treasury.ts's own safeBalance already
// surfaces read errors in the raw snapshot for anyone looking directly.
// This monitor's job is specifically "are we currently under-collateralized",
// not general RPC health.
export async function runReserveCheck(): Promise<void> {
  const { reconciliation } = await getTreasurySnapshot();

  const newlyBreached = reconciliation.filter((r) => r.status === "SHORTFALL" && !currentlyBreached.has(keyFor(r)));
  const recovered = reconciliation.filter((r) => r.status === "OK" && currentlyBreached.has(keyFor(r)));

  for (const r of newlyBreached) currentlyBreached.add(keyFor(r));
  for (const r of recovered) currentlyBreached.delete(keyFor(r));

  if (newlyBreached.length > 0) {
    const lines = newlyBreached.map((r) => {
      const base = `⚠️ <b>${r.chain} ${r.tokenSymbol}</b>: owe ${r.ledgerLiability}, hold ${r.onChainBalance} (short ${r.deltaUsdc})`;
      return r.note ? `${base}\n<i>${r.note}</i>` : base;
    });
    await sendTelegramOpsAlert(`<b>CowryPay reserve shortfall</b>\n\n${lines.join("\n\n")}`);
  }
  if (recovered.length > 0) {
    const lines = recovered.map((r) => `✅ <b>${r.chain} ${r.tokenSymbol}</b>: back to fully covered`);
    await sendTelegramOpsAlert(`<b>CowryPay reserve shortfall resolved</b>\n\n${lines.join("\n")}`);
  }
}

const CHECK_INTERVAL_MS = 10 * 60_000;

export function startReserveMonitor(): void {
  setInterval(() => {
    runReserveCheck().catch((err) => console.error("[reserve-monitor]", err));
  }, CHECK_INTERVAL_MS);
}
