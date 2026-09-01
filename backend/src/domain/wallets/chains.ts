import type { Chain } from "viem";
import { celo, base, optimism, mainnet } from "viem/chains";
import { parseEther, parseUnits } from "viem";
import { env } from "../../config/env.js";

export interface TokenConfig {
  address: `0x${string}`;
  decimals: number;
}

export interface ChainConfig {
  viemChain: Chain;
  rpcUrl: string;
  // Keyed by uppercase symbol ("USDC", "USDT"). A chain that doesn't
  // support a given token simply has no entry — getTokenConfig throws a
  // clear "not supported" error rather than that being checked separately
  // in every caller.
  tokens: Record<string, TokenConfig>;
  // Native token, chain-specific — ETH on the L2s below is a very
  // different order of value than CELO, so these aren't shared constants.
  gasTopUpAmount: bigint;
  gasBufferThreshold: bigint;
}

// Contract addresses verified on-chain (symbol()/decimals()) before being
// hardcoded here — see the Phase 6 migration plan (USDC) and the USDT
// rollout that added the second entry per chain. One KMS key derives one
// address valid on every chain listed here (same curve, same derivation),
// so adding a chain never requires new wallet rows.
const CHAIN_REGISTRY: Record<string, ChainConfig> = {
  celo: {
    viemChain: celo,
    rpcUrl: env.celoRpcUrl,
    tokens: {
      USDC: { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6 },
      // Native Tether deployment (deployer: "Tether: Deployer" on
      // CeloScan, not a bridge) — confirmed live via decimals()/symbol()
      // eth_call before being hardcoded here, same discipline as USDC
      // above. symbol() actually returns "USD₮", displayed/traded as USDT.
      USDT: { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6 },
    },
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
    // USDT deliberately excluded here — Tether's own official
    // supported-protocols list doesn't include Base at all; the only
    // "USDT" contract on Base is a third-party bridged token Tether
    // explicitly disclaims ("not issued by, redeemable by, or affiliated
    // with Tether"). Real redemption/depeg risk, not wired in.
    tokens: {
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    },
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
    tokens: {
      USDC: { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
    },
    gasTopUpAmount: parseEther("0.0001"),
    gasBufferThreshold: parseEther("0.00003"),
  },
  // Verified live (2026-09-01): symbol()/decimals() eth_call against the
  // contract itself (not trusted from memory) returned "USDC"/6 exactly.
  // Gas constants are NOT sized off Base/Optimism's cents-level costs —
  // Ethereum mainnet gas is a different order of magnitude (a plain USDC
  // transfer real eth_estimateGas'd at 63,054 gas, in the same ~65k range
  // as every other chain here) and, critically, far more volatile than
  // any L2 this registry lists: real baseFee+priority at the time this
  // was sized was ~0.2 gwei (a standard transfer would cost ~$0.03), but
  // gas here can spike 50-100x during real congestion in a way Celo/Base/
  // Optimism essentially never do. Sized against a deliberately more
  // cautious ~10 gwei baseline instead of that quiet observed price —
  // gasStatusMonitor.ts is what's relied on to catch a genuine spike
  // beyond this, not a bigger static buffer.
  ethereum: {
    viemChain: mainnet,
    rpcUrl: env.ethereumRpcUrl,
    tokens: {
      USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    },
    gasTopUpAmount: parseEther("0.005"),
    gasBufferThreshold: parseEther("0.002"),
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

export function getTokenConfig(chain: string, tokenSymbol: string): TokenConfig {
  const chainConfig = getChainConfig(chain);
  const token = chainConfig.tokens[tokenSymbol.toUpperCase()];
  if (!token) {
    throw new Error(
      `${tokenSymbol} is not supported on ${chain} (supported here: ${Object.keys(chainConfig.tokens).join(", ")})`,
    );
  }
  return token;
}

export function getSupportedTokens(chain: string): string[] {
  return Object.keys(getChainConfig(chain).tokens);
}

// Not worth spending gas to move less than this — shared across chains and
// tokens since both USDC and USDT use 6 decimals everywhere we support them.
export const MIN_SWEEP_TOKEN_AMOUNT = parseUnits("0.01", 6);
