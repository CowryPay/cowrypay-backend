import { randomUUID } from "node:crypto";
import { parseUnits } from "viem";
import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import type { CrossChainSend } from "../../types.js";
import { usersRepo } from "../users/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { getWalletAdapter } from "../wallets/index.js";
import { ledgerRepo } from "../ledger/repository.js";
import { canInitiateSend } from "../sendAuthorization.js";
import { verifyTransactionPin } from "../pin/service.js";
import { isValidAddressForChain } from "../cryptoWithdrawals/addressValidation.js";
import { walletChainKeyFor } from "../cryptoWithdrawals/service.js";
import { computeCrossChainSendFeeSplit, requireTreasuryAddress } from "../offramp/fee.js";
import { readTokenBalance, sweepWallet } from "../wallets/depositSweeper.js";
import { getWalletAddress } from "../wallets/awsKmsAdapter.js";
import { getTokenConfig } from "../wallets/chains.js";
import { getSolanaMint, readSolanaTreasuryBalance, SOLANA_TOKEN_DECIMALS } from "../wallets/solanaAdapter.js";
import { sweepWallet as sweepSolanaWallet } from "../wallets/solanaDepositSweeper.js";
import { getBridgeAdapter } from "./bridge/index.js";
import { crossChainSendsRepo } from "./repository.js";
import { sanitizeForDb } from "../../utils/format.js";

export interface InitiateCrossChainSendInput {
  sourceChain: string;
  destinationChain: string;
  amount: string;
  toAddress: string;
  pin: string;
  tokenSymbol?: string;
}

