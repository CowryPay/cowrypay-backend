import { Horizon } from "@stellar/stellar-sdk";
import { env } from "../../config/env.js";
import { stellarCursorRepo } from "../../db/stellarCursorRepository.js";
import { walletsRepo } from "../wallets/repository.js";
import { stellarMemoRepo } from "../wallets/stellarMemoRepository.js";
import { unmatchedStellarDepositsRepo } from "./unmatchedStellarDepositsRepository.js";
import { ingestDeposit } from "./stateMachine.js";

const PAGE_SIZE = 50;

// No webhook exists for the shared Stellar account (nothing calls us), so
// this polls Horizon's payments-for-account endpoint on a cursor, mirroring
// depositScanner.ts's poll+cursor pattern for the EVM chains. The one real
// difference: deposits are matched by memo, not by address — every payment
// here lands on the same single shared account, so the memo is the only
// thing that says which user it belongs to.
export async function scanStellarDeposits(): Promise<void> {
  if (!env.stellarDepositAddress) return;

  const server = new Horizon.Server(env.stellarHorizonUrl);
  const cursor = await stellarCursorRepo.getCursor();

  const page = await server
    .payments()
    .forAccount(env.stellarDepositAddress)
    .join("transactions") // memo lives on the parent tx, not the operation — avoids an N+1 Horizon call per payment
    .cursor(cursor ?? "now") // no historical backfill, same as depositScanner.ts — only deposits from now forward matter
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
      const memoId = tx.memo_type === "id" && tx.memo != null ? BigInt(tx.memo) : null;
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
