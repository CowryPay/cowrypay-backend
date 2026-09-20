import { adminRepo } from "../admin/repository.js";
import { getTreasurySnapshot } from "../admin/treasury.js";
import { sendTelegramOpsAlert } from "./telegram.js";

// Alert-on-change, not every cycle — persisted via reserve_shortfall_alerts
// (migration 0023), not an in-memory Set. Real incident (2026-09-14): an
// in-memory "currently breached" Set (same mistake doubleCreditMonitor.ts
// already made, see migration 0021) resets on every deploy, so an
// already-known, already-explained shortfall — e.g. Stellar's ~1.66 USDC
// gap, entirely accounted for by three sends where the platform fee was
// already swept on-chain before the provider refunded them (see
// treasury.ts's KNOWN_WRITE_OFFS) — re-"discovered" itself as newly
// breached and re-alerted on Telegram after every single deploy.
//
// Tracked by delta, not just presence, so a chain/token already known to
// be short by $X still alerts again if it gets WORSE than $X — a new,
// undiagnosed problem stacking on top of an already-explained one must
// never go silent just because that chain/token was already in the
// table. Below this threshold, a change is float/decimal noise, not a
// new problem — same reasoning as offramp/refundVerification.ts's own
// AMOUNT_TOLERANCE, just coarser since this is "did a new incident
// happen", not "does this exact transfer match".
const WORSENED_THRESHOLD_USDC = 0.01;

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
  const alerted = await adminRepo.getAlertedShortfalls();

  const newlyBreached = reconciliation.filter((r) => {
    if (r.status !== "SHORTFALL" || r.deltaUsdc == null) return false;
    const lastAlertedDelta = alerted.get(keyFor(r));
    // Never alerted before, or the shortfall has gotten meaningfully worse
    // since the last alert — either way this is new information.
    return lastAlertedDelta === undefined || Number(r.deltaUsdc) < lastAlertedDelta - WORSENED_THRESHOLD_USDC;
  });
  const recovered = reconciliation.filter((r) => r.status === "OK" && alerted.has(keyFor(r)));

  for (const r of newlyBreached) await adminRepo.upsertShortfallAlert(r.chain, r.tokenSymbol, Number(r.deltaUsdc));
  for (const r of recovered) await adminRepo.clearShortfallAlert(r.chain, r.tokenSymbol);

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

// Widened from 10 to 20 minutes (2026-09-19, Supabase egress reduction) —
// a genuine reserve shortfall builds up gradually over many sends, not
// instantly, and this only alerts on a real change anyway (see
// getAlertedShortfalls above): the 10 extra minutes of detection lag has
// no real effect on outcomes, but halves this job's database round trips
// over a day.
const CHECK_INTERVAL_MS = 20 * 60_000;

export function startReserveMonitor(): void {
  setInterval(() => {
    runReserveCheck().catch((err) => console.error("[reserve-monitor]", err));
  }, CHECK_INTERVAL_MS);
}
