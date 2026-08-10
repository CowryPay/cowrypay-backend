import type { Chain } from "viem";
import { celo, base, optimism } from "viem/chains";
import { parseEther, parseUnits } from "viem";
import { env } from "../../config/env.js";

export interface ChainConfig {
  viemChain: Chain;
  rpcUrl: string;
  usdcAddress: `0x${string}`;
  usdcDecimals: number;
  // Native token, chain-specific — ETH on the L2s below is a very
  // different order of value than CELO, so these aren't shared constants.
  gasTopUpAmount: bigint;
  gasBufferThreshold: bigint;
}

// USDC contract addresses verified on-chain (symbol()/decimals()) before
// being hardcoded here — see the Phase 6 migration plan. One KMS key
// derives one address valid on every chain listed here (same curve, same
// derivation), so adding a chain never requires new wallet rows.
const CHAIN_REGISTRY: Record<string, ChainConfig> = {
  celo: {
    viemChain: celo,
    rpcUrl: env.celoRpcUrl,
    usdcAddress: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    usdcDecimals: 6,
    // Confirmed live that the previous values (0.01 / 0.005) were no longer
    // sufficient: at a real, current Celo gas price of 202.5 gwei, one
    // standard ERC-20 transfer costs ~0.0132 CELO — above both the old
    // top-up amount AND the old buffer threshold, which produced a
    // real, permanently-stuck failure mode: a wallet topped up to exactly
    // 0.01 CELO sits *above* a 0.005 threshold (so no further top-up ever
    // triggers) while still genuinely short of what a transfer costs,
    // wedging that wallet's sweep forever until manually intervened.
    // Raised with real margin over today's cost (not just "many times
    // over" as an untested claim) — still a fixed constant, not a dynamic
    // estimate, for the same zero-balance-sender reason as before, but
    // sized against an actual observed price rather than an assumption.
    gasTopUpAmount: parseEther("0.05"),
    gasBufferThreshold: parseEther("0.02"),
  },
  base: {
    viemChain: base,
    rpcUrl: env.baseRpcUrl,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDecimals: 6,
    // Base is an L2 with very cheap gas (a standard ERC-20 transfer costs a
    // small fraction of this) — a starting point, worth tuning
    // operationally rather than treated as precisely calibrated. Lowered
    // from an initial, overly generous 0.0005 after real-world testing.
    gasTopUpAmount: parseEther("0.0001"),
    gasBufferThreshold: parseEther("0.00003"),
  },
  // No off-ramp provider actually supports Optimism in practice (2026-08) —
  // dropped from ai-agent/chat/intent.ts's DEPOSIT_CHAINS so it's no longer
  // offered as a new deposit option. Deliberately kept here, though: this
  // registry still drives deposit scanning/sweeping/gas monitoring, and the
  // deposit address is the same one shared across every EVM chain (one KMS
  // key) — someone could still send USDC here by accident, and any
  // existing balance must stay detectable/sweepable/off-rampable
  // regardless of whether it's still offered going forward.
  optimism: {
    viemChain: optimism,
    rpcUrl: env.optimismRpcUrl,
    usdcAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    usdcDecimals: 6,
    gasTopUpAmount: parseEther("0.0001"),
    gasBufferThreshold: parseEther("0.00003"),
  },
};

export const SUPPORTED_CHAINS = Object.keys(CHAIN_REGISTRY);

export function getChainConfig(chain: string): ChainConfig {
  const config = CHAIN_REGISTRY[chain.toLowerCase()];
  if (!config) {
    throw new Error(`Unsupported chain: ${chain} (supported: ${SUPPORTED_CHAINS.join(", ")})`);
  }
  return config;
}

// Not worth spending gas to move less than this — shared across chains
// since it's expressed in USDC (6 decimals everywhere), not native token.
export const MIN_SWEEP_USDC = parseUnits("0.01", 6);
