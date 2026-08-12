import type { PoolClient } from "pg";
import type { Send, SendState } from "../../types.js";
import { sendsRepo } from "./repository.js";
import { ledgerRepo } from "../ledger/repository.js";

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
export async function applyTerminalFailureTransition(
  client: PoolClient,
  send: Send,
  nextState: "FAILED" | "REFUNDED",
  trigger: string,
  actor: string,
): Promise<void> {
  const updated = await sendsRepo.updateStateIfCurrent(client, send.id, send.state, { state: nextState });
  if (!updated) return; // lost the race — some other call already applied this transition
  await ledgerRepo.creditAvailable(client, send.userId, send.tokenSymbol, send.chain, send.amountHuman);
  await sendsRepo.logTransition(client, send.id, send.state, nextState, trigger, actor);
}
