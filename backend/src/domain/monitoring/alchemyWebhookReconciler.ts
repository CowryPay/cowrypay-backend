import { env } from "../../config/env.js";
import { walletsRepo } from "../wallets/repository.js";
import { sendTelegramOpsAlert } from "./telegram.js";

// Mirrors monitoring/solanaWebhookReconciler.ts's exact reasoning: that
// file's own comment documents a real incident (a webhook silently
// watching 1 of 27 wallets, caused by a non-atomic registration race) —
// needed here regardless of whether Alchemy's real address-management API
// turns out to be the atomic add/remove call awsKmsAdapter.ts's
// registerAlchemyWebhookAddress is written against (UNVERIFIED, see
// scripts/verify-alchemy-notify-api.ts) or something closer to Helius's
// own racy GET-then-PUT — even an atomic call can still fail silently for
// other reasons (a network blip, a wrong webhook ID), and this is the
// independent safety net either way: re-derive the correct address list
// from our own database — the real source of truth — on a schedule.
//
// listByProvider("aws-kms"), NOT listByChain — every aws-kms wallet row is
// stored under env.defaultChain regardless of which EVM chain it's
// actually used on (one KMS key, every chain — wallets/chains.ts), the
// same reason routes/alchemyWebhook.ts doesn't trust wallet.chain either.
// Same method depositScanner.ts already uses for this.
async function reconcileChain(chain: string, webhookId: string, dbAddresses: string[]): Promise<void> {
  const base = "https://dashboard.alchemy.com/api/webhook-addresses";
  const getRes = await fetch(`${base}?webhook_id=${webhookId}`, {
    headers: { "X-Alchemy-Token": env.alchemyAuthToken! },
  });
  if (!getRes.ok) {
    console.error(`[alchemy-webhook-reconciler] GET addresses failed for ${chain} (${getRes.status}): ${await getRes.text()}`);
    return;
  }
  const current = (await getRes.json()) as { addresses?: string[] };
  const currentSet = new Set((current.addresses ?? []).map((a) => a.toLowerCase()));
  console.log(`[alchemy-webhook-reconciler] ${chain}: alchemy watches ${currentSet.size}, db has ${dbAddresses.length}`);

  const missing = dbAddresses.filter((a) => !currentSet.has(a.toLowerCase()));
  if (missing.length === 0) return; // already in sync

  const patchRes = await fetch("https://dashboard.alchemy.com/api/update-webhook-addresses", {
    method: "PATCH",
    headers: { "content-type": "application/json", "X-Alchemy-Token": env.alchemyAuthToken! },
    body: JSON.stringify({ webhook_id: webhookId, addresses_to_add: missing, addresses_to_remove: [] }),
  });
  if (!patchRes.ok) {
    console.error(`[alchemy-webhook-reconciler] PATCH addresses failed for ${chain} (${patchRes.status}): ${await patchRes.text()}`);
    return;
  }

  console.log(`[alchemy-webhook-reconciler] ${chain}: added ${missing.length} missing address(es)`);
  await sendTelegramOpsAlert(
    `<b>CowryPay Alchemy webhook reconciled (${chain})</b>\n\nAdded ${missing.length} missing address(es) to the deposit webhook.`,
  );
}

export async function reconcileAlchemyWebhookAddresses(): Promise<void> {
  if (!env.alchemyAuthToken) {
    console.log("[alchemy-webhook-reconciler] skipped: ALCHEMY_AUTH_TOKEN not set");
    return;
  }

  const configuredChains = Object.entries(env.alchemyWebhookIds).filter(([, id]) => id);
  if (configuredChains.length === 0) return;

  const wallets = await walletsRepo.listByProvider("aws-kms");
  if (wallets.length === 0) return;
  const dbAddresses = wallets.map((w) => w.address);

  for (const [chain, webhookId] of configuredChains) {
    try {
      await reconcileChain(chain, webhookId!, dbAddresses);
    } catch (err) {
      console.error(`[alchemy-webhook-reconciler] failed to reconcile ${chain}:`, err);
    }
  }
}

// Same interval and reasoning as RECONCILE_INTERVAL_MS in
// solanaWebhookReconciler.ts — a real gap sits there until fixed
// regardless, so this doesn't need to be tight.
const RECONCILE_INTERVAL_MS = 20 * 60_000;

export function startAlchemyWebhookReconciler(): void {
  setInterval(() => {
    reconcileAlchemyWebhookAddresses().catch((err) => console.error("[alchemy-webhook-reconciler]", err));
  }, RECONCILE_INTERVAL_MS);
}
