import { Arc, Base, Optimism, Solana, type ChainDefinition } from "@circle-fin/bridge-kit";

// Replaces the original hand-verified domains.ts registry entirely —
// these are Circle's own officially-maintained chain definitions
// (contract addresses, CCTP domain IDs, etc. all live inside them), not
// something this codebase hand-derives and gates on a `verified` flag
// anymore. Stellar is a real CCTP domain too but has no official Circle
// adapter yet (Phase 2 continued); Celo isn't a CCTP domain at all (needs
// a different bridge entirely, Phase 3). Arc (CCTP domain 26) needs
// bridge-kit >= 1.15.0 — 1.13.0 only shipped Arc Testnet.
export const CHAIN_DEFINITIONS: Record<string, ChainDefinition | undefined> = {
  arc: Arc,
  base: Base,
  optimism: Optimism,
  solana: Solana,
};

export function getChainDefinition(chain: string): ChainDefinition | undefined {
  return CHAIN_DEFINITIONS[chain.toLowerCase()];
}
