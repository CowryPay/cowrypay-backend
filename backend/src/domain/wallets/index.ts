import { env } from "../../config/env.js";
import type { WalletAdapter } from "./adapter.js";
import { blockradarWalletAdapter } from "./blockradarAdapter.js";
import { mockWalletAdapter } from "./mockAdapter.js";

export function getWalletAdapter(): WalletAdapter {
  switch (env.walletProvider) {
    case "mock":
      return mockWalletAdapter;
    case "blockradar":
      return blockradarWalletAdapter;
    default:
      throw new Error(`Unknown WALLET_PROVIDER: ${env.walletProvider}`);
  }
}