// Debits the source chain's ledger, then hands off to a real bridge
// (getBridgeAdapter — CCTP today) to move the value and pay it out on the
// destination chain. Deliberately does NOT wait for the bridge to
// complete — mirrors initiateCryptoWithdrawal's broadcast-and-return
// stance exactly; crossChainSendConfirmationPoller.ts is what advances
// SOURCE_BROADCAST all the way through to COMPLETE (or STUCK — see that
// file's own risk-handling comment on why a confirmed source-chain
// burn/lock is never auto-refunded).
export async function initiateCrossChainSend(userId: string, input: InitiateCrossChainSendInput): Promise<CrossChainSend> {
  const user = await usersRepo.findById(userId);
  if (!user) throw new Error("User not found");

  const authResult = canInitiateSend(user);
  if (!authResult.allowed) {
    throw new Error(`cross-chain send not allowed: ${authResult.reason}`);
  }

  // Checked before touching the database or any wallet/bridge adapter,
  // same §9 rule initiateCryptoWithdrawal and offramp/service.ts both
  // follow — nothing moving real funds relies solely on an
  // already-unlocked session.
  const pinValid = await verifyTransactionPin(userId, input.pin);
  if (!pinValid) {
    throw new Error("Incorrect PIN");
  }

  if (input.sourceChain.toLowerCase() === input.destinationChain.toLowerCase()) {
    throw new Error("Source and destination chain are the same — use a regular crypto withdrawal instead.");
  }

  // Checked against the gross amount, before any fee split — see
  // env.ts's own comment on why this is a separate, higher floor than
  // computeCrossChainSendFeeSplit's min-fee check below (that one only
  // guards the platform's fee revenue, not the bridge's own economics —
  // this one guards the bridge itself being worth using at all).
  if (Number(input.amount) < Number(env.crossChainSendMinAmountUsd)) {
    throw new Error(
      `${input.amount} is below the ${env.crossChainSendMinAmountUsd} ${env.defaultTokenSymbol} minimum for a cross-chain send.`,
    );
  }

  // A wrong-format destination here is unrecoverable money loss, same
  // reasoning as isValidAddressForChain's own doc comment.
  if (!isValidAddressForChain(input.destinationChain, input.toAddress)) {
    throw new Error(`"${input.toAddress}" is not a valid address for ${input.destinationChain}`);
  }

  // Throws a clear "not supported yet" error for Celo (no CCTP domain)
  // or Solana/Stellar (CCTP domain exists, EVM-only signing built so
  // far) before any balance is touched — see bridge/index.ts.
  const bridge = getBridgeAdapter(input.sourceChain, input.destinationChain);
  if (!bridge.supports(input.sourceChain, input.destinationChain)) {
    throw new Error(`Cross-chain send from ${input.sourceChain} to ${input.destinationChain} isn't supported yet.`);
  }

  const tokenSymbol = input.tokenSymbol ?? env.defaultTokenSymbol;
  if (["celo", "base"].includes(input.sourceChain.toLowerCase())) {
    getTokenConfig(input.sourceChain, tokenSymbol);
  }

  const walletChainKey = walletChainKeyFor(input.sourceChain);
  const wallet = await walletsRepo.findByUserIdAndChain(userId, walletChainKey);
  if (!wallet) throw new Error("No wallet found for user");

  // Same percentage as a same-chain crypto withdrawal, but a much smaller
  // minimum-fee floor — see offramp/fee.ts's own comment on why this
  // can't just reuse computeCryptoWithdrawalFeeSplit. Computed before
  // touching the ledger; a null split (amount too small to cover the
  // minimum fee) must fail before any balance is debited.
  const split = computeCrossChainSendFeeSplit(input.amount);
  if (!split) {
    throw new Error(
      `${input.amount} is too small to send cross-chain — it wouldn't cover the minimum ${env.crossChainSendMinFeeUsd} ${tokenSymbol} fee.`,
    );
  }
  const { feeAmount, netAmount } = split;
  const treasuryAddress = await requireTreasuryAddress(input.sourceChain);

  const reference = randomUUID();

  const send = await withTransaction(async (client) => {
    // Atomic decrement-with-guard, same double-spend protection as every
    // other fund-moving flow in this codebase — debits the FULL amount
    // (fee + net), same "debit gross, broadcast net" shape.
    const debited = await ledgerRepo.debitAvailable(client, userId, tokenSymbol, input.sourceChain, input.amount);
    if (!debited) {
      throw new Error("Insufficient balance");
    }

    const created = await crossChainSendsRepo.create(client, {
      userId,
      walletId: wallet.id,
      tokenSymbol,
      sourceChain: input.sourceChain,
      destinationChain: input.destinationChain,
      amountHuman: input.amount,
      feeAmount,
      netAmount,
      toAddress: input.toAddress,
      treasuryAddress,
      bridgeVendor: "cctp",
      provider: wallet.provider,
      reference,
    });
    await crossChainSendsRepo.logTransition(client, created.id, null, "PENDING", "cross_chain_send_requested");
    return created;
  });

  // Just-in-time sweep backstop, mirrors initiateCryptoWithdrawal's own
  // (cryptoWithdrawals/service.ts) exactly — the payout wallet's on-chain
  // balance on the SOURCE chain is what the bridge burn actually spends
  // from, same liquidity concern a same-chain withdrawal has. Does
  // nothing for a shortfall bigger than this one user's own deposit —
  // correctly not this function's job.
  if (wallet.provider === "aws-kms" && ["celo", "base"].includes(input.sourceChain) && env.awsKmsPayoutKeyArn) {
    try {
      const payoutAddress = await getWalletAddress(env.awsKmsPayoutKeyArn);
      const { decimals: tokenDecimals } = getTokenConfig(input.sourceChain, tokenSymbol);
      const needed = parseUnits(input.amount, tokenDecimals);
      const payoutBalance = await readTokenBalance(input.sourceChain, tokenSymbol, payoutAddress);
      if (payoutBalance < needed) {
        console.log(
          `[cross-chain-send] payout wallet short on ${input.sourceChain} for send ${send.id} (have ${payoutBalance}, need ${needed}) — attempting just-in-time sweep of ${wallet.address}`,
        );
        const swept = await sweepWallet(
          input.sourceChain,
          tokenSymbol,
          { externalWalletId: wallet.externalWalletId, address: wallet.address as `0x${string}` },
          { keyArn: env.awsKmsPayoutKeyArn, address: payoutAddress },
        );
        if (swept) {
          for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            const updatedBalance = await readTokenBalance(input.sourceChain, tokenSymbol, payoutAddress);
            if (updatedBalance >= needed) break;
          }
        }
      }
    } catch (err) {
      // Best-effort — falls through to the bridge attempt below, which
      // surfaces its own accurate liquidity error if the sweep didn't help.
      console.error(`[cross-chain-send] just-in-time sweep check failed for send ${send.id}:`, err);
    }
  }

  // Same just-in-time backstop, Solana side — a Solana-source cross-chain
  // send spends from the treasury's own ATA (see solanaAdapter.ts's
  // withdraw() and solanaDepositSweeper.ts's sweepWallet, both
  // treasury-funded), not a KMS payout wallet, so this checks the
  // treasury's balance and sweeps this user's own Solana deposit wallet
  // into it if short — mirrors the EVM block above exactly in shape.
  if (input.sourceChain.toLowerCase() === "solana") {
    try {
      const mint = getSolanaMint(tokenSymbol);
      const needed = parseUnits(input.amount, SOLANA_TOKEN_DECIMALS);
      const treasuryBalance = await readSolanaTreasuryBalance(tokenSymbol);
      if (treasuryBalance < needed) {
        console.log(
          `[cross-chain-send] treasury short on Solana ${tokenSymbol} for send ${send.id} (have ${treasuryBalance}, need ${needed}) — attempting just-in-time sweep of ${wallet.address}`,
        );
        const swept = await sweepSolanaWallet(
          { address: wallet.address, externalWalletId: wallet.externalWalletId },
          mint,
        );
        if (swept) {
          for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            const updatedBalance = await readSolanaTreasuryBalance(tokenSymbol);
            if (updatedBalance >= needed) break;
          }
        }
      }
    } catch (err) {
      // Best-effort — falls through to the bridge attempt below, which
      // surfaces its own accurate liquidity error if the sweep didn't help.
      console.error(`[cross-chain-send] just-in-time sweep check failed for send ${send.id}:`, err);
    }
  }

  let bridgeResult;
  try {
    bridgeResult = await bridge.initiate({
      sourceChain: input.sourceChain,
      destinationChain: input.destinationChain,
      tokenSymbol,
      amount: netAmount,
      destinationAddress: input.toAddress,
      reference,
    });
  } catch (err) {
    // sanitizeForDb strips a raw NUL byte an error message can carry (seen
    // live from a malformed on-chain revert-reason decode) — without it,
    // THIS logTransition call itself throws ("invalid byte sequence for
    // encoding UTF8: 0x00"), which replaces the real failure with a
    // confusing, unrelated database error and never records the refund
    // transition at all. See utils/format.ts's own comment.
    const errorMessage = sanitizeForDb(err instanceof Error ? err.message : String(err));
    // Safe to refund — nothing irreversible happened on-chain yet (the
    // source leg never broadcast). See the poller's own comment for why
    // this is NOT safe once the source leg has confirmed.
    await withTransaction(async (client) => {
      await ledgerRepo.creditAvailable(client, userId, tokenSymbol, input.sourceChain, input.amount);
      await crossChainSendsRepo.updateState(client, send.id, "FAILED");
      await crossChainSendsRepo.logTransition(client, send.id, "PENDING", "FAILED", `bridge_initiate_failed: ${errorMessage}`);
    });
    throw new Error(`Could not start the cross-chain transfer (${errorMessage}) — it was marked failed and your balance was refunded.`);
  }

  const result = await withTransaction(async (client) => {
    const next = await crossChainSendsRepo.updateStateIfCurrent(client, send.id, "PENDING", {
      state: "SOURCE_BROADCAST",
      sourceTxHash: bridgeResult.sourceTxHash,
      bridgeReference: bridgeResult.bridgeReference,
    });
    if (!next) throw new Error(`cross-chain send ${send.id} state changed unexpectedly while broadcasting`);
    await crossChainSendsRepo.logTransition(
      client,
      send.id,
      "PENDING",
      "SOURCE_BROADCAST",
      bridgeResult.sourceTxHash ? `bridge_initiated:${bridgeResult.sourceTxHash}` : "bridge_initiated",
    );
    return next;
  });

  // Best-effort fee sweep to the source chain's treasury — same
  // "user's payout already succeeded, a failure here only means the
  // platform fee didn't reach treasury this time" stance as
  // initiateCryptoWithdrawal's own fee sweep. Logged for manual
  // reconciliation, not thrown. Unlike offramp/service.ts and
  // initiateCryptoWithdrawal's own fee sweeps, this previously logged
  // nothing to the send's own audit trail on either outcome — verified
  // live (2026-08-26) that both real fee sweeps to date actually landed
  // on-chain, but that took a manual on-chain trace, not anything visible
  // on the send record itself. Now logs a same-state transition on both
  // outcomes, mirroring those two flows exactly.
  if (Number(feeAmount) > 0) {
    try {
      const feeSweep = await getWalletAdapter(input.sourceChain, wallet.provider).withdraw({
        chain: input.sourceChain,
        tokenSymbol,
        toAddress: treasuryAddress,
        amount: feeAmount,
        reference: `${reference}-fee`,
      });
      await withTransaction((client) =>
        crossChainSendsRepo.logTransition(
          client,
          result.id,
          result.state,
          result.state,
          feeSweep.txHash ? `fee_swept:${feeSweep.txHash}` : "fee_swept_pending_screening",
        ),
      );
    } catch (err) {
      console.error(`Fee sweep failed for cross-chain send ${result.id}:`, err);
      await withTransaction((client) =>
        crossChainSendsRepo.logTransition(
          client,
          result.id,
          result.state,
          result.state,
          `fee_sweep_failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  return result;
}
