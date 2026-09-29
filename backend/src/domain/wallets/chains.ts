import type { Chain } from "viem";
import { celo, base, optimism, mainnet, arc } from "viem/chains";
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
  // different order of value than CELO, so this isn't a shared constant.
  // Only used by gasStatusMonitor.ts to alert on the PAYOUT wallet's own
  // balance — how much to actually top up a user's deposit wallet is
  // computed dynamically now (see depositSweeper.ts's estimateGasTopUp),
  // not a second static guess here (see that file's own comment on the
  // real incident a fixed gasTopUpAmount caused).
  gasBufferThreshold: bigint;
  // Set only where one of `tokens` IS this chain's native gas token — one
  // shared balance exposed two ways, not two separate balances (Arc: USDC).
  // depositScanner.ts and depositSweeper.ts both branch on this; see Arc's
  // entry below for exactly why neither can treat such a token like a
  // plain ERC-20.
  nativeToken?: {
    symbol: string;
    // Emits a standard Transfer(from, to, value) log — in native 18-decimal
    // units — for EVERY movement of the native token, whether sent natively
    // or via the ERC-20 interface.
    transferLogAddress: `0x${string}`;
  };
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
    // Real incident this threshold's own history warns about: an earlier
    // static top-up amount (0.01 CELO) topped a wallet up to sit *above* an
    // equally-static 0.005 threshold while still genuinely short of what a
    // real transfer cost (0.0132 CELO at a real observed 202.5 gwei) —
    // wedging that wallet's sweep forever, since no further top-up ever
    // triggered. The top-up amount itself is computed dynamically now (see
    // depositSweeper.ts's estimateGasTopUp) specifically to stop recurring
    // this same class of bug; this threshold only gates gasStatusMonitor.ts's
    // alert on the shared PAYOUT wallet's own balance, kept with real
    // margin over a normal transfer's cost.
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
    // Base is an L2 with very cheap gas — this only gates
    // gasStatusMonitor.ts's alert on the payout wallet's own balance now
    // (see depositSweeper.ts's estimateGasTopUp for how much a user's
    // deposit wallet actually gets topped up, computed dynamically).
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
    gasBufferThreshold: parseEther("0.00003"),
  },
  // Verified live (2026-09-01): symbol()/decimals() eth_call against the
  // contract itself (not trusted from memory) returned "USDC"/6 exactly.
  // Ethereum mainnet gas is a different order of magnitude from the L2s
  // above (a plain USDC transfer real eth_estimateGas'd at 63,054 gas, in
  // the same ~65k range as every other chain here) and, critically, far
  // more volatile — real baseFee+priority observed as low as ~0.2-0.4
  // gwei one moment (a standard transfer costs ~$0.03-0.06 then) but able
  // to spike 50-100x during real congestion in a way Celo/Base/Optimism
  // essentially never do.
  //
  // Real incident (2026-09-18): a static top-up amount here (0.005 ETH,
  // nominally "a cautious ~10 gwei baseline") was actually ~7x more than
  // that baseline math requires, and didn't scale DOWN when real gas was
  // far cheaper — silently sending ~$12 of unrecoverable dust into a
  // user's own deposit wallet on every single top-up, which is why the
  // shared payout wallet kept running dry despite repeated manual
  // funding. Fixed by computing the top-up dynamically against the
  // CURRENT price instead of guessing a fixed one (see
  // depositSweeper.ts's estimateGasTopUp) — this threshold only gates
  // gasStatusMonitor.ts's alert on the payout wallet's own balance now.
  ethereum: {
    viemChain: mainnet,
    rpcUrl: env.ethereumRpcUrl,
    tokens: {
      USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    },
    gasBufferThreshold: parseEther("0.002"),
  },
  // Circle's Arc L1 (chain id 5042, mainnet since 2026-09-16), EVM-
  // compatible, so the same KMS-derived address works here unchanged.
  // Verified live (2026-09-24) via eth_call against the contract itself:
  // symbol() "USDC", decimals() 6.
  //
  // Unlike every chain above, USDC is ALSO Arc's native gas token (18
  // decimals natively), and the two are ONE balance: confirmed live that
  // balanceOf() here always equals getBalance() / 1e12 for the same
  // address. Two consequences, both confirmed against real mainnet
  // receipts, not docs:
  //  - A plain native send emits a Transfer log ONLY from
  //    0xff...fe (the system emitter below), never from the ERC-20
  //    contract — watching the contract alone (as every other chain's
  //    scanning does) would silently miss a user who sends USDC the
  //    ordinary way from their wallet, while the sweeper's balanceOf still
  //    sees it and sweeps it away, uncredited. An ERC-20 transfer() emits
  //    one log from EACH, so depositScanner.ts watches the emitter instead
  //    of the contract — every movement exactly once either way.
  //  - Gas for a deposit wallet's own sweep is paid out of the very USDC
  //    being swept, so no gas top-up from the payout wallet is ever
  //    needed (or wanted — a top-up would itself be a native USDC send
  //    into the user's address, and credited as a deposit by the emitter
  //    watch above). depositSweeper.ts sweeps natively, minus a gas reserve.
  arc: {
    viemChain: arc,
    rpcUrl: env.arcRpcUrl,
    tokens: {
      USDC: { address: "0x3600000000000000000000000000000000000000", decimals: 6 },
    },
    nativeToken: { symbol: "USDC", transferLogAddress: "0xfffffffffffffffffffffffffffffffffffffffe" },
    // In native USDC (18 decimals) — no top-ups ever come out of the payout
    // wallet here, so this only needs to cover its own withdrawal/fee-sweep
    // gas: a real ERC-20 transfer eth_estimateGas'd at 49,314 gas, ~0.0012
    // USDC at the real 24.1 gwei maxFeePerGas observed — ~80 transfers'
    // worth. The payout's USDC liquidity and gas are the same balance here,
    // so falling below this means it's genuinely out of both.
    gasBufferThreshold: parseEther("0.1"),
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
