import { createPublicClient, formatUnits, formatEther, http } from "viem";
import { Horizon } from "@stellar/stellar-sdk";
import { createSolanaRpc, address as toSolanaAddress } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { env } from "../../config/env.js";
import { getChainConfig, SUPPORTED_CHAINS } from "../wallets/chains.js";
import { getWalletAddress } from "../wallets/awsKmsAdapter.js";
import { getSolanaTreasurySigner } from "../wallets/solanaKms.js";
import { ledgerRepo } from "../ledger/repository.js";

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
  // Keyed by symbol ("USDC", "USDT") — only the tokens actually configured
  // for this chain appear here, so Base/Optimism never show a phantom USDT
  // entry. Was a single `usdc` field before USDT support existed; renamed
  // rather than kept alongside a second field so nothing silently keeps
  // reading only the old one and missing USDT balances.
  tokens: Record<string, string> | null;
  native: { symbol: string; amount: string } | null;
  error: string | null;
}

// One bad RPC call (a chain being briefly down, a misconfigured address)
// must not take out every other chain's balance with it — same "isolate
// per-item failures" stance as every poller in this codebase.
async function safeBalance(chain: string, address: string | null, fn: () => Promise<WalletBalance>): Promise<WalletBalance> {
  if (!address) return { chain, address: null, tokens: null, native: null, error: "address not configured" };
  try {
    return await fn();
  } catch (err) {
    return { chain, address, tokens: null, native: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function evmTokenBalances(chain: string, address: `0x${string}`): Promise<Record<string, string>> {
  const { viemChain, rpcUrl, tokens } = getChainConfig(chain);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const entries = await Promise.all(
    Object.entries(tokens).map(async ([symbol, cfg]) => {
      const raw = await publicClient.readContract({
        address: cfg.address,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [address],
      });
      return [symbol, formatUnits(raw, cfg.decimals)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function evmTokensOnly(chain: string, address: `0x${string}`): Promise<WalletBalance> {
  const tokens = await evmTokenBalances(chain, address);
  return { chain, address, tokens, native: null, error: null };
}

async function evmWithNative(chain: string, address: `0x${string}`, nativeSymbol: string): Promise<WalletBalance> {
  const { viemChain, rpcUrl } = getChainConfig(chain);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const [tokens, nativeRaw] = await Promise.all([evmTokenBalances(chain, address), publicClient.getBalance({ address })]);
  return {
    chain,
    address,
    tokens,
    native: { symbol: nativeSymbol, amount: formatEther(nativeRaw) },
    error: null,
  };
}

// Stellar stays USDC-only, deliberately — USDT was never added here (see
// chains.ts's own comment on the Celo/Solana-only scope decision).
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
    tokens: { USDC: usdcLine?.balance ?? "0" },
    native: nativeLine ? { symbol: "XLM", amount: (nativeLine as { balance: string }).balance } : null,
    error: null,
  };
}

async function solanaBalance(address: string, includeNative: boolean): Promise<WalletBalance> {
  const rpc = createSolanaRpc(env.solanaRpcUrl);
  const owner = toSolanaAddress(address);
  const mints: Record<string, string | undefined> = { USDC: env.solanaUsdcMint, USDT: env.solanaUsdtMint };

  const [tokenEntries, nativeBalance] = await Promise.all([
    Promise.all(
      Object.entries(mints).map(async ([symbol, mint]) => {
        if (!mint) return [symbol, "0"] as const;
        const [ata] = await findAssociatedTokenPda({ owner, mint: toSolanaAddress(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
        const balance = await rpc.getTokenAccountBalance(ata).send().catch(() => null);
        return [symbol, balance?.value.uiAmountString ?? "0"] as const;
      }),
    ),
    includeNative ? rpc.getBalance(owner).send() : Promise.resolve(null),
  ]);

  return {
    chain: "solana",
    address,
    tokens: Object.fromEntries(tokenEntries),
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
  // What we owe users, in total, per token, per chain — "operational" only
  // means something read next to this. A chain/token combination where
  // totalLedgerLiability exceeds operational's balance for that token is
  // under-collateralized right now: real user balances that the shared
  // payout wallet can't actually cover yet (normal in the moment sweeping/
  // liquidity lags a deposit, a genuine problem if it persists).
  totalLedgerLiability: Record<string, Record<string, string>>;
  // The actual comparison operational/totalLedgerLiability above only set
  // up — computed here instead of left for whoever reads the JSON to work
  // out by hand. This is the proof-of-reserves-style check: per chain and
  // token, does the shared operational wallet actually hold at least as
  // much as the ledger says users are owed, right now, verified against a
  // live on-chain read rather than trusted from internal bookkeeping
  // alone. reserveMonitor.ts alerts on this; GET /admin/treasury (this
  // snapshot) is what a diligence conversation can point an investor at.
  reconciliation: ReconciliationRow[];
}

export interface ReconciliationRow {
  chain: string;
  tokenSymbol: string;
  ledgerLiability: string;
  // null only when the operational wallet's on-chain balance couldn't be
  // read at all (RPC failure, missing address) — distinct from a
  // successful read of "0", which is a real (and real bad) shortfall.
  onChainBalance: string | null;
  deltaUsdc: string | null;
  status: "OK" | "SHORTFALL" | "UNKNOWN";
  // Set only when part (or all) of this row's delta is already traced to
  // a specific, investigated, formally-accepted write-off — see
  // KNOWN_WRITE_OFFS below. Deliberately does NOT change deltaUsdc/status:
  // the reserve check's whole value is an honest, unadjusted on-chain vs
  // ledger comparison, not one that quietly nets out accepted losses. This
  // just saves a future reader from re-investigating a gap someone
  // already ran to ground.
  note: string | null;
}

// Real, already-investigated permanent losses — each entry traced to a
// specific send's own audit trail (GET /admin/sends/:id) before being
// added here, never a guess. Small and hardcoded deliberately: as of
// 2026-08-26 there are exactly two of these across the platform's whole
// history, so a DB table would be more machinery than the problem needs;
// revisit that if this list ever stops being small.
const KNOWN_WRITE_OFFS: Array<{ chain: string; tokenSymbol: string; note: string }> = [
  {
    chain: "base",
    tokenSymbol: "USDC",
    note:
      "Includes a documented 0.99 USDC write-off (send 810f37d3-7059-47b2-a5d5-60a274acfe7b): a Centiiv order had no UGX payout rail, our payout genuinely broadcast and landed at Centiiv's temp wallet, which then moved the funds to an address outside our control. Never recovered — business decision was to absorb it, not chase recovery, and not credit the user (they were not credited).",
  },
  {
    chain: "celo",
    tokenSymbol: "USDC",
    note:
      "Includes a documented ~9.85 USDC discrepancy (send 70d26246-bc97-4c53-91f4-9cd7b92374c7): Paycrest reported an order refunded and it was auto-credited to the user per the normal flow, but no matching on-chain refund was found arriving at our registered treasury. Operator confirmed on 2026-08-26 that Paycrest returned the funds via a separate channel/arrangement.",
  },
];

// Pure display/alerting arithmetic, not a ledger write — nothing here
// updates a stored balance, so the Number() round-trip formatAmount's own
// doc comment warns against for real money movement doesn't apply the
// same way; a monitoring value being off by a fraction of a cent doesn't
// risk double-crediting or double-debiting anything.
function computeReconciliation(
  operational: WalletBalance[],
  totalLedgerLiability: Record<string, Record<string, string>>,
): ReconciliationRow[] {
  const rows: ReconciliationRow[] = [];
  for (const [tokenSymbol, byChain] of Object.entries(totalLedgerLiability)) {
    for (const [chain, ledgerLiability] of Object.entries(byChain)) {
      const wallet = operational.find((w) => w.chain === chain);
      const onChainBalance = wallet?.error ? null : (wallet?.tokens?.[tokenSymbol] ?? null);
      const knownWriteOff = KNOWN_WRITE_OFFS.find((w) => w.chain === chain && w.tokenSymbol === tokenSymbol)?.note ?? null;
      if (onChainBalance == null) {
        rows.push({ chain, tokenSymbol, ledgerLiability, onChainBalance: null, deltaUsdc: null, status: "UNKNOWN", note: knownWriteOff });
        continue;
      }
      const delta = Number(onChainBalance) - Number(ledgerLiability);
      rows.push({
        chain,
        tokenSymbol,
        ledgerLiability,
        onChainBalance,
        deltaUsdc: String(delta),
        status: delta >= 0 ? "OK" : "SHORTFALL",
        note: knownWriteOff,
      });
    }
  }
  return rows.sort((a, b) => a.chain.localeCompare(b.chain) || a.tokenSymbol.localeCompare(b.tokenSymbol));
}

// The only two tokens the platform tracks anywhere — not derived from
// chains.ts's per-chain maps since ledger liability is a global, per-token
// figure independent of which chains happen to support which token.
const LEDGER_TOKENS = ["USDC", "USDT"];

export async function getTreasurySnapshot(): Promise<TreasurySnapshot> {
  const evmChains = SUPPORTED_CHAINS.filter((c) => c !== "mock-chain");
  const nativeSymbolFor = (chain: string) => (chain === "celo" ? "CELO" : "ETH");

  const feeTreasury = await Promise.all([
    ...evmChains.map((chain) =>
      safeBalance(chain, env.remittanceTreasuryAddress ?? null, () =>
        evmTokensOnly(chain, env.remittanceTreasuryAddress as `0x${string}`),
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

  const liabilityEntries = await Promise.all(
    LEDGER_TOKENS.map(async (token) => [token, await ledgerRepo.getTotalAvailableByChain(token)] as const),
  );
  const totalLedgerLiability = Object.fromEntries(liabilityEntries);
  const reconciliation = computeReconciliation(operational, totalLedgerLiability);

  return { feeTreasury, operational, totalLedgerLiability, reconciliation };
}
