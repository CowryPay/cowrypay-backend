import { randomUUID } from "node:crypto";
import { parseUnits } from "viem";
import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import type { CryptoWithdrawal } from "../../types.js";
import { usersRepo } from "../users/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { getWalletAdapter } from "../wallets/index.js";
import { PayoutLiquidityError } from "../wallets/adapter.js";
import { ledgerRepo } from "../ledger/repository.js";
import { canInitiateSend } from "../sendAuthorization.js";
import { verifyTransactionPin } from "../pin/service.js";
import { cryptoWithdrawalsRepo } from "./repository.js";
import { isValidAddressForChain } from "./addressValidation.js";
import { computeCryptoWithdrawalFeeSplit, requireTreasuryAddress } from "../offramp/fee.js";
import { readTokenBalance, sweepWallet } from "../wallets/depositSweeper.js";
import { getWalletAddress } from "../wallets/awsKmsAdapter.js";
import { getTokenConfig, SUPPORTED_CHAINS as EVM_CHAINS } from "../wallets/chains.js";
import { sanitizeForDb } from "../../utils/format.js";

export interface InitiateCryptoWithdrawalInput {
  chain: string;
  amount: string;
  toAddress: string;
  pin: string;
  // Omitted means USDC — the only token that existed before USDT support,
  // so every caller that hasn't been updated (old frontend, direct API use)
  // keeps working exactly as before.
  tokenSymbol?: string;
}

// Which wallet ROW this withdrawal dispatches through — mirrors
// offramp/service.ts's own walletChainKey logic, but fixed to handle
// Solana explicitly rather than silently falling through to the EVM
// default the way that code's own comment admits it does today. EVM
// chains (celo/base/optimism) share one wallet row keyed under
// env.defaultChain (one KMS/Blockradar address valid on all three); Stellar
// and Solana each have their own dedicated row.
export function walletChainKeyFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === "stellar") return "stellar";
  if (c === "solana") return "solana";
  return env.defaultChain;
}

