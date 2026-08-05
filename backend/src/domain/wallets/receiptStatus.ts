import { createPublicClient, http, TransactionReceiptNotFoundError } from "viem";
import { getChainConfig } from "./chains.js";

// Kept separate from any DB orchestration so it can be verified directly
// against real transaction hashes — a receipt's status is a definitive,
// final on-chain outcome, unlike the ambiguous "200, no hash yet" pending
// state Blockradar's withdraw API can return (see blockradarAdapter.ts):
// there is no risk in acting on "reverted" here the way there was in
// treating that earlier ambiguous state as a failure.
export async function getReceiptStatus(chain: string, hash: string): Promise<"success" | "reverted" | "pending"> {
  const { viemChain, rpcUrl } = getChainConfig(chain);
  const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  try {
    const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
    return receipt.status === "success" ? "success" : "reverted";
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) {
      return "pending";
    }
    throw err;
  }
}
