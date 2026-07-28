export type TxReceiptStatus = {
  txHash: `0x${string}`;
  status: "pending" | "success" | "failed";
  blockNumber?: string;
  gasUsed?: string;
};

/** Minimal RPC surface so callers are not tied to a specific viem install. */
export type TxStatusReader = {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    gasUsed: bigint;
  }>;
  getTransaction(args: { hash: `0x${string}` }): Promise<unknown>;
};

export async function fetchTxReceiptStatus(
  client: TxStatusReader,
  hash: `0x${string}`,
): Promise<TxReceiptStatus> {
  const receipt = await client
    .getTransactionReceipt({ hash })
    .catch(() => null);
  if (!receipt) {
    const tx = await client.getTransaction({ hash }).catch(() => null);
    if (!tx) {
      return { txHash: hash, status: "pending" };
    }
    return { txHash: hash, status: "pending" };
  }
  return {
    txHash: hash,
    status: receipt.status === "success" ? "success" : "failed",
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
  };
}
