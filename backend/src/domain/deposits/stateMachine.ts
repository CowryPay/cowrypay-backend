import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import type { Deposit } from "../../types.js";
import { ledgerRepo } from "../ledger/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { sweepWallet as sweepEvmWallet } from "../wallets/depositSweeper.js";
import { sweepWallet as sweepSolanaWallet } from "../wallets/solanaDepositSweeper.js";
import { getWalletAddress } from "../wallets/awsKmsAdapter.js";
import { getSolanaMint } from "../wallets/solanaAdapter.js";
import { SUPPORTED_CHAINS as AWS_KMS_SWEEP_CHAINS } from "../wallets/chains.js";
import { depositsRepo } from "./repository.js";
import { screenDeposit } from "./screening.js";

// Real structural gap this closes: Blockradar's master wallet has
// auto-sweep enabled (isAutoSweep: true, confirmed live via a real
// webhook payload — see blockradarAdapter.ts's own comment) — every
// deposit consolidates into the payout pool the instant it's detected,
// regardless of which user made it. Our aws-kms EVM wallets had no
// equivalent (sweeping only happened on a 5-minute background timer,
// which could silently stall for one specific wallet indefinitely — found
// live: a gas top-up that never confirmed within its wait window, a path
// that logged nothing at all), and Solana's own sweeper had the same
// timer-only gap even without that specific silent-failure mode.
// Triggering a sweep here, synchronously with the deposit that just got
// credited, means the shared payout pool on every self-custody chain
// stays topped up as a side effect of ordinary deposit activity for
// EVERY user — not just whichever user happens to be off-ramping at the
// moment their own specific deposit gets unstuck (offramp/service.ts's
// just-in-time sweep only helps the current spender's own EVM wallet;
// that remains a narrower backstop, this is the actual fix). Best-effort
// and non-blocking on both branches — a sweep failure must never undo or
// delay the deposit credit itself, same "don't let an ancillary step
// break the main path" stance as registerSolanaWebhookAddress in
// solanaAdapter.ts. Stellar has no equivalent because it has no per-user
// wallet to sweep from at all — every deposit already lands directly in
// the same account that pays out.
async function triggerSweepAfterCredit(deposit: Deposit): Promise<void> {
  try {
    if (AWS_KMS_SWEEP_CHAINS.includes(deposit.chain)) {
      if (!env.awsKmsPayoutKeyArn) return;
      const wallet = await walletsRepo.findByUserIdAndChain(deposit.userId, deposit.chain);
      if (!wallet || wallet.provider !== "aws-kms") return;
      const payoutAddress = await getWalletAddress(env.awsKmsPayoutKeyArn);
      await sweepEvmWallet(
        deposit.chain,
        deposit.tokenSymbol,
        { externalWalletId: wallet.externalWalletId, address: wallet.address as `0x${string}` },
        { keyArn: env.awsKmsPayoutKeyArn, address: payoutAddress },
      );
      return;
    }

    if (deposit.chain === "solana") {
      const mint = getSolanaMint(deposit.tokenSymbol);
      const wallet = await walletsRepo.findByUserIdAndChain(deposit.userId, "solana");
      if (!wallet) return;
      await sweepSolanaWallet({ address: wallet.address, externalWalletId: wallet.externalWalletId }, mint);
    }
  } catch (err) {
    console.error(`[deposit] auto-sweep-on-deposit failed for deposit ${deposit.id}:`, err);
  }
}

// Deposit → balance-credit state machine (architecture doc §8.1):
//   DEPOSIT_DETECTED -> DEPOSIT_COMPLIANCE_SCREENING -> BALANCE_CREDITED
//                                                     -> MANUAL_REVIEW -> BALANCE_CREDITED | DEPOSIT_HELD

export async function ingestDeposit(input: {
  userId: string;
  walletId: string;
  tokenSymbol: string;
  amount: string;
  chain: string;
  txHash: string;
}): Promise<{ deposit: Deposit; alreadyProcessed: boolean }> {
  const inserted = await withTransaction(async (client) => {
    const deposit = await depositsRepo.insertIfNew(client, input);
    if (!deposit) return null;
    await depositsRepo.logTransition(client, deposit.id, null, "DEPOSIT_DETECTED", "webhook_received");
    return deposit;
  });

  if (inserted) {
    const processed = await runScreening(inserted.id);
    return { deposit: processed, alreadyProcessed: false };
  }

  // A row already existed for this (chain, tx_hash) — normally a genuine
  // retry of an already-fully-processed deposit, but it can also mean a
  // prior attempt got interrupted after committing DEPOSIT_DETECTED but
  // before runScreening ran or completed (that transaction is atomic, so
  // an interrupted attempt always leaves the row here, never partway
  // through screening — confirmed against a real stuck deposit). Resume
  // screening for that case instead of treating "a row exists" as "fully
  // processed" — that's what let a deposit get stuck forever, invisibly,
  // since every retry used to short-circuit right here.
  const existing = await depositsRepo.findByChainAndTxHash(input.chain, input.txHash);
  if (!existing) throw new Error("Deposit insert conflicted but no existing row was found");
  if (existing.state === "DEPOSIT_DETECTED") {
    const processed = await runScreening(existing.id);
    return { deposit: processed, alreadyProcessed: false };
  }
  return { deposit: existing, alreadyProcessed: true };
}

