import { env } from "../../config/env.js";
import type { WalletAdapter } from "./adapter.js";
import { blockradarWalletAdapter } from "./blockradarAdapter.js";
import { mockWalletAdapter } from "./mockAdapter.js";
import { awsKmsWalletAdapter } from "./awsKmsAdapter.js";
import { stellarWalletAdapter } from "./stellarAdapter.js";
import { solanaWalletAdapter } from "./solanaAdapter.js";

// Chain-aware, not just a flat WALLET_PROVIDER switch: Stellar's shared-
// address/memo model and Solana's per-user self-custody model are both
// wholly separate custody paths that must run alongside whichever EVM
// provider is active (a user can hold USDC on Celo, Stellar, and Solana
// all at once), not replace it — so both are checked first, independent of
// env.walletProvider entirely.
export function getWalletAdapter(chain: string): WalletAdapter {
  const c = chain.toLowerCase();
  if (c === "stellar") return stellarWalletAdapter;
  if (c === "solana") return solanaWalletAdapter;
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
