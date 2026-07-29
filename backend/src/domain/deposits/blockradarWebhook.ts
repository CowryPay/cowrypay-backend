import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";

// docs.blockradar.co/en/utilities/webhooks — HMAC-SHA512 over the raw
// request body, keyed with the API key, compared against the
// x-blockradar-signature header. Fails closed on any missing piece.
export function verifyBlockradarSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  if (!rawBody || !signature || !env.blockradarApiKey) return false;

  const expectedHex = createHmac("sha512", env.blockradarApiKey).update(rawBody).digest("hex");
  const expected = Buffer.from(expectedHex, "hex");
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return false;
  }

  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
