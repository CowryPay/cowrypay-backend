// One-off: confirm Alchemy's real Notify (webhook) management API shape
// before trusting any of it — domain/deposits/alchemyWebhook.ts's
// signature scheme, awsKmsAdapter.ts's registerAlchemyWebhookAddress, and
// monitoring/alchemyWebhookReconciler.ts were all written against
// Alchemy's documented Address Activity product, UNVERIFIED against a
// real account. Same technique as scripts/verify-centiiv-arc-network.ts:
// call the real API, read the real response, fix whatever was guessed
// wrong.
//
// Defaults to READ-ONLY calls only (list webhooks, list one webhook's
// addresses) — this is deliberate, not laziness: Solana's own first real
// contact with Helius's management API (solanaAdapter.ts's
// registerSolanaWebhookAddress, before its 2026-08 fix) silently broke
// registration for 26 of 27 production wallets by echoing a GET
// response's read-only fields back into a PUT. Pass --write to also
// attempt a real (but no-op: adds and removes nothing) PATCH call against
// the FIRST configured webhook, to confirm the update endpoint/auth/field
// names are accepted at all before anything calls it for real.
//
// Standalone on purpose (same reasoning as check-kyc-status.ts): only
// needs ALCHEMY_AUTH_TOKEN plus whichever ALCHEMY_WEBHOOK_ID_<CHAIN> vars
// are already set, not every other service's config env.ts pulls in. Run
// via Railway's Console: `npx tsx scripts/verify-alchemy-notify-api.ts [--write]`
import "dotenv/config";

const CHAINS = ["CELO", "BASE", "OPTIMISM", "ETHEREUM", "ARC"];

async function call(path: string, init?: RequestInit) {
  const token = process.env.ALCHEMY_AUTH_TOKEN;
  if (!token) throw new Error("ALCHEMY_AUTH_TOKEN is required");

  const res = await fetch(`https://dashboard.alchemy.com/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", "X-Alchemy-Token": token, ...(init?.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  console.log(`\n${init?.method ?? "GET"} ${path} -> HTTP ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
  return { ok: res.ok, json };
}

async function main() {
  const write = process.argv.includes("--write");

  console.log("=== Listing every webhook on this Alchemy account (read-only) ===");
  console.log("Look for: does a 'network' value for CELO and ARC actually appear anywhere below?");
  await call("/team-webhooks");

  const configured = CHAINS.map((chain) => [chain, process.env[`ALCHEMY_WEBHOOK_ID_${chain}`]] as const).filter(
    ([, id]) => id,
  );
  if (configured.length === 0) {
    console.log("\nNo ALCHEMY_WEBHOOK_ID_<CHAIN> vars set — nothing further to check. Set one and re-run.");
    return;
  }

  for (const [chain, webhookId] of configured) {
    console.log(`\n=== ${chain}: listing currently-watched addresses (read-only) ===`);
    await call(`/webhook-addresses?webhook_id=${webhookId}`);
  }

  if (!write) {
    console.log("\n(Skipped the --write check. Re-run with --write to confirm the update endpoint/field names too.)");
    return;
  }

  const [firstChain, firstWebhookId] = configured[0]!;
  console.log(`\n=== ${firstChain}: no-op PATCH to confirm the update-addresses endpoint accepts this shape ===`);
  await call("/update-webhook-addresses", {
    method: "PATCH",
    body: JSON.stringify({ webhook_id: firstWebhookId, addresses_to_add: [], addresses_to_remove: [] }),
  });

  console.log(
    "\nCompare the real responses above against domain/deposits/alchemyWebhook.ts, " +
      "awsKmsAdapter.ts's registerAlchemyWebhookAddress, and monitoring/alchemyWebhookReconciler.ts — " +
      "fix any field name, endpoint path, or missing-chain assumption that doesn't match.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
