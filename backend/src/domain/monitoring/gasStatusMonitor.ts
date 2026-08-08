import { createPublicClient, http, formatEther } from "viem";
import { Horizon } from "@stellar/stellar-sdk";
import { address as toAddress, createSolanaRpc } from "@solana/kit";
import { env } from "../../config/env.js";
import { getChainConfig, SUPPORTED_CHAINS } from "../wallets/chains.js";
import { getWalletAddress } from "../wallets/awsKmsAdapter.js";
import { getSolanaTreasurySigner } from "../wallets/solanaKms.js";
import { sendTelegramOpsAlert } from "./telegram.js";

interface BalanceCheck {
  key: string; // stable id for alert-state tracking, e.g. "base-gas"
  label: string; // human-readable, e.g. "Base gas (ETH)"
  balance: string;
  threshold: string;
  ok: boolean;
}

// Gas only, deliberately not USDC liquidity — this monitor exists
// specifically so the payout wallet never gets too low on native token to
// send the sweep's own gas top-up to a user's deposit address (the exact
// "total cost of executing this transaction exceeds the balance of the
// account" incident that motivated building this at all). USDC liquidity
// for withdrawals is a real, separate concern, but not this monitor's job.
async function checkEvmChain(chain: string, payoutAddress: `0x${string}`): Promise<BalanceCheck[]> {
  const { viemChain, rpcUrl, gasBufferThreshold } = getChainConfig(chain);
  const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });

  const nativeBalance = await client.getBalance({ address: payoutAddress });

  return [
    {
      key: `${chain}-gas`,
      label: `${chain} gas (native)`,
      balance: formatEther(nativeBalance),
      threshold: formatEther(gasBufferThreshold),
      ok: nativeBalance >= gasBufferThreshold,
    },
  ];
}

async function checkStellar(): Promise<BalanceCheck[]> {
  if (!env.stellarDepositAddress) return [];
  const server = new Horizon.Server(env.stellarHorizonUrl);
  const account = await server.loadAccount(env.stellarDepositAddress);

  const nativeBalance = Number(account.balances.find((b) => b.asset_type === "native")?.balance ?? "0");
  const xlmThreshold = Number(env.stellarXlmAlertThreshold);

  return [
    {
      key: "stellar-gas",
      label: "Stellar gas (XLM)",
      balance: String(nativeBalance),
      threshold: String(xlmThreshold),
      ok: nativeBalance >= xlmThreshold,
    },
  ];
}

async function checkSolana(): Promise<BalanceCheck[]> {
  if (!env.solanaTreasurySigningKeyCiphertext) return [];
  const treasury = await getSolanaTreasurySigner();
  const rpc = createSolanaRpc(env.solanaRpcUrl);
  const owner = toAddress(treasury.address);

  const solBalance = await rpc.getBalance(owner).send();
  const solThreshold = Number(env.solanaSolAlertThreshold);
  const solBalanceHuman = Number(solBalance.value) / 1e9;

  return [
    {
      key: "solana-gas",
      label: "Solana treasury (SOL)",
      balance: String(solBalanceHuman),
      threshold: String(solThreshold),
      ok: solBalanceHuman >= solThreshold,
    },
  ];
}

// Which checks are currently below threshold, as of the last cycle — used
// to alert only on a state CHANGE (crossing below, or recovering back
// above) instead of repeating the same alert every single cycle forever
// while a wallet stays low. Resets on deploy/restart (in-memory, not
// DB-backed) — the acceptable cost of keeping this simple is at most one
// duplicate alert right after a deploy, not an ongoing spam risk.
const currentlyBreached = new Set<string>();

async function getAllChecks(): Promise<BalanceCheck[]> {
  const checks: BalanceCheck[] = [];

  if (env.awsKmsPayoutKeyArn) {
    const payoutAddress = await getWalletAddress(env.awsKmsPayoutKeyArn);
    for (const chain of SUPPORTED_CHAINS) {
      checks.push(...(await checkEvmChain(chain, payoutAddress)));
    }
  }
  checks.push(...(await checkStellar()));
  checks.push(...(await checkSolana()));
  return checks;
}

// Fast-path detection, on the same 10-minute cadence as the deposit
// sweeper — only posts when something actually crosses a threshold
// (either direction), so this alone never spams the channel.
export async function runGasStatusCheck(): Promise<void> {
  const checks = await getAllChecks();

  const newlyBreached = checks.filter((c) => !c.ok && !currentlyBreached.has(c.key));
  const recovered = checks.filter((c) => c.ok && currentlyBreached.has(c.key));

  for (const c of newlyBreached) currentlyBreached.add(c.key);
  for (const c of recovered) currentlyBreached.delete(c.key);

  if (newlyBreached.length > 0) {
    const lines = newlyBreached.map((c) => `⚠️ <b>${c.label}</b>: ${c.balance} (below threshold ${c.threshold})`);
    await sendTelegramOpsAlert(`<b>CowryPay liquidity alert</b>\n\n${lines.join("\n")}`);
  }
  if (recovered.length > 0) {
    const lines = recovered.map((c) => `✅ <b>${c.label}</b>: ${c.balance} (back above ${c.threshold})`);
    await sendTelegramOpsAlert(`<b>CowryPay liquidity recovered</b>\n\n${lines.join("\n")}`);
  }
}

// Separate from the fast-path above by design — this one always posts,
// every hour, regardless of whether anything changed, as a standing
// heartbeat ("is the monitor even still running") rather than an event
// alert. Every line is shown, healthy or not, so a quiet hour still gives
// a full picture rather than silence.
export async function sendHourlyStatusReport(): Promise<void> {
  const checks = await getAllChecks();
  const lines = checks.map(
    (c) => `${c.ok ? "✅" : "⚠️"} <b>${c.label}</b>: ${c.balance}${c.ok ? "" : ` (below threshold ${c.threshold})`}`,
  );
  await sendTelegramOpsAlert(`<b>CowryPay hourly gas/liquidity status</b>\n\n${lines.join("\n")}`);
}

const CHECK_INTERVAL_MS = 10 * 60_000;
const HOURLY_REPORT_INTERVAL_MS = 60 * 60_000;

export function startGasStatusMonitor(): void {
  setInterval(() => {
    runGasStatusCheck().catch((err) => console.error("[gas-status-monitor]", err));
  }, CHECK_INTERVAL_MS);
  setInterval(() => {
    sendHourlyStatusReport().catch((err) => console.error("[gas-status-monitor:hourly]", err));
  }, HOURLY_REPORT_INTERVAL_MS);
}
