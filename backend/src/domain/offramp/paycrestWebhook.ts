import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";

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
