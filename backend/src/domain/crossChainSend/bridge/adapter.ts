// Mirrors wallets/adapter.ts's WalletAdapter shape exactly in spirit: one
// interface, swappable vendor implementations (cctpAdapter.ts today,
// celoBridgeAdapter.ts once Celo's own third-party bridge is chosen —
// Celo isn't a CCTP domain at all, see bridge/domains.ts), so service.ts
// and the poller never branch on vendor themselves — see bridge/index.ts's
// getBridgeAdapter for the dispatch point.
export interface BridgeInitiateInput {
  sourceChain: string;
  destinationChain: string;
  tokenSymbol: string;
  amount: string; // net, post-fee — what actually gets bridged
  destinationAddress: string;
  reference: string;
}

export interface BridgeInitiateResult {
  // Source-leg tx hash (burn/lock) — same nullable-hash convention as
  // WithdrawResult.txHash, since some paths may accept-then-hash-later.
  sourceTxHash: string | null;
  // Opaque, adapter-specific handle needed to poll/complete the bridge
  // (CCTP's message bytes + nonce, a future vendor's own transfer id) —
  // stored as jsonb on the cross_chain_sends row, never parsed outside
  // the adapter that produced it.
  bridgeReference: Record<string, unknown>;
}

export type BridgePhase =
  | "SOURCE_PENDING" // source tx broadcast, not yet mined/final
  | "SOURCE_CONFIRMED" // burn/lock finalized on the source chain
  | "ATTESTATION_PENDING" // waiting on Circle's attestation / a bridge vendor's own confirmation
  | "DESTINATION_PENDING" // mint/release tx broadcast on the destination chain
  | "DESTINATION_CONFIRMED" // funds landed
  | "FAILED";

export interface BridgePhaseCheckResult {
  phase: BridgePhase;
  destinationTxHash?: string | null;
  detail?: string; // for logTransition's trigger string
}

export interface BridgeQuote {
  estimatedSeconds: number;
  destinationAmount: string;
}

export interface BridgeAdapter {
  supports(sourceChain: string, destinationChain: string): boolean;
  quote(input: {
    sourceChain: string;
    destinationChain: string;
    tokenSymbol: string;
    amount: string;
  }): Promise<BridgeQuote>;
  // Broadcasts the source-chain leg (burn/lock) and returns whatever
  // opaque handle checkStatus needs to keep tracking it. Does NOT wait
  // for the bridge to complete — mirrors WalletAdapter.withdraw's
  // broadcast-and-return-immediately stance for the same reason: blocking
  // here risks treating a slow-but-real confirmation as a failure.
  initiate(input: BridgeInitiateInput): Promise<BridgeInitiateResult>;
  // Polled repeatedly by crossChainSendConfirmationPoller.ts until phase
  // reaches a terminal state. One method covers every phase transition
  // rather than a method per phase, since different vendors can have a
  // different number of intermediate phases.
  checkStatus(bridgeReference: Record<string, unknown>): Promise<BridgePhaseCheckResult>;
}
