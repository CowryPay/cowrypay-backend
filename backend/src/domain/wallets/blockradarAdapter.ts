import { env } from "../../config/env.js";
import type { CreatedWallet, WalletAdapter, WithdrawInput, WithdrawResult } from "./adapter.js";

interface GenerateAddressResponse {
  data: {
    id: string;
    address: string;
    blockchain: { slug: string };
  };
}

function requireBlockradarConfig(): { apiKey: string; walletId: string } {
  if (!env.blockradarApiKey || !env.blockradarWalletId) {
    throw new Error(
      "BLOCKRADAR_API_KEY and BLOCKRADAR_WALLET_ID must be set when WALLET_PROVIDER=blockradar",
    );
  }
  return { apiKey: env.blockradarApiKey, walletId: env.blockradarWalletId };
}

interface WalletAssetsResponse {
  data: Array<{ id: string; asset: { symbol: string; blockchain: { slug: string } } }>;
}

// assetId (a Blockradar-internal UUID, not the token contract address) is
// required by the withdraw endpoint but never changes for a given
// symbol+chain pair — cached to avoid an extra lookup call on every send.
const assetIdCache = new Map<string, { assetId: string; expiresAt: number }>();
const ASSET_CACHE_TTL_MS = 10 * 60 * 1000;

async function resolveAssetId(apiKey: string, walletId: string, chain: string, symbol: string): Promise<string> {
  const cacheKey = `${chain}:${symbol}`;
  const cached = assetIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.assetId;

  const res = await fetch(`${env.blockradarBaseUrl}/wallets/${walletId}/assets`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Blockradar asset lookup failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as WalletAssetsResponse;
  const match = json.data.find((a) => a.asset.symbol === symbol && a.asset.blockchain.slug === chain);
  if (!match) throw new Error(`No Blockradar asset found for ${symbol} on ${chain}`);

  assetIdCache.set(cacheKey, { assetId: match.id, expiresAt: Date.now() + ASSET_CACHE_TTL_MS });
  return match.id;
}

interface WithdrawResponse {
  data: {
    hash?: string;
    status?: string;
    errors?: unknown[];
    success?: Array<{ id: string; status: string }>;
  };
}

// docs.blockradar.co — POST /wallets/{walletId}/addresses generates a
// dedicated deposit address under the master wallet created via the
// dashboard. `name`/`metadata` are the only place to attach the verified
// identity this address belongs to — Blockradar has no separate
// "customer email" field.
export const blockradarWalletAdapter: WalletAdapter = {
  async createWallet({ userId, email }): Promise<CreatedWallet> {
    const { apiKey, walletId } = requireBlockradarConfig();

    const res = await fetch(`${env.blockradarBaseUrl}/wallets/${walletId}/addresses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        name: email ?? userId,
        metadata: { userId, email },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Blockradar address generation failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as GenerateAddressResponse;

    return {
      externalWalletId: json.data.id,
      address: json.data.address,
      chain: json.data.blockchain.slug,
    };
  },

  // docs.blockradar.co — POST /wallets/{walletId}/withdraw (no address
  // sub-path) pays out directly from the master wallet, which is where every
  // deposit ends up anyway: this wallet has auto-sweep enabled
  // (confirmed live via a real webhook payload — isAutoSweep: true), so
  // Blockradar itself consolidates every user's deposit here immediately,
  // without any code on our side. Paying sends out from here instead of a
  // separately-held wallet means one fewer private key in existence, and
  // reuses the exact same trust model (their API key) as every other
  // Blockradar call in this codebase.
  async withdraw(input: WithdrawInput): Promise<WithdrawResult> {
    const { apiKey, walletId } = requireBlockradarConfig();
    const assetId = await resolveAssetId(apiKey, walletId, input.chain, input.tokenSymbol);

    const res = await fetch(`${env.blockradarBaseUrl}/wallets/${walletId}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        assetId,
        address: input.toAddress,
        amount: input.amount,
        reference: input.reference,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Blockradar master wallet withdraw failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as WithdrawResponse;
    if (json.data.errors && json.data.errors.length > 0) {
      throw new Error(`Blockradar master wallet withdraw rejected: ${JSON.stringify(json.data.errors)}`);
    }

    // A 200 with no errors and no hash is a legitimate outcome, not a
    // failure — confirmed live: a master-wallet withdraw can go through
    // AML/compliance screening before broadcasting, and the API returns
    // immediately without a hash while that's pending. The real hash arrives
    // later via the withdraw.success webhook (routes/blockradarWebhook.ts),
    // matched back to this send by `reference`, not by hash (we don't have
    // one yet). Do not treat this as an error — a caller that does will mark
    // a send FAILED and refund it while Blockradar goes on to actually pay
    // the recipient, a real double-spend confirmed to have happened live.
    const hash = json.data.hash ?? json.data.success?.[0]?.id ?? null;
    const status = json.data.status ?? json.data.success?.[0]?.status ?? "PENDING";
    return { txHash: hash, status };
  },
};
