import { Horizon } from "@stellar/stellar-sdk";
import { env } from "../../config/env.js";
import { stellarCursorRepo } from "../../db/stellarCursorRepository.js";
import { walletsRepo } from "../wallets/repository.js";
import { stellarMemoRepo } from "../wallets/stellarMemoRepository.js";
import { unmatchedStellarDepositsRepo } from "./unmatchedStellarDepositsRepository.js";
import { ingestDeposit } from "./stateMachine.js";

const PAGE_SIZE = 50;

// Accepts the proper MEMO_ID type as-is, but also a text-type memo that
// parses cleanly as a non-negative integer — confirmed via a real live
// test that some wallets/exchanges only expose a single generic "Memo"
// field with no way to explicitly pick MEMO_ID, so a user typing the
// exact right number can still end up with memo_type "text" through no
// fault of their own. No new ambiguity from allowing this: memo_ids are
// unique regardless of which on-chain memo type carried them.
function resolveMemoId(tx: { memo_type: string; memo?: string }): bigint | null {
  if ((tx.memo_type !== "id" && tx.memo_type !== "text") || tx.memo == null) return null;
  if (!/^\d+$/.test(tx.memo)) return null;
  try {
    return BigInt(tx.memo);
  } catch {
    return null;
  }
}

// No webhook exists for the shared Stellar account (nothing calls us), so
// this polls Horizon's payments-for-account endpoint on a cursor, mirroring
// depositScanner.ts's poll+cursor pattern for the EVM chains. The one real
// difference: deposits are matched by memo, not by address — every payment
// here lands on the same single shared account, so the memo is the only
// thing that says which user it belongs to.
export async function scanStellarDeposits(): Promise<void> {
  if (!env.stellarDepositAddress) return;

  const server = new Horizon.Server(env.stellarHorizonUrl);
  let cursor = await stellarCursorRepo.getCursor();

  if (cursor == null) {
    // Bootstrap once, on the very first-ever poll. Horizon's "now" cursor
    // keyword is NOT a stable, reusable token — it re-resolves to whatever
    // moment a call happens to land on. Using it directly as the poll
    // cursor (the original version of this code did) meant every empty
    // poll cycle re-asked for a fresh "now" instead of persisting one,
    // silently dropping anything that landed in the gap between two
    // 30s-apart polls. A ledger-sequence-derived cursor (documented Horizon
    // format: ledger sequence in the high 32 bits, 0 in the low bits) is a
    // real, stable paging token — computed once here, then persisted
    // immediately so every cycle after this one advances from a fixed
    // point instead of a moving target.
    const latestLedger = await server.ledgers().order("desc").limit(1).call();
    const ledgerSeq = latestLedger.records[0]?.sequence ?? 0;
    cursor = (BigInt(ledgerSeq) << 32n).toString();
    await stellarCursorRepo.setCursor(cursor);
  }

  const page = await server
    .payments()
    .forAccount(env.stellarDepositAddress)
    .join("transactions") // memo lives on the parent tx, not the operation — avoids an N+1 Horizon call per payment
    .cursor(cursor)
    .order("asc")
    .limit(PAGE_SIZE)
    .call();

  let lastToken = cursor;
  let allSucceeded = true;

  for (const op of page.records) {
    try {
      if (op.type !== "payment" || op.to !== env.stellarDepositAddress) {
        lastToken = op.paging_token;
        continue;
      }
      if (op.asset_type === "native" || op.asset_code !== "USDC" || op.asset_issuer !== env.stellarUsdcIssuer) {
        // Not USDC (native XLM, or some other asset/issuer) — out of scope
        // per the current USDC-only decision. Cursor still advances past it
        // so it's never re-checked.
        lastToken = op.paging_token;
        continue;
      }

      const tx = await op.transaction(); // resolves from the embedded join above, no extra HTTP call
      const memoId = resolveMemoId(tx);
      const match = memoId != null ? await stellarMemoRepo.findByMemoId(memoId) : null;

      if (!match) {
        await unmatchedStellarDepositsRepo.insertIfNew({
          txHash: op.transaction_hash,
          fromAddress: op.from,
          amount: op.amount,
          rawMemo: tx.memo ?? null,
          memoType: tx.memo_type,
        });
        lastToken = op.paging_token;
        continue;
      }

      const wallet = await walletsRepo.findByUserIdAndChain(match.userId, "stellar");
      if (!wallet) {
        // A memo exists with no corresponding wallet row — a data-integrity
        // gap (memo allocation and wallet creation happen as two separate
        // calls, see stellarAdapter.createWallet), not something a retry
        // would fix. Logged, not thrown, so the rest of the batch still
        // processes; doesn't advance the cursor past this one so it's
        // retried until someone notices and fixes the gap.
        console.error(`[stellar-deposit-scanner] memo ${memoId} matched user ${match.userId} but no stellar wallet row exists`);
        allSucceeded = false;
        continue;
      }

      await ingestDeposit({
        userId: match.userId,
        walletId: wallet.id,
        tokenSymbol: "USDC",
        amount: op.amount,
        chain: "stellar",
        txHash: op.transaction_hash,
      });
      lastToken = op.paging_token;
    } catch (err) {
      allSucceeded = false;
      console.error(`[stellar-deposit-scanner] failed to process operation ${op.id}:`, err);
    }
  }

  // Cursor only advances past what fully succeeded — a transient failure
  // partway through means the whole remaining range is retried next cycle
  // rather than silently skipping past a deposit. Safe to retry:
  // ingestDeposit's (chain, tx_hash) uniqueness makes re-ingesting a no-op.
  if (allSucceeded && lastToken) {
    await stellarCursorRepo.setCursor(lastToken);
  }
}

const POLL_INTERVAL_MS = 30_000;

export function startStellarDepositScanner(): void {
  if (!env.stellarDepositsEnabled) return;
  setInterval(() => {
    scanStellarDeposits().catch((err) => console.error("[stellar-deposit-scanner]", err));
  }, POLL_INTERVAL_MS);
}
