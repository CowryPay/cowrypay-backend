import { encodeFunctionData, parseUnits } from "viem";
import { agentSendTx, waitForAgentTx } from "./agentWallet.js";

// Verified on-chain (not just docs) via eth_call against symbol()/decimals()
// on Celo mainnet — returns "USDC" / 6, confirming this is the real token.
const CELO_USDC_ADDRESS = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const;
const USDC_DECIMALS = 6;

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// Pays out USDC directly from the agent wallet (which holds funds swept in
// from user deposits, see domain/deposits/stateMachine.ts) rather than
// withdrawing from any individual user's Blockradar wallet. Waits for
// on-chain confirmation before returning, matching the rest of the send
// flow's "confirm before proceeding" pattern.
export async function sendUsdcFromAgent(to: `0x${string}`, amountHuman: string): Promise<`0x${string}`> {
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [to, parseUnits(amountHuman, USDC_DECIMALS)],
  });
  const hash = await agentSendTx(CELO_USDC_ADDRESS, data);
  await waitForAgentTx(hash);
  return hash;
}
