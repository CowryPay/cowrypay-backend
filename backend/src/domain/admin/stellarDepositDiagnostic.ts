import { Horizon } from "@stellar/stellar-sdk";
import { env } from "../../config/env.js";
import { depositsRepo } from "../deposits/repository.js";
import { unmatchedStellarDepositsRepo } from "../deposits/unmatchedStellarDepositsRepository.js";
import { stellarCursorRepo } from "../../db/stellarCursorRepository.js";

export interface StellarPaymentDiagnostic {
  txHash: string;
  from: string;
  amount: string;
  createdAt: string;
  memo: string | null;
  memoType: string;
  // "credited": in the deposits table, the user got it.
  // "flagged-unmatched": scanner saw it, couldn't match a memo, sitting in
  // unmatched_stellar_deposits (visible via /admin/stellar/unmatched-deposits).
  // "UNACCOUNTED": in neither table — the scanner either hasn't reached it
  // yet (cursor lag) or something failed silently before it could record
  // this one either way. This is the real gap to chase.
  status: "credited" | "flagged-unmatched" | "UNACCOUNTED";
}

export interface StellarDepositDiagnosticResult {
  cursorLagLedgers: number | null;
  payments: StellarPaymentDiagnostic[];
}

// Real incident that motivated this: a user reported a Stellar deposit
// never credited that turned out to be neither of the two known
// unmatched-deposit rows already surfaced by /admin/stellar/unmatched-
// deposits — meaning either a third, not-yet-flagged gap, or the scanner
// missed it entirely (its cursor only ever advances past what fully
// succeeded, so one earlier silent failure could stall everything after
// it). This walks Horizon's own payment history directly — the ground
// truth — and cross-checks each one against both tables our own system
// would have recorded it in, rather than trusting either table alone.
export async function diagnoseStellarDeposits(lookback = 100): Promise<StellarDepositDiagnosticResult> {
  if (!env.stellarDepositAddress) {
    throw new Error("STELLAR_DEPOSIT_ADDRESS not configured");
  }
  const server = new Horizon.Server(env.stellarHorizonUrl);

  const [cursor, latestLedger, page] = await Promise.all([
    stellarCursorRepo.getCursor(),
    server.ledgers().order("desc").limit(1).call(),
    server
      .payments()
      .forAccount(env.stellarDepositAddress)
      .join("transactions")
      .order("desc")
      .limit(lookback)
      .call(),
  ]);

  // Horizon paging tokens encode ledger sequence in the high 32 bits (see
  // stellarDepositScanner.ts's own comment on this exact format) — decoding
  // the persisted cursor back to a ledger number gives a real "how far
  // behind is the scanner" figure, not just an opaque token comparison.
  let cursorLagLedgers: number | null = null;
  if (cursor) {
    const cursorLedger = Number(BigInt(cursor) >> 32n);
    const latestLedgerSeq = latestLedger.records[0]?.sequence;
    if (latestLedgerSeq != null) {
      cursorLagLedgers = latestLedgerSeq - cursorLedger;
    }
  }

  const payments: StellarPaymentDiagnostic[] = [];
  for (const op of page.records) {
    if (op.type !== "payment" || (op as any).to !== env.stellarDepositAddress) continue;
    if ((op as any).asset_type === "native" || (op as any).asset_code !== "USDC") continue;

    const tx = await (op as any).transaction();
    const [deposit, unmatched] = await Promise.all([
      depositsRepo.findByChainAndTxHash("stellar", op.transaction_hash),
      unmatchedStellarDepositsRepo.findByTxHash(op.transaction_hash),
    ]);

    payments.push({
      txHash: op.transaction_hash,
      from: (op as any).from,
      amount: (op as any).amount,
      createdAt: op.created_at,
      memo: tx.memo ?? null,
      memoType: tx.memo_type,
      status: deposit ? "credited" : unmatched ? "flagged-unmatched" : "UNACCOUNTED",
    });
  }

  return { cursorLagLedgers, payments };
}
