import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { env } from "../../config/env.js";
import { chainScanCursorRepo } from "../../db/chainScanCursorRepository.js";
import { walletsRepo } from "../wallets/repository.js";
import { getChainConfig, SUPPORTED_CHAINS } from "../wallets/chains.js";
import type { Wallet } from "../../types.js";
import { ingestDeposit } from "./stateMachine.js";
import { withAdvisoryLock } from "../../db/advisoryLock.js";
import { fetchTransferLogsChunked } from "./depositLogQuery.js";

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// A public RPC will typically reject a huge block range in one getLogs
// call, and after any extended downtime the gap since the last scan could
// be large — capping the range per cycle lets it catch up over several
// cycles instead of failing outright.
const MAX_BLOCK_RANGE = 2000n;
// Most chains here finalize blocks quickly with no probabilistic reorgs
// (Celo's BFT consensus, the L2s' fast finality) — this buffer is cheap
// insurance rather than a response to any real reorg risk observed.
const CONFIRMATION_BUFFER = 2n;

async function scanChain(chain: string, wallets: Wallet[]): Promise<void> {
  const { viemChain, rpcUrl, tokens, nativeToken } = getChainConfig(chain);
  // Watches every token contract configured for this chain (USDC, and USDT
  // where supported) in one getLogs call — which contract a given log came
  // from determines the tokenSymbol/decimals used below, rather than that
  // being assumed regardless of which token actually moved. A token that's
  // also the native gas token (Arc's USDC) is watched via its native
  // transfer emitter INSTEAD of its ERC-20 contract — see chains.ts's Arc
  // entry for why the contract alone misses plain native sends.
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
  const safeLatest = latestBlock - CONFIRMATION_BUFFER;

  const cursor = await chainScanCursorRepo.getCursor(chain);
  // No cursor yet — start watching from now, deliberately no historical
  // backfill (only deposits from the moment this ships forward matter).
  const fromBlock = cursor != null ? cursor + 1n : safeLatest;
  if (fromBlock > safeLatest) return; // nothing new yet

  let toBlock = fromBlock + MAX_BLOCK_RANGE < safeLatest ? fromBlock + MAX_BLOCK_RANGE : safeLatest;

  // Real incident: MAX_BLOCK_RANGE (2000) assumes the RPC can handle wide
  // getLogs queries, but Alchemy's free tier enforces just 10 blocks —
  // once Celo's cursor fell even slightly behind, every cycle requested
  // more than that and failed, the cursor never advanced, and the
  // requested range only grew from there. A permanent stuck loop, not a
  // transient blip — it could never recover on its own. fetchTransferLogs
  // (depositLogQuery.ts) halves the range and retries on any getLogs
  // failure instead of trusting a fixed constant across every
  // provider/chain/plan, so it self-heals to whatever the real limit
  // actually is rather than needing that limit hardcoded (which would
  // just as fragilely break again if it ever changes, or differs for
  // Base/Optimism on the same Alchemy account). It additionally treats a
  // response pinned at the truncation-suspect cap as truncated rather than
  // trusted (public RPCs answer oversized requests with 200 + a partial
  // list — the exact shape that silently lost a real Base deposit on
  // 2026-10-10) and shrinks instead. fetchTransferLogsChunked keeps
  // issuing the provider-accepted span back-to-back until the whole
  // MAX_BLOCK_RANGE window is covered, so a 10-block cap can't make the
  // cursor fall behind Base's ~2s blocks forever (verified live: Alchemy
  // keyed RPC accepts only ~10-block eth_getLogs spans).
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

  // Cursor advances only as far as the logs we fully fetched AND ingested
  // (fetchedTo, which can be narrower than toBlock when the query had to
  // be shrunk) — a transient failure partway through means the whole range
  // is retried next cycle rather than silently skipping past a deposit.
  // Safe to retry: insertIfNew's (chain, tx_hash) unique constraint makes
  // re-ingesting an already-processed deposit a no-op.
  let allSucceeded = true;
  for (const log of logs) {
    try {
      const wallet = byAddress.get(log.args.to!.toLowerCase());
      if (!wallet) continue; // shouldn't happen — filtered by the watchlist above
      const token = tokenByAddress.get(log.address.toLowerCase());
      if (!token) continue; // shouldn't happen — filtered by the address list passed to getLogs above
      // Truncates a native-unit (18-decimal) value down to the token's own
      // precision, so the ledger never holds sub-micro-USDC dust that no
      // 6-decimal withdrawal/off-ramp could ever actually send. A no-op
      // (divide by 1) for every ordinary ERC-20.
      const value = log.args.value! / 10n ** BigInt(token.logDecimals - token.decimals);
      if (value === 0n && token.logDecimals !== token.decimals) continue; // sub-micro native dust, nothing to credit
      await ingestDeposit({
        userId: wallet.userId,
        walletId: wallet.id,
        tokenSymbol: token.symbol,
        amount: formatUnits(value, token.decimals),
        chain,
        txHash: log.transactionHash!,
      });
    } catch (err) {
      allSucceeded = false;
      console.error(`[deposit-scanner] failed to ingest deposit on ${chain} (tx ${log.transactionHash}):`, err);
    }
  }

  if (allSucceeded) {
    await chainScanCursorRepo.setCursor(chain, fetchedTo);
  }
}