// Direct on-chain USDC withdrawal to a user-supplied address — no Paycrest
// order, no fiat conversion. Was originally fee-free (see migration 0015's
// own comment); now charges 0.3% via computeCryptoWithdrawalFeeSplit, same
// "debit the full amount, broadcast the net, sweep the fee separately to
// treasury" shape offramp/service.ts already uses for sends — only the
// destination and the lack of a Paycrest leg differ.
export async function initiateCryptoWithdrawal(
  userId: string,
  input: InitiateCryptoWithdrawalInput,
): Promise<CryptoWithdrawal> {
  const user = await usersRepo.findById(userId);
  if (!user) throw new Error("User not found");

  const authResult = canInitiateSend(user);
  if (!authResult.allowed) {
    throw new Error(`withdrawal not allowed: ${authResult.reason}`);
  }

  // Checked before touching the database or any wallet adapter, per the
  // same architecture rule offramp/service.ts follows (§9) — nothing
  // moving real funds relies solely on an already-unlocked session.
  const pinValid = await verifyTransactionPin(userId, input.pin);
  if (!pinValid) {
    throw new Error("Incorrect PIN");
  }

  // Checked against the gross amount, before any fee split — see
  // env.ts's own comment on why this is separate from
  // computeCryptoWithdrawalFeeSplit's min-fee check below.
  if (Number(input.amount) < Number(env.cryptoWithdrawalMinAmountUsd)) {
    throw new Error(
      `${input.amount} is below the ${env.cryptoWithdrawalMinAmountUsd} ${env.defaultTokenSymbol} minimum for a withdrawal.`,
    );
  }

  // A wrong-format destination here is unrecoverable money loss, not a
  // retryable error — validated before any balance is touched.
  if (!isValidAddressForChain(input.chain, input.toAddress)) {
    throw new Error(`"${input.toAddress}" is not a valid address for ${input.chain}`);
  }

  const tokenSymbol = input.tokenSymbol ?? env.defaultTokenSymbol;
  // Stellar/Solana validate their own token support inside the adapter;
  // EVM chains are validated here up front via chains.ts's token map (e.g.
  // USDT on Base) so an unsupported pairing fails clean, before any balance
  // is touched, rather than surfacing later as an opaque adapter error.
  if (EVM_CHAINS.includes(input.chain.toLowerCase())) {
    getTokenConfig(input.chain, tokenSymbol);
  }

  const walletChainKey = walletChainKeyFor(input.chain);
  const wallet = await walletsRepo.findByUserIdAndChain(userId, walletChainKey);
  if (!wallet) throw new Error("No wallet found for user");

  // Computed before touching the ledger — a null split (amount too small to
  // cover the minimum fee) must fail before any balance is debited.
  const split = computeCryptoWithdrawalFeeSplit(input.amount);
  if (!split) {
    throw new Error(
      `${input.amount} is too small to withdraw — it wouldn't cover the minimum ${env.cryptoWithdrawalMinFeeUsd} ${tokenSymbol} fee.`,
    );
  }
  const { feeAmount, netAmount } = split;
  const treasuryAddress = await requireTreasuryAddress(input.chain);

  const reference = randomUUID();

  const withdrawal = await withTransaction(async (client) => {
    // Atomic decrement-with-guard — same double-spend protection as
    // offramp/service.ts's own debit step. Debits the FULL amount (fee +
    // net), same "debit gross, broadcast net" shape as off-ramp sends.
    const debited = await ledgerRepo.debitAvailable(client, userId, tokenSymbol, input.chain, input.amount);
    if (!debited) {
      throw new Error("Insufficient balance");
    }

    const created = await cryptoWithdrawalsRepo.create(client, {
      userId,
      walletId: wallet.id,
      tokenSymbol,
      chain: input.chain,
      amountHuman: input.amount,
      toAddress: input.toAddress,
      feeAmount,
      treasuryAddress,
      provider: wallet.provider,
      reference,
    });
    await cryptoWithdrawalsRepo.logTransition(client, created.id, null, "PENDING", "withdrawal_requested");
    return created;
  });

  // Secondary backstop only, aws-kms EVM chains — mirrors offramp/
  // service.ts's own just-in-time sweep (see its comment for the full
  // reasoning). The real, structural fix is deposits/stateMachine.ts's
  // triggerSweepAfterCredit, which sweeps every deposit into the shared
  // payout pool the instant it's credited; this just covers anything
  // credited before that fix existed, or a case where that sweep attempt
  // itself failed. Does nothing for a shortfall bigger than this one
  // user's own deposit — that's correctly not this function's job.
  if (wallet.provider === "aws-kms" && EVM_CHAINS.includes(input.chain) && env.awsKmsPayoutKeyArn) {
    try {
      const payoutAddress = await getWalletAddress(env.awsKmsPayoutKeyArn);
      const { decimals: tokenDecimals } = getTokenConfig(input.chain, tokenSymbol);
      const needed = parseUnits(input.amount, tokenDecimals);
      const payoutBalance = await readTokenBalance(input.chain, tokenSymbol, payoutAddress);
      if (payoutBalance < needed) {
        console.log(
          `[crypto-withdrawal] payout wallet short on ${input.chain} for withdrawal ${withdrawal.id} (have ${payoutBalance}, need ${needed}) — attempting just-in-time sweep of ${wallet.address}`,
        );
        const swept = await sweepWallet(
          input.chain,
          tokenSymbol,
          { externalWalletId: wallet.externalWalletId, address: wallet.address as `0x${string}` },
          { keyArn: env.awsKmsPayoutKeyArn, address: payoutAddress },
        );
        console.log(
          `[crypto-withdrawal] just-in-time sweep for withdrawal ${withdrawal.id}: ${swept ? "broadcast" : "skipped (nothing to sweep, or gas top-up unconfirmed)"}`,
        );

        // sweepWallet only broadcasts — the very next step is attempting
        // the payout, so this needs to actually wait for the swept balance
        // to land, or the immediate retry would just hit the same
        // shortfall again. Bounded wait, not indefinite: if it hasn't
        // landed by then, withdraw()'s own liquidity error is the honest
        // outcome.
        if (swept) {
          for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            const updatedBalance = await readTokenBalance(input.chain, tokenSymbol, payoutAddress);
            if (updatedBalance >= needed) break;
          }
        }
      }
    } catch (err) {
      // Best-effort — any failure here just falls through to the normal
      // withdraw() attempt below, which surfaces its own accurate
      // liquidity error if the sweep genuinely didn't help.
      console.error(`[crypto-withdrawal] just-in-time sweep check failed for withdrawal ${withdrawal.id}:`, err);
    }
  }

  let payout;
  try {
    payout = await getWalletAdapter(input.chain, wallet.provider).withdraw({
      chain: input.chain,
      tokenSymbol,
      toAddress: input.toAddress,
      amount: netAmount,
      reference,
    });
  } catch (err) {
    await withTransaction(async (client) => {
      // Refund — the balance was debited up front to prevent double-spend
      // across concurrent requests, but the payout never actually left
      // custody, so the user's balance shouldn't reflect otherwise.
      await ledgerRepo.creditAvailable(client, userId, tokenSymbol, input.chain, input.amount);
      await cryptoWithdrawalsRepo.updateState(client, withdrawal.id, { state: "FAILED" });
      await cryptoWithdrawalsRepo.logTransition(
        client,
        withdrawal.id,
        "PENDING",
        "FAILED",
        `withdraw_failed: ${sanitizeForDb(err instanceof Error ? err.message : String(err))}`,
      );
    });
    // PayoutLiquidityError's message is already clean and user-facing
    // (our payout wallet's liquidity, never the user's balance) — surfaced
    // as-is, same as offramp/service.ts's own handling.
    if (err instanceof PayoutLiquidityError) {
      throw err;
    }
    throw new Error(
      `Could not broadcast the withdrawal (${err instanceof Error ? err.message : String(err)}) — it was marked failed.`,
    );
  }

  // Stellar/Solana adapters confirm synchronously before returning
  // ("CONFIRMED"); aws-kms broadcasts and returns immediately ("PENDING")
  // — the confirmation poller (cryptoWithdrawalConfirmationPoller.ts)
  // closes that gap for the latter, mirroring withdrawConfirmationPoller.ts.
  const nextState = payout.status === "CONFIRMED" ? "CONFIRMED" : "BROADCAST";

  const result = await withTransaction(async (client) => {
    const next = await cryptoWithdrawalsRepo.updateState(client, withdrawal.id, {
      state: nextState,
      withdrawTxHash: payout.txHash,
    });
    await cryptoWithdrawalsRepo.logTransition(
      client,
      withdrawal.id,
      "PENDING",
      nextState,
      payout.txHash ? `broadcast:${payout.txHash}` : "broadcast_pending_screening",
    );
    return next;
  });

  // Best-effort — the user's payout already succeeded above, so a failure
  // here only means the platform fee didn't reach treasury this time, not
  // that the withdrawal itself failed. Mirrors offramp/service.ts's own
  // fee-sweep step exactly. Logged for later manual reconciliation rather
  // than thrown.
  if (Number(feeAmount) > 0) {
    try {
      const feeSweep = await getWalletAdapter(input.chain, wallet.provider).withdraw({
        chain: input.chain,
        tokenSymbol,
        toAddress: treasuryAddress,
        amount: feeAmount,
        reference: `${reference}-fee`,
      });
      await withTransaction((client) =>
        cryptoWithdrawalsRepo.logTransition(
          client,
          result.id,
          nextState,
          nextState,
          feeSweep.txHash ? `fee_swept:${feeSweep.txHash}` : "fee_swept_pending_screening",
        ),
      );
    } catch (err) {
      console.error(`Fee sweep failed for crypto withdrawal ${result.id}:`, err);
      await withTransaction((client) =>
        cryptoWithdrawalsRepo.logTransition(
          client,
          result.id,
          nextState,
          nextState,
          `fee_sweep_failed: ${sanitizeForDb(err instanceof Error ? err.message : String(err))}`,
        ),
      );
    }
  }

  return result;
}
