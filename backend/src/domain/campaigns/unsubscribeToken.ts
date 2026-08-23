import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";

// HMAC-SHA256 over the lowercased email, hex-encoded — short, URL-safe,
// and lets the unsubscribe endpoint verify a link was actually generated
// by us rather than someone guessing another user's email into the query
// string. Not a secret worth rotating machinery for; a plain shared HMAC
// key is proportionate to what this protects (one boolean per address).
export function generateUnsubscribeToken(email: string): string {
  if (!env.campaignUnsubscribeSecret) {
    throw new Error("CAMPAIGN_UNSUBSCRIBE_SECRET must be set to send campaign emails");
  }
  return createHmac("sha256", env.campaignUnsubscribeSecret).update(email.toLowerCase()).digest("hex");
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  if (!env.campaignUnsubscribeSecret) return false;
  const expected = generateUnsubscribeToken(email);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
