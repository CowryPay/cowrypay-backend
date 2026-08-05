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
    // Comfortably covers a standard ERC-20 transfer's gas on Celo many
    // times over — a fixed constant rather than a dynamic estimate, since
    // estimating gas for a sender with zero balance is unreliable.
    gasTopUpAmount: parseEther("0.01"),
    gasBufferThreshold: parseEther("0.005"),
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
