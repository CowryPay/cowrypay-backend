import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import type { SendState } from "../../types.js";
import { resolveNextSendState as resolveNextSendStateShared } from "./sendStateTransition.js";

// docs.paycrest.io — HMAC-SHA256 over the raw body, keyed with the API
// secret. Paycrest's docs specifically say to compare using timing-safe
// equality on the UTF-8 bytes of the (trimmed, lowercased) hex strings, not
// on the hex-decoded bytes — different from Blockradar's scheme, so this
// isn't just a copy of that verifier.
export function verifyPaycrestSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  if (!rawBody || !signature || !env.paycrestApiSecret) return false;

  const expectedHex = createHmac("sha256", env.paycrestApiSecret).update(rawBody).digest("hex").trim().toLowerCase();
  const providedHex = signature.trim().toLowerCase();

  const expected = Buffer.from(expectedHex, "utf8");
  const provided = Buffer.from(providedHex, "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

// docs.paycrest.io — events are named `payment_order.<status>`. `pending`
// only fires for onramp orders (fiat deposit confirmed) so it never applies
// to this offramp-only integration. `refunding` has no matching in-progress
// state of our own (only the REFUNDED terminal one) so it's left as an
// ack-only, no-op event rather than guessing a state for it.
const EVENT_STATE_MAP: Partial<Record<string, SendState>> = {
  "payment_order.deposited": "PAYOUT_INITIATED",
  "payment_order.validated": "PAYOUT_INITIATED",
  "payment_order.settling": "SETTLING",
  "payment_order.settled": "COMPLETE",
  "payment_order.refunded": "REFUNDED",
  "payment_order.expired": "FAILED",
};

export function resolveNextSendState(event: string, currentState: SendState): SendState | null {
  return resolveNextSendStateShared(EVENT_STATE_MAP, event, currentState);
}
