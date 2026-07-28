import type { PublicClient } from "viem";
import type { DraftTxPlan } from "../schemas.js";
import { readErc20Allowance, readErc20Balance } from "./erc20Reads.js";
import { USDC_DECIMALS } from "./usdcAmount.js";

/** Total USDm base units CowryPay will pull for this plan. */
export function totalBaseUnitsFromTxPlan(plan: DraftTxPlan): bigint {
  switch (plan.mode) {
    case "pay":
      return BigInt(plan.amountBaseUnits);
    case "payGroupEqual":
      return BigInt(plan.amountPerMemberBaseUnits) * BigInt(plan.memberCount);
    case "payMany":
      return plan.items.reduce<bigint>(
        (s, i) => s + BigInt(i.amountBaseUnits),
        0n,
      );
    case "payGroupSplit":
      return BigInt(plan.totalBaseUnits);
    default:
      throw new Error(`Unhandled plan mode: ${(plan as { mode: string }).mode}`);
  }
}

export function formatUsdcFromBase(units: bigint): string {
  const divisor = BigInt(10 ** USDC_DECIMALS);
  const whole = units / divisor;
  const frac = units % divisor;
  const fracStr = frac
    .toString()
    .padStart(USDC_DECIMALS, "0")
    .replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

export type UsdcReadiness =
  | { ok: true }
  | {
      ok: false;
      reason: "insufficient_balance" | "insufficient_allowance";
      balance: bigint;
      allowance: bigint;
      required: bigint;
    };

export async function checkUsdcReadiness(
  client: PublicClient,
  usdc: `0x${string}`,
  owner: `0x${string}`,
  sendrPay: `0x${string}`,
  required: bigint,
): Promise<UsdcReadiness> {
  if (required <= 0n) return { ok: true };
  const [balance, allowance] = await Promise.all([
    readErc20Balance(client, usdc, owner),
    readErc20Allowance(client, usdc, owner, sendrPay),
  ]);
  if (balance < required) {
    return {
      ok: false,
      reason: "insufficient_balance",
      balance,
      allowance,
      required,
    };
  }
  if (allowance < required) {
    return {
      ok: false,
      reason: "insufficient_allowance",
      balance,
      allowance,
      required,
    };
  }
  return { ok: true };
}
