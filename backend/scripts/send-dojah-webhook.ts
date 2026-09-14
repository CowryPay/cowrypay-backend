import "dotenv/config";
import { createHmac } from "node:crypto";

// Sends a correctly signed, Dojah-shaped KYC result to /webhooks/kyc — lets
// the backend half of the round trip (signature check → decision →
// resolveKyc → users.kyc_status) be exercised without paying for a real
// Dojah verification (the #2 keys are production, not sandbox).
//
// Standalone on purpose (like migrate.ts): only needs DOJAH_SECRET_KEY, not
// every env var config/env.ts requires. The target server must be running
// with KYC_PROVIDER=dojah and the SAME DOJAH_SECRET_KEY, and <reference>
// must be a real pending attempt — the providerReference POST /kyc/start
// returned — or resolveKyc will 400 with "attempt not found".
//
// This resolves a real attempt in whatever database the target uses.
//
//   npx tsx scripts/send-dojah-webhook.ts <baseUrl> <reference> [pass|fail|ongoing]
//   npx tsx scripts/send-dojah-webhook.ts http://localhost:3001 dojah_3f2c... fail

const [baseUrl, reference, outcome = "pass"] = process.argv.slice(2);
if (!baseUrl || !reference || !["pass", "fail", "ongoing"].includes(outcome)) {
  console.error("usage: npx tsx scripts/send-dojah-webhook.ts <baseUrl> <reference> [pass|fail|ongoing]");
  process.exit(1);
}

const secretKey = process.env.DOJAH_SECRET_KEY;
if (!secretKey) {
  console.error("DOJAH_SECRET_KEY must be set (same value as the target server's)");
  process.exit(1);
}

const step = (status: boolean, message: string) => ({ status, message, data: {} });

// Shape trimmed from Dojah's documented EasyOnboard payload
// (docs.dojah.io/docs/technical-reference/verify-events). "fail" keeps
// verification_status "Completed" and top-level status true with one
// failed step — the exact case that must still come back rejected.
const body = JSON.stringify({
  reference_id: reference,
  verification_status: outcome === "ongoing" ? "Ongoing" : "Completed",
  status: true,
  message: "Successfully completed the verification.",
  aml: { status: false },
  data: {
    index: step(true, "Successfully continued to the main checks."),
    government_data: step(true, ""),
    id: step(true, "Successfully verified your id"),
    selfie: step(outcome !== "fail", outcome === "fail" ? "Selfie does not match ID" : "Successfully validated your liveness"),
  },
});

const signature = createHmac("sha256", secretKey).update(body).digest("hex");

const res = await fetch(new URL("/webhooks/kyc", baseUrl), {
  method: "POST",
  headers: { "content-type": "application/json", "x-dojah-signature": signature },
  body,
});

console.log(`${res.status} ${await res.text()}`);
console.log(
  outcome === "pass"
    ? "expected: 200 {ok:true} and users.kyc_status = 'verified'"
    : outcome === "fail"
      ? "expected: 200 {ok:true} and users.kyc_status = 'rejected'"
      : "expected: 200 {ok:true,skipped:true} and users.kyc_status still 'pending'",
);
