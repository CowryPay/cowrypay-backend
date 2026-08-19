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
async function reclaimUsdtAta(wallet: { id: string; address: string; externalWalletId: string }): Promise<bigint | null> {
  if (!env.solanaUsdtMint) return null;
  if (await depositsRepo.hasAnyDeposit(wallet.id, "USDT")) return null;

  const rpc = createSolanaRpc(env.solanaRpcUrl);
  const owner = toAddress(wallet.address);
  const mint = toAddress(env.solanaUsdtMint);
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  const balanceResult = await rpc.getTokenAccountBalance(ata).send().catch(() => null);
  if (!balanceResult) return null; // ATA doesn't exist — nothing to reclaim
  if (BigInt(balanceResult.value.amount) !== 0n) return null; // real balance — never touch it (also enforced by the token program itself)

  const rentLamports = (await rpc.getBalance(ata).send()).value; // exact reclaim amount, read before closing rather than assumed from a constant

  const treasury = await getSolanaTreasurySigner();
  const signer = await decryptSolanaSigner(wallet.externalWalletId);
  const closeIx = getCloseAccountInstruction({
    account: ata,
    destination: toAddress(treasury.address),
    owner: signer,
  });

  await signAndSendTransaction(signer, [closeIx]);
  return rentLamports;
}

export async function reclaimSolanaUsdtRent(): Promise<void> {
  if (!env.solanaUsdtMint) return;
  const wallets = await walletsRepo.listByChain("solana");
  if (wallets.length === 0) return;

  let closedCount = 0;
  let reclaimedLamports = 0n;

  for (const wallet of wallets) {
    try {
      const reclaimed = await reclaimUsdtAta(wallet);
      if (reclaimed != null) {
        closedCount++;
        reclaimedLamports += reclaimed;
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
// does a full listByChain("solana") pass plus one RPC round-trip per
// wallet, so there's no benefit to running it more often.
const RECLAIM_INTERVAL_MS = 60 * 60_000;

export function startSolanaAtaReclaimer(): void {
  if (!env.solanaDepositsEnabled) return;
  setInterval(() => {
    reclaimSolanaUsdtRent().catch((err) => console.error("[solana-ata-reclaimer]", err));
  }, RECLAIM_INTERVAL_MS);
}
