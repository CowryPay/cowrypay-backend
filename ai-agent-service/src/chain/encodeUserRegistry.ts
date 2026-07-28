import { encodeFunctionData } from "viem";
import { userRegistryContract } from "../abi/index.js";
import type { EncodedCall } from "./encodeCowryPay.js";

export function encodeRegisterUsername(name: string): EncodedCall {
  const data = encodeFunctionData({
    abi: userRegistryContract.abi,
    functionName: "register",
    args: [name],
  });
  return {
    to: userRegistryContract.address,
    data,
    value: "0x0",
    description: `UsernameRegistry.register("${name}")`,
  };
}
