import { getChainDefinition } from "./chainDefinitions.js";
import { initiateCctpBurn, checkCctpStatus } from "./cctpBridge.js";
import type { BridgeAdapter, BridgeInitiateInput, BridgeInitiateResult, BridgePhaseCheckResult, BridgeQuote } from "./adapter.js";

// cctpBridge.ts's signing path is actually wired up for base, optimism,
// and solana (built on Circle's official SDK — see that file's own
// comment: adapter-viem-v2 for the EVM chains, adapter-solana-kit for
// Solana). Optimism is deliberately withheld from SUPPORTED_CHAINS below
// even though it's signing-capable — deposits on Optimism are on hold
// (see DEPOSIT_CHAINS in ai-agent/chat/intent.ts), so there's currently
// no way for a user to actually hold an Optimism balance to send from,
// and offering it as a destination would be inconsistent with that hold.
// Re-enabling is a one-line change once Optimism deposits ship. Stellar
// is a real CCTP domain too but has no official Circle adapter yet, so
// it isn't registered in chainDefinitions.ts at all. Kept as its own set
// here (not just "whatever chainDefinitions.ts happens to have"),
// separate from data availability, so adding a chain definition there in
// the future doesn't silently enable a route before its signing path
// actually exists.
const SUPPORTED_CHAINS = new Set(["base", "solana"]);

export const cctpAdapter: BridgeAdapter = {
  // Checks both "does Circle's SDK have a chain definition for this" AND
  // "is this chain's signing path actually wired up in cctpBridge.ts" —
  // callers should be able to trust supports() as the true "can this
  // actually go through right now" answer, not just "is there some data
  // about this chain somewhere."
  supports(sourceChain: string, destinationChain: string): boolean {
    return (
      Boolean(getChainDefinition(sourceChain)) &&
      Boolean(getChainDefinition(destinationChain)) &&
      SUPPORTED_CHAINS.has(sourceChain.toLowerCase()) &&
      SUPPORTED_CHAINS.has(destinationChain.toLowerCase())
    );
  },

  async quote(input): Promise<BridgeQuote> {
    // CCTP V2 standard transfer moves 1:1 (no swap, no slippage — a real
    // burn-and-mint of the same asset) and the fee is charged separately
    // via computeCryptoWithdrawalFeeSplit before this is ever called, so
    // destinationAmount always equals the (already net-of-platform-fee)
    // input amount. estimatedSeconds is a placeholder — SLOW-mode CCTP
    // attestation typically takes several minutes to reach full finality;
    // worth measuring against real transfers rather than promising an
    // unverified number.
    return { estimatedSeconds: 900, destinationAmount: input.amount };
  },

  async initiate(input: BridgeInitiateInput): Promise<BridgeInitiateResult> {
    if (!SUPPORTED_CHAINS.has(input.sourceChain.toLowerCase()) || !SUPPORTED_CHAINS.has(input.destinationChain.toLowerCase())) {
      throw new Error(
        `Cross-chain send between ${input.sourceChain} and ${input.destinationChain} isn't available yet.`,
      );
    }
    return initiateCctpBurn(input);
  },

  async checkStatus(bridgeReference: Record<string, unknown>): Promise<BridgePhaseCheckResult> {
    return checkCctpStatus(bridgeReference);
  },
};
