import { address as toAddress, createSolanaRpc, lamports } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import { env } from "../../config/env.js";
import { walletsRepo } from "./repository.js";
import { decryptSolanaSigner, getSolanaTreasurySigner } from "./solanaKms.js";
import { signAndSendTransaction, SOLANA_TOKEN_DECIMALS } from "./solanaAdapter.js";

// Below this, the token isn't worth the network fee to move — mirrors
// chains.ts's MIN_SWEEP_TOKEN_AMOUNT for the EVM chains (0.01 there too;
// kept separate here rather than shared, since nothing about Solana's fee
// economics ties the two together). Same threshold works for both USDC and
// USDT since both are 6-decimal SPL tokens.
const MIN_SWEEP_BASE_UNITS = 10_000n; // 0.01 token

// A simple 1-signer transaction's base fee is 5000 lamports — MIN_FEE_LAMPORTS
// (the trigger threshold) is buffered up for safety against compute-unit
// fee-market spikes, same as chains.ts's gasBufferThreshold reasoning for
// the EVM chains. TOPUP_LAMPORTS (the amount actually sent) is a different
// story: found live that a too-small top-up amount fails outright, not
// just wastefully — a system account can't hold ANY non-zero balance below
// Solana's real rent-exemption minimum (~890,880 lamports), so topping up
// a zero-balance account with anything less gets rejected by the runtime
// itself ("insufficient funds for rent"), not just under-funded. In normal
// operation this path should rarely fire at all (createWallet already
// funds every new wallet well above this), but the safety net has to
// actually work on the rare occasions it's needed, including the
// zero-balance case — so this is sized the same as
// solanaAdapter.ts's own SYSTEM_ACCOUNT_RENT_LAMPORTS, not a smaller
// fee-only guess.
const MIN_FEE_LAMPORTS = 20_000n;
const TOPUP_LAMPORTS = 1_000_000n;

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

  // The treasury's own ATA for this mint was never guaranteed to exist —
  // USDC's happened to from one-time manual bootstrapping when Solana
  // support first launched, but USDT's has no such history. Checked (not
  // unconditionally created) so this doesn't cost an extra signed
  // transaction on every single sweep once it exists — only the very first
  // sweep of a given mint pays for it. The sweep transaction below is
  // signed by the DEPOSITING USER's own key, not the treasury's, so unlike
  // withdraw()'s destination-ATA creation (which the treasury already
  // signs for), this can't just be folded into that same transaction.
  const treasuryAtaExists = await rpc
    .getTokenAccountBalance(treasuryAta)
    .send()
    .then(() => true)
    .catch(() => false);
  if (!treasuryAtaExists) {
    const createTreasuryAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: treasury,
      ata: treasuryAta,
      owner: treasuryOwner,
      mint: mintAddress,
    });
    await signAndSendTransaction(treasury, [createTreasuryAtaIx]);
  }

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
    decimals: SOLANA_TOKEN_DECIMALS,
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
// moves the underlying on-chain balance into the treasury so it's actually
// available to back future withdraws — mirrors depositSweeper.ts's own
// framing exactly. Sweeps both mints per wallet, one after the other — a
// USDT deposit shouldn't sit unswept just because this loop only ever
// checked USDC.
export async function sweepSolanaDeposits(): Promise<void> {
  const mints = [env.solanaUsdcMint, env.solanaUsdtMint].filter((m): m is string => Boolean(m));
  if (mints.length === 0) return;
  const wallets = await walletsRepo.listByChain("solana");
  if (wallets.length === 0) return;

  for (const wallet of wallets) {
    for (const mint of mints) {
      try {
        await sweepWallet(wallet, mint);
      } catch (err) {
        console.error(`[solana-deposit-sweeper] failed to sweep wallet ${wallet.id} (mint ${mint}):`, err);
      }
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
