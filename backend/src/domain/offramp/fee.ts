import { env } from "../../config/env.js";

export interface FeeSplit {
  feeAmount: string;
  netAmount: string;
}

// Platform fee skimmed from every remittance, in basis points (100 = 1%,
// matching the old MiniPay system's REMITTANCE_FEE_BPS). Only the net
// amount actually goes through Paycrest's conversion — the fee is tracked
// on the send record for the still-unbuilt withdraw step to route
// separately to treasury once real on-chain movement is wired up.
export function computeFeeSplit(amount: string): FeeSplit {
  const amountNum = Number(amount);
  const feeAmount = Math.round(amountNum * env.remittanceFeeBps) / 10_000;
  const netAmount = Math.round((amountNum - feeAmount) * 1_000_000) / 1_000_000;
  return { feeAmount: String(feeAmount), netAmount: String(netAmount) };
}

export function requireTreasuryAddress(): string {
  if (!env.remittanceTreasuryAddress) {
    throw new Error("REMITTANCE_TREASURY_ADDRESS must be set to process remittances");
  }
  return env.remittanceTreasuryAddress;
}
