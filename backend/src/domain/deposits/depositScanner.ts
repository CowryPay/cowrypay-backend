import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { env } from "../../config/env.js";
import { chainScanCursorRepo } from "../../db/chainScanCursorRepository.js";
import { walletsRepo } from "../wallets/repository.js";
import { getChainConfig, SUPPORTED_CHAINS } from "../wallets/chains.js";
import type { Wallet } from "../../types.js";
import { ingestDeposit } from "./stateMachine.js";

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
  const { viemChain, rpcUrl, tokens } = getChainConfig(chain);
  // Watches every token contract configured for this chain (USDC, and USDT
  // where supported) in one getLogs call — which contract a given log came
  // from determines the tokenSymbol/decimals used below, rather than that
  // being assumed regardless of which token actually moved.
  const tokenAddresses = Object.values(tokens).map((t) => t.address);
  const tokenByAddress = new Map(
    Object.entries(tokens).map(([symbol, cfg]) => [cfg.address.toLowerCase(), { symbol, decimals: cfg.decimals }]),
  );
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
  // transient blip — it could never recover on its own. Halves the range
  // and retries on any getLogs failure instead of trusting a fixed
  // constant across every provider/chain/plan, so it self-heals to
  // whatever the real limit actually is rather than needing that limit
  // hardcoded (which would just as fragilely break again if it ever
  // changes, or differs for Base/Optimism on the same Alchemy account).
  let logs;
  for (;;) {
    try {
      logs = await client.getLogs({
        address: tokenAddresses,
        event: TRANSFER_EVENT,
        args: { to: wallets.map((w) => w.address as `0x${string}`) },
        fromBlock,
        toBlock,
      });
      break;
    } catch (err) {
      if (toBlock <= fromBlock) throw err; // already as narrow as possible — a real failure, not a range problem
      toBlock = fromBlock + (toBlock - fromBlock) / 2n;
    }
  }

  // Cursor only advances if every log in this range is successfully
  // ingested — a transient failure partway through means the whole range
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
      await ingestDeposit({
        userId: wallet.userId,
        walletId: wallet.id,
        tokenSymbol: token.symbol,
        amount: formatUnits(log.args.value!, token.decimals),
        chain,
        txHash: log.transactionHash!,
      });
    } catch (err) {
      allSucceeded = false;
      console.error(`[deposit-scanner] failed to ingest deposit on ${chain} (tx ${log.transactionHash}):`, err);
    }
  }

  if (allSucceeded) {
    await chainScanCursorRepo.setCursor(chain, toBlock);
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
export async function scanForDeposits(): Promise<void> {
  const wallets = await walletsRepo.listByProvider("aws-kms");
  if (wallets.length === 0) return;

  for (const chain of SUPPORTED_CHAINS) {
    try {
      await scanChain(chain, wallets);
    } catch (err) {
      console.error(`[deposit-scanner] failed to scan ${chain}:`, err);
    }
  }
}

const POLL_INTERVAL_MS = 30_000;

// A complete no-op unless WALLET_PROVIDER=aws-kms is explicitly set — never
// the case on Railway/production today, so this never runs there.
export function startDepositScanner(): void {
  if (env.walletProvider !== "aws-kms") return;
  setInterval(() => {
    scanForDeposits().catch((err) => console.error("[deposit-scanner]", err));
  }, POLL_INTERVAL_MS);
}
