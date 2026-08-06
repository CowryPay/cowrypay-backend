import { address as toAddress, createSolanaRpc, lamports } from "@solana/kit";
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import { env } from "../../config/env.js";
import { walletsRepo } from "./repository.js";
import { decryptSolanaSigner, getSolanaTreasurySigner } from "./solanaKms.js";
import { signAndSendTransaction, USDC_DECIMALS } from "./solanaAdapter.js";

// Below this, the USDC isn't worth the network fee to move — mirrors
// chains.ts's MIN_SWEEP_USDC for the EVM chains (0.01 USDC there; kept
// separate here rather than shared, since nothing about Solana's fee
// economics ties the two together).
const MIN_SWEEP_BASE_UNITS = 10_000n; // 0.01 USDC

// A simple 1-signer transaction's base fee is 5000 lamports; buffered up
// for safety against compute-unit fee-market spikes rather than assumed
// exact — mirrors chains.ts's gasBufferThreshold reasoning for the EVM
// chains.
const MIN_FEE_LAMPORTS = 20_000n;
const TOPUP_LAMPORTS = 50_000n;

export interface SweepableSolanaWallet {
  address: string;
  externalWalletId: string; // KMS ciphertext
}

// Mirrors depositSweeper.ts's three-step shape (check balance -> ensure fee
// coverage, topping up if needed -> sign+broadcast from the wallet's own
// key), adapted for Solana: rent-exemption + fee coverage was already
// funded once at createWallet time (see solanaAdapter.ts), so the top-up
// here should rarely fire in steady state — kept as a defensive measure
// against operational drift (e.g. the pre-funding constant changing over
// time), not the primary funding mechanism.
export async function sweepWallet(wallet: SweepableSolanaWallet, mint: string): Promise<boolean> {
  const rpc = createSolanaRpc(env.solanaRpcUrl);
  const owner = toAddress(wallet.address);
  const mintAddress = toAddress(mint);
  const [userAta] = await findAssociatedTokenPda({ owner, mint: mintAddress, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  const balanceResult = await rpc.getTokenAccountBalance(userAta).send().catch(() => null);
  const userBalance = balanceResult ? BigInt(balanceResult.value.amount) : 0n;
  if (userBalance < MIN_SWEEP_BASE_UNITS) return false;

  const treasury = await getSolanaTreasurySigner();
  const treasuryOwner = toAddress(treasury.address);
  const [treasuryAta] = await findAssociatedTokenPda({
    owner: treasuryOwner,
    mint: mintAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const systemBalance = (await rpc.getBalance(owner).send()).value;
  if (systemBalance < MIN_FEE_LAMPORTS) {
    // Defensive top-up — should rarely fire, see the function doc comment.
    const topUpIx = getTransferSolInstruction({ source: treasury, destination: owner, amount: lamports(TOPUP_LAMPORTS) });
    await signAndSendTransaction(treasury, [topUpIx]);
  }

  const signer = await decryptSolanaSigner(wallet.externalWalletId);
  const transferIx = getTransferCheckedInstruction({
    source: userAta,
    mint: mintAddress,
    destination: treasuryAta,
    authority: signer,
    amount: userBalance,
    decimals: USDC_DECIMALS,
  });

  // Broadcast-and-move-on, same stance as depositSweeper.ts's EVM
  // sweepWallet — no user-facing state depends on this confirming
  // immediately (the ledger balance was already credited the moment
  // ingestDeposit ran, via the webhook — this is a pure backend liquidity
  // concern). A failed or stuck sweep just gets retried next cycle.
  await signAndSendTransaction(signer, [transferIx]);
  return true;
}

// Has NO effect on user-facing balances — those are already correct the
// moment the webhook credits the ledger (routes/solanaWebhook.ts). Purely
// moves the underlying on-chain USDC into the treasury so it's actually
// available to back future withdraws — mirrors depositSweeper.ts's own
// framing exactly.
export async function sweepSolanaDeposits(): Promise<void> {
  if (!env.solanaUsdcMint) return;
  const wallets = await walletsRepo.listByChain("solana");
  if (wallets.length === 0) return;

  for (const wallet of wallets) {
    try {
      await sweepWallet(wallet, env.solanaUsdcMint);
    } catch (err) {
      console.error(`[solana-deposit-sweeper] failed to sweep wallet ${wallet.id}:`, err);
    }
  }
}

const SWEEP_INTERVAL_MS = 5 * 60_000;

// Gated on the same SOLANA_DEPOSITS_ENABLED flag the webhook route uses —
// no real scenario needs detection and sweeping toggled independently.
export function startSolanaDepositSweeper(): void {
  if (!env.solanaDepositsEnabled) return;
  setInterval(() => {
    sweepSolanaDeposits().catch((err) => console.error("[solana-deposit-sweeper]", err));
  }, SWEEP_INTERVAL_MS);
}
