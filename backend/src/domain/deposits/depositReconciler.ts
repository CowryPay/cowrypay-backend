import { createPublicClient, parseAbiItem, formatUnits, http } from "viem";
import { env } from "../../config/env.js";
import { chainScanCursorRepo } from "../../db/chainScanCursorRepository.js";
import { walletsRepo } from "../wallets/repository.js";
import { getChainConfig, SUPPORTED_CHAINS } from "../wallets/chains.js";
import { ingestDeposit } from "./stateMachine.js";
import { fetchTransferLogsChunked } from "./depositLogQuery.js";
import { withAdvisoryLock } from "../../db/advisoryLock.js";
import { sendTelegramOpsAlert } from "../monitoring/telegram.js";
import type { Wallet } from "../../types.js";

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const RECONCILE_MAX_BLOCK_RANGE = 2000n;
const RECONCILE_CONFIRMATION_BUFFER = 2n;

// A second, independent pass over the same Transfer logs the deposit
// scanner (depositScanner.ts) already watches, deliberately NOT sharing its
// cursor. Why it exists: the scanner advances its cursor whenever a
// getLogs call *succeeds*, and a public RPC can succeed while silently
// truncating the reply (see depositLogQuery.ts's TRUNCATION_SUSPECT_LOG_COUNT)
// — so a deposit can be permanently invisible to the scanner. The separate,
// balance-based sweeper doesn't know about deposit rows at all, so it still
// moves that money to the payout key. Net result: user's deposit silently
// vanishes with no record (real incident, 2026-10-10).
//
// This rescan re-derives every inflow to a watched wallet over its OWN
// trailing window, re-ingests anything the scanner missed through the exact
// same idempotent ingestDeposit path (unique (chain, tx_hash) makes repeat
// scanning a guaranteed no-op, and screening still runs), and alerts on
// Telegram. It is deliberately redundant with the scanner for well-behaved
// RPCs — that redundancy is the whole point: at-least-one-catch coverage
// for a class of failure that would otherwise be silent and total.
export async function reconcileDeposits(): Promise<void> {
  const wallets = await walletsRepo.listByProvider("aws-kms");
  if (wallets.length === 0) return;

  await withAdvisoryLock("evm-deposit-reconcile", async () => {
    for (const chain of SUPPORTED_CHAINS) {
      try {
        await reconcileChain(chain, wallets);
      } catch (err) {
        console.error(`[deposit-reconciler] failed to reconcile ${chain}:`, err);
      }
    }
  });
}

async function reconcileChain(chain: string, wallets: Wallet[]): Promise<void> {
  const { viemChain, rpcUrl, tokens, nativeToken } = getChainConfig(chain);
  const watched = Object.entries(tokens).map(([symbol, cfg]) =>
    nativeToken?.symbol === symbol
      ? { address: nativeToken.transferLogAddress, symbol, decimals: cfg.decimals, logDecimals: viemChain.nativeCurrency.decimals }
      : { address: cfg.address, symbol, decimals: cfg.decimals, logDecimals: cfg.decimals },
  );
  const tokenAddresses = watched.map((t) => t.address);
  const tokenByAddress = new Map(watched.map((t) => [t.address.toLowerCase(), t]));
  const byAddress = new Map(wallets.map((w) => [w.address.toLowerCase(), w]));
  const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });

  const latestBlock = await client.getBlockNumber();
  const safeLatest = latestBlock - RECONCILE_CONFIRMATION_BUFFER;

  const cursorKey = `reconcile:${chain}`;
  const cursor = await chainScanCursorRepo.getCursor(cursorKey);
  // No reconciler cursor yet — start from now, same no-historical-backfill
  // stance as the scanner. The first pass catches anything the scanner has
  // missed since (re)deploy; older sweep-then-forget gaps are precisely the
  // incident this is meant to stop recurring, not to backfill manually.
  const fromBlock = cursor != null ? cursor + 1n : safeLatest;
  if (fromBlock > safeLatest) return;

  const toBlock = fromBlock + RECONCILE_MAX_BLOCK_RANGE < safeLatest ? fromBlock + RECONCILE_MAX_BLOCK_RANGE : safeLatest;

  // Same chunked-catch-up rule as the scanner (depositLogQuery.ts's
  // fetchTransferLogsChunked): a provider that only accepts narrow getLogs
  // spans is issued back-to-back chunks until the whole window is covered,
  // so the rescan keeps pace instead of advancing one span per 5-minute
  // cycle (a ~10-block Alchemy cap vs Celo/Base block production).
  const { logs, fetchedTo } = await fetchTransferLogsChunked(
    (f: bigint, t: bigint) =>
      client.getLogs({
        address: tokenAddresses,
        event: TRANSFER_EVENT,
        args: { to: wallets.map((w) => w.address as `0x${string}`) },
        fromBlock: f,
        toBlock: t,
      }),
    fromBlock,
    toBlock,
  );

  const corrected: string[] = [];
  let allHandled = true;
  for (const log of logs) {
    try {
      const wallet = byAddress.get(log.args.to!.toLowerCase());
      if (!wallet) continue; // shouldn't happen — filtered by the watchlist above
      const token = tokenByAddress.get(log.address.toLowerCase());
      if (!token) continue; // shouldn't happen — filtered by the address list above
      const value = log.args.value! / 10n ** BigInt(token.logDecimals - token.decimals);
      if (value === 0n && token.logDecimals !== token.decimals) continue; // sub-micro native dust, nothing to credit
      const result = await ingestDeposit({
        userId: wallet.userId,
        walletId: wallet.id,
        tokenSymbol: token.symbol,
        amount: formatUnits(value, token.decimals),
        chain,
        txHash: log.transactionHash,
      });
      // alreadyProcessed=false means this deposit row did NOT exist before
      // this run — i.e. exactly what the scanner was supposed to have
      // created and didn't. Everything else was a harmless repeat scan.
      if (!result.alreadyProcessed) {
        corrected.push(`• ${formatUnits(value, token.decimals)} ${token.symbol} on ${chain} (tx ${log.transactionHash}) — user ${wallet.userId}`);
      }
    } catch (err) {
      allHandled = false;
      console.error(`[deposit-reconciler] failed to ingest ${chain} (tx ${log.transactionHash}):`, err);
    }
  }

  // Same rule as the scanner: the rescan cursor only advances past what was
  // fully fetched AND ingested, so anything this run couldn't complete is
  // retried next cycle instead of being skipped.
  if (allHandled) {
    await chainScanCursorRepo.setCursor(cursorKey, fetchedTo);
  }

  if (corrected.length > 0) {
    console.log(
      `[deposit-reconciler] re-ingested ${corrected.length} deposit(s) on ${chain} the scanner had missed: ${corrected.join(" ")}`,
    );
    await sendTelegramOpsAlert(
      `<b>CowryPay deposit reconciler</b>\n\nThe scanner missed ${corrected.length} deposit(s) on ${chain.toUpperCase()} (RPC likely truncated a log range) — re-ingested and credited:\n\n${corrected.join("\n")}`,
    );
  }
}

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

// Same gate as depositScanner.ts's own startDepositScanner — this whole
// class of risk only exists for KMS-backed wallets. Runs once immediately
// (so a gap already in flight is caught right away, not up to 5 minutes
// later), then on a slow cadence.
export function startDepositReconciler(): void {
  if (env.walletProvider !== "aws-kms") return;
  const run = () => {
    reconcileDeposits().catch((err) => console.error("[deposit-reconciler]", err));
  };
  run();
  setInterval(run, RECONCILE_INTERVAL_MS);
}