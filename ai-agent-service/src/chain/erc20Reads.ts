import type { PublicClient } from "viem";
import { erc20Abi } from "viem";

export async function readErc20Balance(
  client: PublicClient,
  token: `0x${string}`,
  owner: `0x${string}`,
): Promise<bigint> {
  const v = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
  return v as bigint;
}

export async function readErc20Allowance(
  client: PublicClient,
  token: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  const v = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
  return v as bigint;
}
