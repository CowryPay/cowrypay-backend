import { encodeFunctionData } from "viem";
import { groupRegistryContract } from "../abi/index.js";
import type { EncodedCall } from "./encodeCowryPay.js";

export function encodeCreateGroup(displayName: string): EncodedCall {
  const data = encodeFunctionData({
    abi: groupRegistryContract.abi,
    functionName: "createGroup",
    args: [displayName.trim()],
  });
  return {
    to: groupRegistryContract.address,
    data,
    value: "0x0",
    description: `GroupRegistry.createGroup("${displayName.trim()}")`,
  };
}

export function encodeAddMember(
  groupId: bigint,
  member: `0x${string}`,
): EncodedCall {
  const data = encodeFunctionData({
    abi: groupRegistryContract.abi,
    functionName: "addMember",
    args: [groupId, member],
  });
  return {
    to: groupRegistryContract.address,
    data,
    value: "0x0",
    description: `GroupRegistry.addMember(${groupId}, ${member})`,
  };
}

export function encodeRemoveMember(
  groupId: bigint,
  member: `0x${string}`,
): EncodedCall {
  const data = encodeFunctionData({
    abi: groupRegistryContract.abi,
    functionName: "removeMember",
    args: [groupId, member],
  });
  return {
    to: groupRegistryContract.address,
    data,
    value: "0x0",
    description: `GroupRegistry.removeMember(${groupId}, ${member})`,
  };
}

export function encodeCancelGroup(groupId: bigint): EncodedCall {
  const data = encodeFunctionData({
    abi: groupRegistryContract.abi,
    functionName: "cancelGroup",
    args: [groupId],
  });
  return {
    to: groupRegistryContract.address,
    data,
    value: "0x0",
    description: `GroupRegistry.cancelGroup(${groupId})`,
  };
}
