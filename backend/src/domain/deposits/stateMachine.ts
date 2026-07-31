import { withTransaction } from "../../db/pool.js";
import type { Deposit } from "../../types.js";
import { ledgerRepo } from "../ledger/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { getWalletAdapter } from "../wallets/index.js";
import { getAgentWallet } from "../wallets/agentWallet.js";
import { ensureGasFunded } from "../wallets/gasStation.js";
import { depositsRepo } from "./repository.js";
import { screenDeposit } from "./screening.js";

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

  if (!inserted) {
    const existing = await depositsRepo.findByChainAndTxHash(input.chain, input.txHash);
    if (!existing) throw new Error("Deposit insert conflicted but no existing row was found");
    return { deposit: existing, alreadyProcessed: true };
  }

  const processed = await runScreening(inserted.id);
  if (processed.state === "BALANCE_CREDITED") {
    await sweepDepositToAgent(processed);
  }
  return { deposit: processed, alreadyProcessed: false };
}

// Moves the deposited USDC out of the user's individual Blockradar wallet
// into the agent wallet — sends now pay out directly from the agent wallet
// (domain/wallets/agentPayout.ts) rather than withdrawing from each user's
// own wallet per send. Best-effort: the ledger credit above already
// happened and is the source of truth for what the user sees, so a sweep
// failure doesn't undo that — it just leaves this deposit's tokens sitting
// in the user's wallet for manual reconciliation instead of the agent
// wallet, logged clearly rather than silently swallowed.
async function sweepDepositToAgent(deposit: Deposit): Promise<void> {
  try {
    const wallet = await walletsRepo.findByUserId(deposit.userId);
    if (!wallet) throw new Error("no wallet found for user");

    await ensureGasFunded(wallet.address as `0x${string}`, wallet.chain);
    const agent = getAgentWallet();
    await getWalletAdapter().withdraw({
      externalWalletId: wallet.externalWalletId,
      chain: wallet.chain,
      tokenSymbol: deposit.tokenSymbol,
      toAddress: agent.address,
      amount: deposit.amount,
      reference: `sweep-${deposit.id}`,
    });

    await withTransaction((client) =>
      depositsRepo.logTransition(client, deposit.id, "BALANCE_CREDITED", "BALANCE_CREDITED", "swept_to_agent"),
    );
  } catch (err) {
    console.error(`Sweep failed for deposit ${deposit.id}:`, err);
    await withTransaction((client) =>
      depositsRepo.logTransition(
        client,
        deposit.id,
        "BALANCE_CREDITED",
        "BALANCE_CREDITED",
        `sweep_failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

async function runScreening(depositId: string): Promise<Deposit> {
  return withTransaction(async (client) => {
    let deposit = await depositsRepo.updateState(client, depositId, "DEPOSIT_COMPLIANCE_SCREENING");
    await depositsRepo.logTransition(
      client,
      depositId,
      "DEPOSIT_DETECTED",
      "DEPOSIT_COMPLIANCE_SCREENING",
      "screening_started",
    );

    const result = await screenDeposit(deposit.amount);

    if (!result.clear) {
      deposit = await depositsRepo.updateState(client, depositId, "MANUAL_REVIEW");
      await depositsRepo.logTransition(
        client,
        depositId,
        "DEPOSIT_COMPLIANCE_SCREENING",
        "MANUAL_REVIEW",
        result.reason ?? "screening_flagged",
      );
      return deposit;
    }

    deposit = await depositsRepo.updateState(client, depositId, "BALANCE_CREDITED");
    await depositsRepo.logTransition(
      client,
      depositId,
      "DEPOSIT_COMPLIANCE_SCREENING",
      "BALANCE_CREDITED",
      "screening_clear",
    );
    await ledgerRepo.creditAvailable(client, deposit.userId, deposit.tokenSymbol, deposit.amount);
    return deposit;
  });
}

export async function resolveManualReview(
  depositId: string,
  decision: "approve" | "reject",
  actor: string,
): Promise<Deposit> {
  return withTransaction(async (client) => {
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
      await ledgerRepo.creditAvailable(client, deposit.userId, deposit.tokenSymbol, deposit.amount);
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
}
