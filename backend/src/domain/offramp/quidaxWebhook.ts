import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import type { SendState } from "../../types.js";
import { resolveNextSendState as resolveNextSendStateShared } from "./sendStateTransition.js";

// docs.quidax.io/docs/ramp-introduction — HMAC-SHA256 over the raw JSON
// body, keyed with the secret key, sent as the x-ramp-signature header.
// Unlike Paycrest's verifier, Quidax's own docs example computes the
// digest directly as hex (no trim/lowercase dance) — kept as a separate
// function rather than sharing Paycrest's, since the two providers'
// schemes aren't guaranteed to stay identical just because both happen to
// be HMAC-SHA256 today.
export function verifyQuidaxSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  if (!rawBody || !signature || !env.quidaxSecretKey) return false;

  const expected = Buffer.from(createHmac("sha256", env.quidaxSecretKey).update(rawBody).digest("hex"), "utf8");
  const provided = Buffer.from(signature, "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

// docs.quidax.io — events are named `sell_transaction.<status>`, verified
// live against their docs pages (not just inferred). No "settled but
// awaiting a separate fiat leg" distinction the way Paycrest's
// deposited/validated/settling/settled sequence has — Quidax collapses
// that into just processing -> successful.
const EVENT_STATE_MAP: Partial<Record<string, SendState>> = {
  "sell_transaction.processing": "SETTLING",
  "sell_transaction.successful": "COMPLETE",
  "sell_transaction.failed": "FAILED",
};

export function resolveNextSendState(event: string, currentState: SendState): SendState | null {
  return resolveNextSendStateShared(EVENT_STATE_MAP, event, currentState);
}
