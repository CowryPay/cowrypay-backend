import { env } from "../../config/env.js";
import type { CreatedWallet, WalletAdapter } from "./adapter.js";

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
};
