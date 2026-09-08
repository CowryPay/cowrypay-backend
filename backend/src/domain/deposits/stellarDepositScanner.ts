import { Horizon } from "@stellar/stellar-sdk";
import { env } from "../../config/env.js";
import { stellarCursorRepo } from "../../db/stellarCursorRepository.js";
import { walletsRepo } from "../wallets/repository.js";
import { stellarMemoRepo } from "../wallets/stellarMemoRepository.js";
import { unmatchedStellarDepositsRepo } from "./unmatchedStellarDepositsRepository.js";
import { ingestDeposit } from "./stateMachine.js";
import { identifyStellarToken } from "../wallets/stellarAssets.js";
import { withAdvisoryLock } from "../../db/advisoryLock.js";
import { sendTelegramOpsAlert } from "../monitoring/telegram.js";

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
//
// Real incident (2026-09-08, plus a second one found on 2026-08-06 while
// investigating it): two genuinely valid, correctly-memoed deposits landed
// on our account and simply vanished — no deposits row, no
// unmatched_stellar_deposits row either, the scanner's cursor just moved
// past them. Both happened within minutes of a deploy. advisoryLock.ts's
// own comment already named the exact mechanism, just never closed it
// here: "Railway is pinned to 1 replica, but nothing in the repo enforces
// that" — a rolling deploy's brief old/new container overlap means two
// scanStellarDeposits() calls can race on the same shared cursor. If the
// OLD instance hits a transient failure partway through a page (so it
// never persists its own cursor past the point that failed) while the NEW
// instance concurrently processes the SAME page successfully and persists
// its cursor further ahead, the failed operation is never retried and
// never recorded anywhere — the NEW instance's cursor write makes it
// permanently unreachable on the next poll. Wrapped in the same
// withAdvisoryLock mechanism stellarAdapter.ts's own payment submission
// already uses for the identical class of risk (see that file's own
// comment) — only one instance can ever be mid-scan at a time now,
// anywhere in the fleet, regardless of replica count or deploy overlap.
export async function scanStellarDeposits(): Promise<void> {
  if (!env.stellarDepositAddress) return;
  return withAdvisoryLock("stellar-deposit-scan", () => scanStellarDepositsOnce());
}

async function scanStellarDepositsOnce(): Promise<void> {
  // Re-checked here (not just in the exported caller above) so TypeScript
  // can narrow it to a plain string for every use below — this function
  // is only ever reached via scanStellarDeposits(), which already
  // guarantees this, but that guarantee doesn't cross a function boundary.
  const depositAddress = env.stellarDepositAddress;
  if (!depositAddress) return;

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
    .forAccount(depositAddress)
    .join("transactions") // memo lives on the parent tx, not the operation — avoids an N+1 Horizon call per payment
    .cursor(cursor)
    .order("asc")
    .limit(PAGE_SIZE)
    .call();

  let lastToken = cursor;
  let allSucceeded = true;

  for (const op of page.records) {
    try {
      if (op.type !== "payment" || op.to !== depositAddress) {
        lastToken = op.paging_token;
        continue;
      }
      const tokenSymbol = op.asset_type === "native" ? null : identifyStellarToken(op.asset_code, op.asset_issuer);
      if (!tokenSymbol) {
        // Native XLM is genuinely out of scope, expected, silent. A
        // non-native asset we don't recognize is different: it's either a
        // real foreign asset (someone sent the wrong thing) or — the
        // failure mode this comment's own real incident showed can
        // happen — a legitimate, supported asset that failed to resolve
        // for some transient reason. Either way, the cursor still has to
        // advance past it (this function's whole contract is "never
        // re-check what's already been decided"), but it must never again
        // do so with zero trace. Alerted, not silently dropped.
        if (op.asset_type !== "native") {
          await sendTelegramOpsAlert(
            `<b>Unrecognized Stellar deposit asset</b>\n\nPayment ${op.transaction_hash} sent ${op.amount} ${op.asset_code}/${op.asset_issuer} to our deposit address — not a token this codebase recognizes (see stellarAssets.ts). If this looks like it should be supported, check why identifyStellarToken() didn't match it; this deposit's cursor is about to advance past it with no other record.`,
          ).catch((err) => console.error("[stellar-deposit-scanner] ops alert failed:", err));
        }
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
        tokenSymbol,
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