// No webhook exists for self-custody deposit addresses (Blockradar's
// crediting is entirely webhook-driven — see routes/blockradarWebhook.ts —
// but nothing calls us for these), so this polls for Transfer events (any
// configured token — USDC, and USDT where supported) landing at any wallet
// this app itself watches, on every supported chain
// (one KMS key derives one address valid on all of them — see chains.ts),
// and feeds them into the exact same crediting path a webhook would
// (ingestDeposit), rather than a parallel one.
// Wrapped in the same withAdvisoryLock mechanism stellarDepositScanner.ts's
// own scanStellarDeposits() now uses, for the identical reason — see that
// file's own comment for the real incident (two valid deposits silently
// vanished — no deposits row, no fallback row anywhere) this class of bug
// caused there. This scanner has the exact same shape of risk: a batch's
// cursor only advances past what fully succeeded
// (chainScanCursorRepo.setCursor below), so two concurrent instances
// (Railway pinned to 1 replica, but never enforced — see advisoryLock.ts's
// own comment) racing on the same chain's cursor could let one instance's
// transient per-log failure be masked by another's success advancing the
// cursor past it, with that log never retried and never recorded. Not yet
// confirmed to have actually happened here (unlike the Stellar incident),
// but the mechanism is identical and this poller is confirmed actually
// running in production (WALLET_PROVIDER=aws-kms) — closed proactively
// rather than waiting for a matching incident on this path too.
export async function scanForDeposits(): Promise<void> {
  const wallets = await walletsRepo.listByProvider("aws-kms");
  if (wallets.length === 0) return;

  await withAdvisoryLock("evm-deposit-scan", async () => {
    for (const chain of SUPPORTED_CHAINS) {
      try {
        await scanChain(chain, wallets);
      } catch (err) {
        console.error(`[deposit-scanner] failed to scan ${chain}:`, err);
      }
    }
  });
}

const POLL_INTERVAL_MS = 30_000;

// A complete no-op unless WALLET_PROVIDER=aws-kms is explicitly set. This
// comment used to claim that's never the case on Railway/production — that
// was stale/wrong (confirmed live 2026-09-08: WALLET_PROVIDER=aws-kms IS
// set there), and this poller running concurrently with blockradarWebhook.ts
// against the same deposits was a real contributing factor in a double-
// credit incident that day — see stateMachine.ts's runScreening for the
// actual fix (both were always intended to converge safely on ingestDeposit,
// see this file's own comment above; the gap was a missing CAS guard on the
// credit step, not this poller running).
export function startDepositScanner(): void {
  if (env.walletProvider !== "aws-kms") return;
  setInterval(() => {
    scanForDeposits().catch((err) => console.error("[deposit-scanner]", err));
  }, POLL_INTERVAL_MS);
}
