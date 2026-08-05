import { env } from "../../config/env.js";
import type { WalletAdapter } from "./adapter.js";
import { blockradarWalletAdapter } from "./blockradarAdapter.js";
import { mockWalletAdapter } from "./mockAdapter.js";
import { awsKmsWalletAdapter } from "./awsKmsAdapter.js";

export function getWalletAdapter(): WalletAdapter {
  switch (env.walletProvider) {
    case "mock":
      return mockWalletAdapter;
    case "blockradar":
      return blockradarWalletAdapter;
    // Phase 1 (wallet creation only) of the self-custody migration — never
    // set on Railway/production, only reachable via a local/staging env
    // override. See the wallet-migration plan for what's still missing
    // (withdraw, deposit detection) before this could go live.
    case "aws-kms":
      return awsKmsWalletAdapter;
    default:
      throw new Error(`Unknown WALLET_PROVIDER: ${env.walletProvider}`);
  }
}
