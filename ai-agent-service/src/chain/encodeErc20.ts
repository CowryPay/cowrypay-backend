import { encodeFunctionData, erc20Abi } from "viem";
import type { EncodedCall } from "./encodeCowryPay.js";

/** `to` must be the USDC (ERC-20) contract. */
export function encodeErc20Approve(
  usdc: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
): EncodedCall {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
  return {
    to: usdc,
    data,
    value: "0x0",
    description: `USDC.approve(CowryPay, ${amount.toString()} base units)`,
  };
}
