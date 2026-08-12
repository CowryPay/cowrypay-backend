import { createPublicClient, formatUnits, formatEther, http } from "viem";
import { Horizon } from "@stellar/stellar-sdk";
import { createSolanaRpc, address as toSolanaAddress } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { env } from "../../config/env.js";
import { getChainConfig, SUPPORTED_CHAINS } from "../wallets/chains.js";
import { getWalletAddress } from "../wallets/awsKmsAdapter.js";
import { getSolanaTreasurySigner } from "../wallets/solanaKms.js";

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface WalletBalance {
  chain: string;
  address: string | null;
  usdc: string | null;
  native: { symbol: string; amount: string } | null;
  error: string | null;
}

// One bad RPC call (a chain being briefly down, a misconfigured address)
// must not take out every other chain's balance with it — same "isolate
// per-item failures" stance as every poller in this codebase.
async function safeBalance(chain: string, address: string | null, fn: () => Promise<WalletBalance>): Promise<WalletBalance> {
  if (!address) return { chain, address: null, usdc: null, native: null, error: "address not configured" };
  try {
    return await fn();
  } catch (err) {
    return { chain, address, usdc: null, native: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function evmUsdcOnly(chain: string, address: `0x${string}`): Promise<WalletBalance> {
  const { viemChain, rpcUrl, usdcAddress, usdcDecimals } = getChainConfig(chain);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const raw = await publicClient.readContract({ address: usdcAddress, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address] });
  return { chain, address, usdc: formatUnits(raw, usdcDecimals), native: null, error: null };
}

async function evmWithNative(chain: string, address: `0x${string}`, nativeSymbol: string): Promise<WalletBalance> {
  const { viemChain, rpcUrl, usdcAddress, usdcDecimals } = getChainConfig(chain);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const [usdcRaw, nativeRaw] = await Promise.all([
    publicClient.readContract({ address: usdcAddress, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address] }),
    publicClient.getBalance({ address }),
  ]);
  return {
    chain,
    address,
    usdc: formatUnits(usdcRaw, usdcDecimals),
    native: { symbol: nativeSymbol, amount: formatEther(nativeRaw) },
    error: null,
  };
}

async function stellarBalance(address: string, includeNative: boolean): Promise<WalletBalance> {
  if (!env.stellarUsdcIssuer) throw new Error("STELLAR_USDC_ISSUER not configured");
  const server = new Horizon.Server(env.stellarHorizonUrl);
  const account = await server.loadAccount(address);
  const usdcLine = account.balances.find(
    (b: any) => b.asset_code === "USDC" && b.asset_issuer === env.stellarUsdcIssuer,
  ) as { balance: string } | undefined;
  const nativeLine = includeNative ? account.balances.find((b: any) => b.asset_type === "native") : undefined;
  return {
    chain: "stellar",
    address,
    usdc: usdcLine?.balance ?? "0",
    native: nativeLine ? { symbol: "XLM", amount: (nativeLine as { balance: string }).balance } : null,
    error: null,
  };
}

async function solanaBalance(address: string, includeNative: boolean): Promise<WalletBalance> {
  const rpc = createSolanaRpc(env.solanaRpcUrl);
  const owner = toSolanaAddress(address);
  const mint = toSolanaAddress(env.solanaUsdcMint);
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  const [tokenBalance, nativeBalance] = await Promise.all([
    rpc.getTokenAccountBalance(ata).send().catch(() => null),
    includeNative ? rpc.getBalance(owner).send() : Promise.resolve(null),
  ]);

  return {
    chain: "solana",
    address,
    usdc: tokenBalance?.value.uiAmountString ?? "0",
    native: nativeBalance ? { symbol: "SOL", amount: (Number(nativeBalance.value) / 1e9).toString() } : null,
    error: null,
  };
}

export interface TreasurySnapshot {
  // What the platform has actually earned — the 3 dedicated fee-sweep
  // destinations (see fee.ts's requireTreasuryAddress), never the shared
  // operational wallets below.
  feeTreasury: WalletBalance[];
  // What pays out sends and needs to stay funded — real incident this
  // session: the Solana treasury ran low on SOL and new wallet creation
  // started failing (SolanaTreasuryLiquidityError) with no visibility
  // into it until a user reported the error. This is the dashboard's
  // early-warning view into that same class of problem.
  operational: WalletBalance[];
}

export async function getTreasurySnapshot(): Promise<TreasurySnapshot> {
  const evmChains = SUPPORTED_CHAINS.filter((c) => c !== "mock-chain");
  const nativeSymbolFor = (chain: string) => (chain === "celo" ? "CELO" : "ETH");

  const feeTreasury = await Promise.all([
    ...evmChains.map((chain) =>
      safeBalance(chain, env.remittanceTreasuryAddress ?? null, () =>
        evmUsdcOnly(chain, env.remittanceTreasuryAddress as `0x${string}`),
      ),
    ),
    safeBalance("stellar", env.stellarTreasuryFeeAddress ?? null, () => stellarBalance(env.stellarTreasuryFeeAddress!, false)),
    safeBalance("solana", env.solanaTreasuryFeeAddress ?? null, () => solanaBalance(env.solanaTreasuryFeeAddress!, false)),
  ]);

  let evmPayoutAddress: `0x${string}` | null = null;
  if (env.awsKmsPayoutKeyArn) {
    try {
      evmPayoutAddress = await getWalletAddress(env.awsKmsPayoutKeyArn);
    } catch {
      evmPayoutAddress = null; // surfaced per-chain below via safeBalance's "address not configured" path
    }
  }

  let solanaTreasuryAddress: string | null = null;
  try {
    solanaTreasuryAddress = (await getSolanaTreasurySigner()).address;
  } catch {
    solanaTreasuryAddress = null;
  }

  const operational = await Promise.all([
    ...evmChains.map((chain) =>
      safeBalance(chain, evmPayoutAddress, () => evmWithNative(chain, evmPayoutAddress!, nativeSymbolFor(chain))),
    ),
    safeBalance("stellar", env.stellarDepositAddress ?? null, () => stellarBalance(env.stellarDepositAddress!, true)),
    safeBalance("solana", solanaTreasuryAddress, () => solanaBalance(solanaTreasuryAddress!, true)),
  ]);

  return { feeTreasury, operational };
}
