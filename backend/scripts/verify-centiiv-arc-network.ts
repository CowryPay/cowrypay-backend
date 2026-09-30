// One-off: confirm the real network enum value Centiiv expects for Arc,
// rather than trusting centiivAdapter.ts's current "ARC" guess (added
// UNVERIFIED 2026-09-28 — assumed from their naming pattern, never
// actually round-tripped against a live quote). Same technique already
// used to find every other network name in that file: a validation-error
// response lists Centiiv's real accepted enum values, so send the guess
// first and read the error closely if it's wrong instead of guessing
// again blind.
//
// Standalone on purpose (same reasoning as check-kyc-status.ts): only
// needs CENTIIV_PUBLIC_KEY, not every other service's config env.ts pulls
// in. Run via Railway's Console: `npx tsx scripts/verify-centiiv-arc-network.ts`
import "dotenv/config";

async function tryQuote(network: string) {
  const baseUrl = process.env.CENTIIV_BASE_URL ?? "https://api.centiiv.io";
  const publicKey = process.env.CENTIIV_PUBLIC_KEY;
  if (!publicKey) throw new Error("CENTIIV_PUBLIC_KEY is required");

  const res = await fetch(`${baseUrl}/public/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": publicKey },
    body: JSON.stringify({ fromAsset: "USDC", toAsset: "NGN", amount: 10, network }),
  });
  const json = await res.json().catch(() => ({}));
  console.log(`\nnetwork="${network}" -> HTTP ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
  return { ok: res.ok, json };
}

async function main() {
  // The current guess in centiivAdapter.ts's NETWORK_NAMES.
  const result = await tryQuote("ARC");

  if (!result.ok) {
    // If Centiiv's enum validation fires, the error message has historically
    // listed the real accepted values directly (see how OPTIMISM/CELO's
    // real status was found) — nothing further to guess, just read it above.
    console.log(
      "\n^ ARC was rejected. Check the message above for the real accepted network list, " +
        "or for a chain-not-supported-yet response (different from a bad-enum-value response) — " +
        "those read differently and this script can't tell them apart automatically.",
    );
  } else {
    console.log("\n^ ARC was accepted and returned a real quote. centiivAdapter.ts's NETWORK_NAMES.arc is confirmed correct.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
