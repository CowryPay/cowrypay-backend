import { withTransaction } from "../../db/pool.js";
import type { Deposit } from "../../types.js";
import { ledgerRepo } from "../ledger/repository.js";
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
  return { deposit: processed, alreadyProcessed: false };
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
