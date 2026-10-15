import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { getChainConfig } from "../wallets/chains.js";

// Alchemy's documented Address Activity webhook scheme: HMAC-SHA256 over
// the raw body, hex-encoded, header `X-Alchemy-Signature`, keyed by the
// signing key shown when that specific webhook was created (one key per
// webhook, i.e. per chain here — see env.ts's alchemyWebhookSigningKeys).
// UNVERIFIED against a real captured delivery — see
// scripts/verify-alchemy-notify-api.ts. If this turns out wrong, every
// signature check below fails closed (never open), so the worst case of
// a wrong guess is "the speed layer never fires," not an unauthenticated
// deposit credit.
export function verifyAlchemyWebhookSignature(
  chain: string,
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
): boolean {
  const signingKey = env.alchemyWebhookSigningKeys[chain];
  if (!signingKey || !rawBody || !signatureHeader) return false;

  const expectedHex = createHmac("sha256", signingKey).update(rawBody).digest("hex").trim().toLowerCase();
  const providedHex = signatureHeader.trim().toLowerCase();
  const expected = Buffer.from(expectedHex, "utf8");
  const provided = Buffer.from(providedHex, "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export interface NormalizedAlchemyTransfer {
  txHash: string;
  toAddress: string;
  tokenSymbol: string;
  amount: string;
}

// Alchemy's documented Address Activity payload shape:
// { webhookId, type: "ADDRESS_ACTIVITY", event: { network, activity: [
//   { fromAddress, toAddress, value, asset, category, rawContract: { address, decimals }, hash }
// ] } } — `value` is documented as already human-readable (asset-unit, not
// raw base units). UNVERIFIED against a real captured delivery, same
// caveat as domain/deposits/solanaWebhook.ts's own normalizeHeliusPayload.
//
// Filtered against THIS chain's own configured token contracts
// (chains.ts's getChainConfig, the same source depositScanner.ts already
// uses) rather than trusting `asset`/`category` strings in the payload —
// an unrecognized contract address is simply dropped, not guessed at.
export function normalizeAlchemyPayload(chain: string, body: unknown): NormalizedAlchemyTransfer[] {
  const activity = (body as { event?: { activity?: unknown } })?.event?.activity;
  if (!Array.isArray(activity)) return [];

  const { tokens } = getChainConfig(chain);
  const symbolByContract = new Map(
    Object.entries(tokens).map(([symbol, cfg]) => [cfg.address.toLowerCase(), symbol]),
  );

  const out: NormalizedAlchemyTransfer[] = [];
  for (const item of activity) {
    const hash = item?.hash;
    const toAddress = item?.toAddress;
    const contractAddress = item?.rawContract?.address;
    const value = item?.value;
    if (typeof hash !== "string" || typeof toAddress !== "string" || typeof contractAddress !== "string") continue;
    const tokenSymbol = symbolByContract.get(contractAddress.toLowerCase());
    if (!tokenSymbol || value == null) continue;
    out.push({ txHash: hash, toAddress, tokenSymbol, amount: String(value) });
  }
  return out;
}
