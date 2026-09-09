import { env } from "../../config/env.js";
import type { WalletAdapter, WithdrawInput, WithdrawResult } from "./adapter.js";
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
//
// `explicitProvider` makes EVM dispatch per-wallet too, not just
// per-chain. Without it, a withdraw() call would grab whatever
// WALLET_PROVIDER currently says globally, regardless of which provider
// actually custodies a given user's wallet — safe only as long as an
// environment never has two EVM providers' wallets coexisting. That
// stopped being true the moment production needed to deprecate Blockradar
// for new signups while 24 existing users (2 with real balances) still
// have Blockradar-custodied wallets: flipping WALLET_PROVIDER globally
// would make their next send sign with the wrong key entirely. Callers
// that already have a wallet row in hand (offramp/service.ts) pass
// wallet.provider explicitly; callers creating a brand-new wallet
// (users/service.ts) have no existing provider to honor, so they
// correctly fall through to the current env default.
export function getWalletAdapter(chain: string, explicitProvider?: string): WalletAdapter {
  const c = chain.toLowerCase();
  if (c === "stellar") return stellarWalletAdapter;
  if (c === "solana") return solanaWalletAdapter;
  const provider = explicitProvider ?? env.walletProvider;
  switch (provider) {
    case "mock":
      return mockWalletAdapter;
    case "blockradar":
      return blockradarWalletAdapter;
    case "aws-kms":
      return awsKmsWalletAdapter;
    default:
      throw new Error(`Unknown wallet provider: ${provider}`);
  }
}

// Real incident (2026-09-08): a Solana fee sweep (offramp/service.ts) hit
// solanaAdapter.ts's own "Solana transaction expired before confirmation
// (blockhash no longer valid)" — that message only fires after
// confirmByPolling already rebroadcast for the full ~60-90s blockhash
// window and it still never landed, so a single naive retry wouldn't
// help; what does is building a genuinely fresh transaction (new
// blockhash) and trying again. Same root cause and same fix shape already
// proven for a different call site — stellarCctpAdapter.ts's own
// MAX_BURN_ATTEMPTS loop for a dropped Solana-sourced CCTP burn — but
// that fix lived inside one specific adapter method, not something the
// THREE separate fee-sweep call sites (offramp/service.ts,
// crossChainSend/service.ts, cryptoWithdrawals/service.ts — all sharing
// this exact "best-effort withdraw(), catch, log fee_sweep_failed" shape)
// could reuse. Centralized here instead of copied three times. Confirmed
// live (via stellarCctpAdapter.ts's own investigation) that a dropped
// Solana tx never touches chain state, so retrying from scratch is safe —
// matched narrowly on this exact message, not a blanket retry-on-any-
// error, so a real revert or validation failure still surfaces
// immediately instead of being retried pointlessly.
const SOLANA_DROPPED_TX_MESSAGE = /expired before confirmation/i;
const MAX_WITHDRAW_ATTEMPTS = 3;

export async function withdrawWithDroppedTxRetry(adapter: WalletAdapter, input: WithdrawInput): Promise<WithdrawResult> {
  for (let attempt = 1; attempt <= MAX_WITHDRAW_ATTEMPTS; attempt++) {
    try {
      return await adapter.withdraw(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!SOLANA_DROPPED_TX_MESSAGE.test(message) || attempt === MAX_WITHDRAW_ATTEMPTS) throw err;
      console.log(`[withdraw-retry] dropped tx on attempt ${attempt}/${MAX_WITHDRAW_ATTEMPTS} for ${input.chain} withdraw (ref ${input.reference}), retrying with a fresh transaction:`, message);
    }
  }
  throw new Error("unreachable");
}
