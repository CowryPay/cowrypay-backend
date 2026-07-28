/** USDm (Mento Dollar on Celo) uses 18 decimals — same as standard ERC-20. */
export const USDC_DECIMALS = 18;

/** Human USDm (e.g. 12.5) → base units (18 decimals). */
export function usdcBaseUnitsFromHuman(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be a positive finite number");
  }
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}