// Real incident this closes: ingestDeposit's own fallback path can call
// this twice for the same deposit if two calls race close enough together
// (a scanner cycle overrunning its 30s interval — the exact same shape of
// race already found and fixed in the withdrawal confirmation pollers —
// or a redelivered webhook). The CAS claim below is what actually makes
// that safe, not the caller's own state check (which is a plain read, not
// atomic with the call that follows it): only one concurrent invocation
// can ever win the DEPOSIT_DETECTED -> DEPOSIT_COMPLIANCE_SCREENING
// transition, so only one can ever reach the credit at the end. The loser
// backs off and reports whatever the winner's outcome actually was,
// instead of independently re-running screening and crediting the ledger
// a second time.
async function runScreening(depositId: string): Promise<Deposit> {
  const claimed = await withTransaction(async (client) => {
    const deposit = await depositsRepo.updateStateIfCurrent(
      client,
      depositId,
      "DEPOSIT_DETECTED",
      "DEPOSIT_COMPLIANCE_SCREENING",
    );
    if (!deposit) return null;
    await depositsRepo.logTransition(
      client,
      depositId,
      "DEPOSIT_DETECTED",
      "DEPOSIT_COMPLIANCE_SCREENING",
      "screening_started",
    );
    return deposit;
  });

  if (!claimed) {
    // Lost the race — another call already claimed this deposit for
    // screening (or it's already past that point). Report the current
    // real state instead of duplicating that work.
    const current = await depositsRepo.findById(depositId);
    if (!current) throw new Error(`Deposit ${depositId} vanished mid-screening`);
    return current;
  }

  const deposit = await withTransaction(async (client) => {
    const result = await screenDeposit(claimed.amount);

    if (!result.clear) {
      const next = await depositsRepo.updateState(client, depositId, "MANUAL_REVIEW");
      await depositsRepo.logTransition(
        client,
        depositId,
        "DEPOSIT_COMPLIANCE_SCREENING",
        "MANUAL_REVIEW",
        result.reason ?? "screening_flagged",
      );
      return next;
    }

    const next = await depositsRepo.updateState(client, depositId, "BALANCE_CREDITED");
    await depositsRepo.logTransition(
      client,
      depositId,
      "DEPOSIT_COMPLIANCE_SCREENING",
      "BALANCE_CREDITED",
      "screening_clear",
    );
    await ledgerRepo.creditAvailable(client, next.userId, next.tokenSymbol, next.chain, next.amount);
    return next;
  });

  if (deposit.state === "BALANCE_CREDITED") await triggerSweepAfterCredit(deposit);
  return deposit;
}

export async function resolveManualReview(
  depositId: string,
  decision: "approve" | "reject",
  actor: string,
): Promise<Deposit> {
  const deposit = await withTransaction(async (client) => {
    const current = await depositsRepo.findByIdForUpdate(client, depositId);
    if (!current) throw new Error("Deposit not found");
    if (current.state !== "MANUAL_REVIEW") {
      throw new Error(`Deposit ${depositId} is not in MANUAL_REVIEW (currently ${current.state})`);
    }

    if (decision === "approve") {
      const deposit = await depositsRepo.updateState(client, depositId, "BALANCE_CREDITED");
      await depositsRepo.logTransition(
        client,
        depositId,
        "MANUAL_REVIEW",
        "BALANCE_CREDITED",
        "manual_review_approved",
        actor,
      );
      await ledgerRepo.creditAvailable(client, deposit.userId, deposit.tokenSymbol, deposit.chain, deposit.amount);
      return deposit;
    }

    const deposit = await depositsRepo.updateState(client, depositId, "DEPOSIT_HELD");
    await depositsRepo.logTransition(
      client,
      depositId,
      "MANUAL_REVIEW",
      "DEPOSIT_HELD",
      "manual_review_rejected",
      actor,
    );
    return deposit;
  });

  if (deposit.state === "BALANCE_CREDITED") await triggerSweepAfterCredit(deposit);
  return deposit;
}
