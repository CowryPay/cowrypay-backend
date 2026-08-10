import type { SendState } from "../../types.js";

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
