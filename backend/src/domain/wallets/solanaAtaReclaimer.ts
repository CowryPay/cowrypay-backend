import { address as toAddress, createSolanaRpc } from "@solana/kit";
import { findAssociatedTokenPda, getCloseAccountInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { env } from "../../config/env.js";
import { walletsRepo } from "./repository.js";
import { depositsRepo } from "../deposits/repository.js";
import { decryptSolanaSigner, getSolanaTreasurySigner } from "./solanaKms.js";
import { signAndSendTransaction } from "./solanaAdapter.js";
import { sendTelegramOpsAlert } from "../monitoring/telegram.js";

// Reclaims the ~2.1M-lamport rent-exempt reserve locked in a user's USDT
// ATA once it's confirmed genuinely unused — the backlog this exists for
// is every wallet created before solanaAdapter.ts stopped eagerly funding
// USDT's ATA at signup. Safe because ensureSolanaUsdtAta recreates it on
// demand the moment that user actually needs USDT on Solana again;
// nothing is lost, we're just not letting an idle reserve sit locked up.
//
// Deliberately NOT just "balance is currently zero" — that's also true of
// an ACTIVE user's ATA in between deposits (solanaDepositSweeper.ts sweeps
// the full balance out every 5 minutes, leaving it at zero). Closing an
// active user's ATA would just mean paying to recreate it on their very
// next deposit, or worse, silently failing a deposit from a sender whose
// wallet doesn't auto-create the destination ATA. depositsRepo.hasAnyDeposit
// is what actually distinguishes "created but never used" (reclaim) from
// "used, temporarily empty because it was just swept" (leave alone) —
// only a wallet with zero deposit history for USDT is a candidate at all.
interface AtaReclaimResult {
  reclaimedLamports: bigint | null; // non-null only if we actually closed the account just now
  // True once we're SURE there's nothing left to ever check again for this
  // wallet (confirmed via a clean RPC response, never via a caught error —
  // see markSolanaUsdtAtaSettled's own call sites below). Lets
  // reclaimSolanaUsdtRent stop re-checking it on every future cycle.
  settled: boolean;
}

async function reclaimUsdtAta(wallet: { id: string; address: string; externalWalletId: string }): Promise<AtaReclaimResult | null> {
  if (!env.solanaUsdtMint) return null;
  if (await depositsRepo.hasAnyDeposit(wallet.id, "USDT")) return null;

  const rpc = createSolanaRpc(env.solanaRpcUrl);
  const owner = toAddress(wallet.address);
  const mint = toAddress(env.solanaUsdtMint);
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  // getAccountInfo returns a clean { value: null } for a missing account
  // rather than throwing (unlike getTokenAccountBalance) — that's what
  // makes "doesn't exist" a signal safe enough to persist permanently,
  // instead of conflating it with a transient RPC/network error the way a
  // blanket try/catch would. jsonParsed also gives us the parsed token
  // amount AND the account's lamports (the exact rent to reclaim) in this
  // one call, where the old code needed a separate getBalance call for that.
  const accountInfo = await rpc.getAccountInfo(ata, { encoding: "jsonParsed" }).send();
  if (accountInfo.value === null) {
    return { reclaimedLamports: null, settled: true }; // ATA genuinely never created — nothing to reclaim, ever
  }

  const parsedData = accountInfo.value.data;
  if (typeof parsedData === "string" || !("parsed" in parsedData)) {
    throw new Error(`unexpected non-jsonParsed account data for Solana ATA ${ata}`);
  }
  const info = parsedData.parsed.info as { tokenAmount?: { amount?: string } } | undefined;
  const tokenAmount = BigInt(info?.tokenAmount?.amount ?? "0");
  // Real balance — never touch it (also enforced by the token program
  // itself). Not settled: still swept on its own cadence, so this stays a
  // genuine candidate on a future cycle once it's confirmed idle again.
  if (tokenAmount !== 0n) return { reclaimedLamports: null, settled: false };

  const rentLamports = BigInt(accountInfo.value.lamports);

  const treasury = await getSolanaTreasurySigner();
  const signer = await decryptSolanaSigner(wallet.externalWalletId);
  const closeIx = getCloseAccountInstruction({
    account: ata,
    destination: toAddress(treasury.address),
    owner: signer,
  });

  await signAndSendTransaction(signer, [closeIx]);
  return { reclaimedLamports: rentLamports, settled: true };
}

export async function reclaimSolanaUsdtRent(): Promise<void> {
  if (!env.solanaUsdtMint) return;
  const wallets = await walletsRepo.listUnsettledSolanaUsdtAtaWallets();
  if (wallets.length === 0) return;

  let closedCount = 0;
  let reclaimedLamports = 0n;

  for (const wallet of wallets) {
    try {
      const result = await reclaimUsdtAta(wallet);
      if (result?.reclaimedLamports != null) {
        closedCount++;
        reclaimedLamports += result.reclaimedLamports;
      }
      if (result?.settled) {
        await walletsRepo.markSolanaUsdtAtaSettled(wallet.id);
      }
    } catch (err) {
      console.error(`[solana-ata-reclaimer] failed to check/close USDT ATA for wallet ${wallet.id}:`, err);
    }
  }

  if (closedCount > 0) {
    const sol = Number(reclaimedLamports) / 1e9;
    await sendTelegramOpsAlert(
      `<b>Solana rent reclaimed</b>\n\nClosed ${closedCount} unused USDT ATA(s), recovered ${sol.toFixed(6)} SOL back to treasury.`,
    );
  }
}

// Hourly, not on the sweeper's 5-minute cadence — this is idle-reserve
// cleanup, not time-sensitive liquidity movement, and every cycle here
// does one RPC round-trip per not-yet-settled wallet (see migration 0027
// and listUnsettledSolanaUsdtAtaWallets — settled wallets are excluded
// from that list entirely), so there's no benefit to running it more often.
const RECLAIM_INTERVAL_MS = 60 * 60_000;

export function startSolanaAtaReclaimer(): void {
  if (!env.solanaDepositsEnabled) return;
  setInterval(() => {
    reclaimSolanaUsdtRent().catch((err) => console.error("[solana-ata-reclaimer]", err));
  }, RECLAIM_INTERVAL_MS);
}
