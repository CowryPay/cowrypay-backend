import { parseEther } from "viem";
import { env } from "../../config/env.js";
import { agentSendTx, getAgentWallet, waitForAgentTx } from "./agentWallet.js";

// Only Celo is wired up — that's the only chain Blockradar has actually
// rejected a withdraw on for lack of gas. Add more chains here only once
// they're actually needed.
const SUPPORTED_CHAINS = new Set(["celo"]);

// Blockradar rejects a withdraw outright if the source address holds no
// native gas — it does not sponsor gas itself (confirmed via a real 400:
// "Insufficient CELO balance for network fee, you have 0 CELO"). Tops the
// address up from the agent wallet only when actually needed, and waits for
// the top-up to confirm before returning, since Blockradar checks the real
// on-chain balance at broadcast time. Used before sweeping a deposit out of
// a user's Blockradar wallet into the agent wallet — sends themselves no
// longer originate from a user's own wallet, see domain/wallets/agentPayout.ts.
export async function ensureGasFunded(address: `0x${string}`, chain: string): Promise<void> {
  if (!SUPPORTED_CHAINS.has(chain)) {
    throw new Error(`No gas-station support configured for chain "${chain}"`);
  }

  const { publicClient } = getAgentWallet();
  const topupAmount = parseEther(env.gasStationTopupAmount);
  const threshold = topupAmount / 2n;

  const balance = await publicClient.getBalance({ address });
  if (balance >= threshold) return;

  const hash = await agentSendTx(address, "0x", topupAmount);
  await waitForAgentTx(hash);
}
