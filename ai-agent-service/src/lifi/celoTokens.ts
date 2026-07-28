/** USDm (Mento Dollar) on Celo mainnet — 18 decimals */
export const CELO_USDM_ADDRESS = "0x765DE816845861e75A25fCA122bb6898B8B1282a";

/** Native USDC on Celo mainnet (Circle) — 6 decimals */
export const CELO_USDC_ADDRESS = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";

export const CELO_TOKEN_DECIMALS: Record<string, number> = {
  [CELO_USDM_ADDRESS.toLowerCase()]: 18,
  [CELO_USDC_ADDRESS.toLowerCase()]: 6,
};
