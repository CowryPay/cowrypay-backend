import { env } from "../../config/env.js";
import { walletsRepo } from "../wallets/repository.js";
import { sendTelegramOpsAlert } from "./telegram.js";

// Real incident this closes: a Solana deposit went undetected entirely —
// tracing it found the account's Helius webhook was (a) pointed at
// staging's URL, not production's, and (b) only watching ONE address
// total despite 27 production Solana wallets existing. solanaAdapter.ts's
// own registerSolanaWebhookAddress (added 2026-08-07) does a GET-then-PUT
// to append a new address, which is not atomic — two wallet creations
// close together race on that read-modify-write, and the loser's address
// is silently dropped from the list it never actually appended to. That
// fast-path append is left in place (it's still the quickest way for a
// brand-new wallet to become watched), but this is the actual safety net:
// re-derive the correct address list from our own database — the real
// source of truth — and reconcile Helius to match it, on a schedule, so
// any address lost to that race (or any other silent failure) gets
// self-healed within one cycle instead of staying invisible until a user
// reports a missing deposit.
export async function reconcileSolanaWebhookAddresses(): Promise<void> {
  if (!env.heliusApiKey || !env.heliusWebhookId) {
    console.log("[solana-webhook-reconciler] skipped: HELIUS_API_KEY or HELIUS_WEBHOOK_ID not set");
    return;
  }

  const wallets = await walletsRepo.listByChain("solana");
  const dbAddresses = wallets.map((w) => w.address);
  console.log(`[solana-webhook-reconciler] found ${dbAddresses.length} solana wallet(s) in DB`);
  if (dbAddresses.length === 0) return;

  const base = `https://mainnet.helius-rpc.com/v0/webhooks/${env.heliusWebhookId}`;
  const getRes = await fetch(`${base}?api-key=${env.heliusApiKey}`);
  if (!getRes.ok) {
    console.error(`[solana-webhook-reconciler] GET webhook failed (${getRes.status}): ${await getRes.text()}`);
    return;
  }
  const current = (await getRes.json()) as {
    webhookURL?: string;
    accountAddresses?: string[];
    transactionTypes?: string[];
    webhookType?: string;
    authHeader?: string;
  };
  const currentSet = new Set(current.accountAddresses ?? []);
  console.log(`[solana-webhook-reconciler] helius currently watches ${currentSet.size} address(es)`);

  const missing = dbAddresses.filter((a) => !currentSet.has(a));
  // Also catches the exact webhookURL misconfiguration that caused the
  // real incident — a webhook silently pointed at the wrong environment
  // is just as broken as one watching no addresses, and just as easy to
  // never notice without checking.
  const expectedUrl = `${env.publicBaseUrl}/webhooks/solana`;
  const urlMismatch = Boolean(env.publicBaseUrl) && current.webhookURL !== expectedUrl;
  console.log(
    `[solana-webhook-reconciler] missing=${missing.length} urlMismatch=${urlMismatch} currentUrl=${current.webhookURL} expectedUrl=${expectedUrl}`,
  );

  if (missing.length === 0 && !urlMismatch) return; // already in sync

  // Same fix as registerSolanaWebhookAddress's own comment explains —
  // Helius's PUT rejects the read-only fields its GET response includes
  // (webhookID, project, wallet), so only the real, settable fields are
  // sent here, explicitly, not a spread of the raw GET response.
  const merged = [...currentSet, ...missing];
  const putRes = await fetch(`${base}?api-key=${env.heliusApiKey}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      webhookURL: urlMismatch ? expectedUrl : current.webhookURL,
      transactionTypes: current.transactionTypes,
      webhookType: current.webhookType,
      authHeader: current.authHeader,
      accountAddresses: merged,
    }),
  });
  if (!putRes.ok) {
    console.error(`[solana-webhook-reconciler] PUT webhook failed (${putRes.status}): ${await putRes.text()}`);
    return;
  }

  const lines: string[] = [];
  if (missing.length > 0) lines.push(`Added ${missing.length} missing address(es) to the Solana deposit webhook.`);
  if (urlMismatch) lines.push(`Corrected webhookURL: was <code>${current.webhookURL}</code>, now <code>${expectedUrl}</code>.`);
  console.log(`[solana-webhook-reconciler] ${lines.join(" ")}`);
  await sendTelegramOpsAlert(`<b>CowryPay Solana webhook reconciled</b>\n\n${lines.join("\n")}`);
}

const RECONCILE_INTERVAL_MS = 10 * 60_000;

export function startSolanaWebhookReconciler(): void {
  setInterval(() => {
    reconcileSolanaWebhookAddresses().catch((err) => console.error("[solana-webhook-reconciler]", err));
  }, RECONCILE_INTERVAL_MS);
}
