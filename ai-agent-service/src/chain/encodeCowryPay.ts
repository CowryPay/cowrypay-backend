import { encodeFunctionData } from "viem";
import { cowrypayContract } from "../abi/index.js";

export type EncodedCall = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: `0x${string}`;
  description: string;
};

export function encodePay(
  token: `0x${string}`,
  to: `0x${string}`,
  amountBaseUnits: bigint,
): EncodedCall {
  const data = encodeFunctionData({
    abi: cowrypayContract.abi,
    functionName: "pay",
    args: [token, to, amountBaseUnits],
  });
  return {
    to: cowrypayContract.address,
    data,
    value: "0x0",
    description: `CowryPay.pay(token=${token}, to=${to}, amount=${amountBaseUnits})`,
  };
}

export function encodePayGroupEqual(
  token: `0x${string}`,
  groupId: bigint,
  amountPerMemberBaseUnits: bigint,
): EncodedCall {
  const data = encodeFunctionData({
    abi: cowrypayContract.abi,
    functionName: "payGroupEqual",
    args: [token, groupId, amountPerMemberBaseUnits],
  });
  return {
    to: cowrypayContract.address,
    data,
    value: "0x0",
    description: `CowryPay.payGroupEqual(token=${token}, group=${groupId}, perMember=${amountPerMemberBaseUnits})`,
  };
}

export function encodePayGroupSplit(
  token: `0x${string}`,
  groupId: bigint,
  totalAmountBaseUnits: bigint,
): EncodedCall {
  const data = encodeFunctionData({
    abi: cowrypayContract.abi,
    functionName: "payGroupSplit",
    args: [token, groupId, totalAmountBaseUnits],
  });
  return {
    to: cowrypayContract.address,
    data,
    value: "0x0",
    description: `CowryPay.payGroupSplit(token=${token}, group=${groupId}, total=${totalAmountBaseUnits})`,
  };
}

// ── Agent-executed (on behalf) encoders ──────────────────────────────────────
//
// These produce calldata for the operator/agent to sign and broadcast.
// The `payer` arg is the user's address — they must have approved CowryPay.

export function encodePayOnBehalf(
  payer: `0x${string}`,
  token: `0x${string}`,
  to: `0x${string}`,
  amountBaseUnits: bigint,
): EncodedCall {
  const data = encodeFunctionData({
    abi: cowrypayContract.abi,
    functionName: "payOnBehalf",
    args: [payer, token, to, amountBaseUnits],
  });
  return {
    to: cowrypayContract.address,
    data,
    value: "0x0",
    description: `CowryPay.payOnBehalf(payer=${payer}, token=${token}, to=${to}, amount=${amountBaseUnits})`,
  };
}

export function encodePayGroupEqualOnBehalf(
  payer: `0x${string}`,
  token: `0x${string}`,
  groupId: bigint,
  amountPerMemberBaseUnits: bigint,
): EncodedCall {
  const data = encodeFunctionData({
    abi: cowrypayContract.abi,
    functionName: "payGroupEqualOnBehalf",
    args: [payer, token, groupId, amountPerMemberBaseUnits],
  });
  return {
    to: cowrypayContract.address,
    data,
    value: "0x0",
    description: `CowryPay.payGroupEqualOnBehalf(payer=${payer}, token=${token}, group=${groupId}, perMember=${amountPerMemberBaseUnits})`,
  };
}

export function encodePayGroupSplitOnBehalf(
  payer: `0x${string}`,
  token: `0x${string}`,
  groupId: bigint,
  totalAmountBaseUnits: bigint,
): EncodedCall {
  const data = encodeFunctionData({
    abi: cowrypayContract.abi,
    functionName: "payGroupSplitOnBehalf",
    args: [payer, token, groupId, totalAmountBaseUnits],
  });
  return {
    to: cowrypayContract.address,
    data,
    value: "0x0",
    description: `CowryPay.payGroupSplitOnBehalf(payer=${payer}, token=${token}, group=${groupId}, total=${totalAmountBaseUnits})`,
  };
}

export function encodedCallToJson(c: EncodedCall): {
  to: string;
  data: string;
  value: string;
  description: string;
} {
  return { to: c.to, data: c.data, value: c.value, description: c.description };
}
