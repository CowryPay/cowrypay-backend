import { env } from "../../config/env.js";
import { getSolanaTreasurySigner } from "../wallets/solanaKms.js";

export interface FeeSplit {
  feeAmount: string;
  netAmount: string;
}

// Platform fee skimmed from every remittance, in basis points (100 = 1%,
// matching the old MiniPay system's REMITTANCE_FEE_BPS). Only the net
// amount actually goes through the off-ramp provider's conversion — the
// fee is tracked on the send record for the withdraw step to route
// separately to treasury via a real on-chain transfer.
export function computeFeeSplit(amount: string): FeeSplit {
  const amountNum = Number(amount);
  const feeAmount = Math.round(amountNum * env.remittanceFeeBps) / 10_000;
  const netAmount = Math.round((amountNum - feeAmount) * 1_000_000) / 1_000_000;
  return { feeAmount: String(feeAmount), netAmount: String(netAmount) };
}

// Chain-aware — a real, live bug until fixed: this used to return one
// single EVM address (REMITTANCE_TREASURY_ADDRESS) regardless of chain,
// which is a hex address invalid on Stellar/Solana. Harmless as long as
// off-ramping FROM Stellar/Solana wasn't actually possible; Centiiv made
// it real (see centiivAdapter.ts), so the fee-sweep step in service.ts
// would otherwise have started failing silently on every Stellar/Solana
// send, on every provider, not just Centiiv (the sweep runs after ANY
// successful payout broadcast, unconditional on which off-ramp provider
// was used). Deliberately reuses each chain's EXISTING treasury/shared
// account — Stellar's own omnibus deposit address, Solana's own
// treasury signer — rather than standing up new dedicated addresses,
// since both already pool every user's funds into one place per chain
// the same way the EVM treasury does.
export async function requireTreasuryAddress(chain: string): Promise<string> {
  const c = chain.toLowerCase();
  if (c === "stellar") {
    if (!env.stellarDepositAddress) {
      throw new Error("STELLAR_DEPOSIT_ADDRESS must be set to process Stellar remittances");
    }
    return env.stellarDepositAddress;
  }
  if (c === "solana") {
    const treasury = await getSolanaTreasurySigner();
    return treasury.address;
  }
  if (!env.remittanceTreasuryAddress) {
    throw new Error("REMITTANCE_TREASURY_ADDRESS must be set to process remittances");
  }
  return env.remittanceTreasuryAddress;
}
