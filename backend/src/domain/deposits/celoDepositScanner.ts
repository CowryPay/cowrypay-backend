import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { celo } from "viem/chains";
import { env } from "../../config/env.js";
import { chainScanCursorRepo } from "../../db/chainScanCursorRepository.js";
import { walletsRepo } from "../wallets/repository.js";
import { ingestDeposit } from "./stateMachine.js";

// Recovered from this repo's history, same address used throughout the
// self-custody migration (see awsKmsAdapter.ts) — confirmed on-chain.
const CELO_USDC_ADDRESS = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const;
const USDC_DECIMALS = 6;
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// A public RPC will typically reject a huge block range in one getLogs
// call, and after any extended downtime the gap since the last scan could
// be large — capping the range per cycle lets it catch up over several
// cycles instead of failing outright.
const MAX_BLOCK_RANGE = 2000n;
// Celo's BFT consensus finalizes blocks immediately (no probabilistic
// reorgs like proof-of-work chains) — this buffer is cheap insurance
// rather than a response to any real reorg risk observed here.
const CONFIRMATION_BUFFER = 2n;

// No webhook exists for self-custody deposit addresses (Blockradar's
// crediting is entirely webhook-driven — see routes/blockradarWebhook.ts —
// but nothing calls us for these), so this polls for USDC Transfer events
// landing at any wallet this app itself watches, and feeds them into the
// exact same crediting path a webhook would (ingestDeposit), rather than a
// parallel one.
export async function scanForDeposits(): Promise<void> {
  const wallets = await walletsRepo.listByProvider("aws-kms");
  if (wallets.length === 0) return;

  const byAddress = new Map(wallets.map((w) => [w.address.toLowerCase(), w]));
  const client = createPublicClient({ chain: celo, transport: http(env.celoRpcUrl) });

  const latestBlock = await client.getBlockNumber();
  const safeLatest = latestBlock - CONFIRMATION_BUFFER;

  const cursor = await chainScanCursorRepo.getCursor("celo");
  // No cursor yet — start watching from now, deliberately no historical
  // backfill (only deposits from the moment this ships forward matter).
  const fromBlock = cursor != null ? cursor + 1n : safeLatest;
  if (fromBlock > safeLatest) return; // nothing new yet

  const toBlock = fromBlock + MAX_BLOCK_RANGE < safeLatest ? fromBlock + MAX_BLOCK_RANGE : safeLatest;

  const logs = await client.getLogs({
    address: CELO_USDC_ADDRESS,
    event: TRANSFER_EVENT,
    args: { to: wallets.map((w) => w.address as `0x${string}`) },
    fromBlock,
    toBlock,
  });

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
      await ingestDeposit({
        userId: wallet.userId,
        walletId: wallet.id,
        tokenSymbol: "USDC",
        amount: formatUnits(log.args.value!, USDC_DECIMALS),
        chain: "celo",
        txHash: log.transactionHash!,
      });
    } catch (err) {
      allSucceeded = false;
      console.error(`[deposit-scanner] failed to ingest deposit (tx ${log.transactionHash}):`, err);
    }
  }

  if (allSucceeded) {
    await chainScanCursorRepo.setCursor("celo", toBlock);
  }
}

const POLL_INTERVAL_MS = 30_000;

// A complete no-op unless WALLET_PROVIDER=aws-kms is explicitly set — never
// the case on Railway/production today, so this never runs there.
export function startCeloDepositScanner(): void {
  if (env.walletProvider !== "aws-kms") return;
  setInterval(() => {
    scanForDeposits().catch((err) => console.error("[deposit-scanner]", err));
  }, POLL_INTERVAL_MS);
}
