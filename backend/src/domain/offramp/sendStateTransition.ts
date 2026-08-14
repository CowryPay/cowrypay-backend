import type { PoolClient } from "pg";
import type { Send, SendState } from "../../types.js";
import { sendsRepo } from "./repository.js";
import { ledgerRepo } from "../ledger/repository.js";
import { depositsRepo } from "../deposits/repository.js";

// Shared by every off-ramp provider's webhook handler (paycrestWebhook.ts,
// quidaxWebhook.ts) — guards against a state going backwards if a provider
// redelivers an out-of-order or duplicate webhook, regardless of which
// provider's event vocabulary produced the target state.
const STATE_ORDER: SendState[] = [
  "SEND_INSTRUCTED",
  "COMPLIANCE_SCREENING",
  "MANUAL_REVIEW",
  "ORDER_CREATED",
  "PAYOUT_INITIATED",
  "SETTLING",
  "COMPLETE",
];

export function resolveNextSendState(
  eventStateMap: Partial<Record<string, SendState>>,
  event: string,
  currentState: SendState,
): SendState | null {
  const target = eventStateMap[event];
  if (!target) return null;

  // Terminal states (COMPLETE/FAILED/REFUNDED/SEND_REJECTED) never move again.
  if (["COMPLETE", "FAILED", "REFUNDED", "SEND_REJECTED"].includes(currentState)) return null;

  if (target === "FAILED" || target === "REFUNDED") return target;

  const currentIndex = STATE_ORDER.indexOf(currentState);
  const targetIndex = STATE_ORDER.indexOf(target);
  if (currentIndex === -1 || targetIndex === -1 || targetIndex <= currentIndex) return null;

  return target;
}

// Real bug found live: every one of this codebase's FAILED/REFUNDED
// transitions that happen AFTER a payout already broadcast — Paycrest's
// payment_order.refunded/expired (webhook + settlement poller), Quidax's
// sell_transaction.failed webhook, Blockradar's own withdraw.failed
// webhook — flipped the send's state correctly but never touched
// ledgerRepo. The crypto had already left the user's spendable balance
// (debited up front, to prevent double-spending across concurrent sends)
// and, for the provider-side cases, physically lands back in CowryPay's
// own treasury (refundAddress) — but nothing ever credited the user back,
// leaving their app balance permanently short. Mirrors the existing
// broadcast-failure precedent in offramp/service.ts exactly: credits
// send.amountHuman, the full original debit (fee included) — if the send
// never actually completed, charging a fee for it is wrong regardless of
// which stage it failed at. This is a ledger-only entry; it does not
// require unwinding the on-chain fee sweep — the platform absorbs that
// already-swept fee as the cost of the failed send, same as any payment
// processor's refund policy.
//
// Guards against the webhook-vs-poller double-credit race: the update
// only succeeds if the row is STILL in the state this caller last read it
// as (sendsRepo.updateStateIfCurrent). Whichever of webhook/poller loses
// that race gets null back and no-ops — by the time it would otherwise
// re-check, resolveNextSendState already refuses to compute a next state
// for a current state that's already terminal.
// Real incident this closes: Paycrest's own refund for a REFUNDED order
// landed directly in the user's own AWS-KMS wallet — indistinguishable
// on-chain from an ordinary new deposit — and the deposit scanner
// credited that same transaction a SECOND time, on top of the ledger
// credit below. Confirmed live via an exact tx-hash match between a
// "deposit" and the provider's own refund transaction.
//
// Pre-registers that exact (chain, tx_hash) as an already-processed
// deposit — reusing depositsRepo's own (chain, tx_hash) uniqueness rather
// than adding a parallel mechanism — WITHOUT crediting the ledger a
// second time (see stateMachine.ts's ingestDeposit: a row that already
// exists and isn't DEPOSIT_DETECTED short-circuits as alreadyProcessed,
// no re-credit). Same transaction as the state/ledger update above, so
// there's no window where the scanner could race in between and credit
// it first.
export async function applyTerminalFailureTransition(
  client: PoolClient,
  send: Send,
  nextState: "FAILED" | "REFUNDED",
  trigger: string,
  actor: string,
  providerRefundOnChain?: { txHash: string },
): Promise<void> {
  const updated = await sendsRepo.updateStateIfCurrent(client, send.id, send.state, { state: nextState });
  if (!updated) return; // lost the race — some other call already applied this transition
  await ledgerRepo.creditAvailable(client, send.userId, send.tokenSymbol, send.chain, send.amountHuman);
  await sendsRepo.logTransition(client, send.id, send.state, nextState, trigger, actor);

  if (providerRefundOnChain) {
    const inserted = await depositsRepo.insertIfNew(client, {
      userId: send.userId,
      walletId: send.walletId,
      tokenSymbol: send.tokenSymbol,
      amount: send.amountHuman,
      chain: send.chain,
      txHash: providerRefundOnChain.txHash,
    });
    if (inserted) {
      await depositsRepo.updateState(client, inserted.id, "BALANCE_CREDITED");
      await depositsRepo.logTransition(
        client,
        inserted.id,
        "DEPOSIT_DETECTED",
        "BALANCE_CREDITED",
        `provider_refund_already_credited_via_send:${send.id}`,
        actor,
      );
    }
  }
}
