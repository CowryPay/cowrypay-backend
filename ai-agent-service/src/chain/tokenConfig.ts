/** Supported tokens on Celo mainnet */
export const TOKENS = {
  USDm: {
    address: "0x765DE816845861e75A25fCA122bb6898B8B1282a" as `0x${string}`,
    symbol:  "USDm",
    decimals: 18,
  },
  USDC: {
    address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as `0x${string}`,
    symbol:  "USDC",
    decimals: 6,
  },
} as const;

export type TokenSymbol = keyof typeof TOKENS;

/** Default token for payments when the user doesn't specify */
export const DEFAULT_TOKEN = TOKENS.USDC;

export function getTokenByAddress(addr: string) {
  const lower = addr.toLowerCase();
  return (
    Object.values(TOKENS).find((t) => t.address.toLowerCase() === lower) ??
    DEFAULT_TOKEN
  );
}

export function getTokenBySymbol(sym: string) {
  const upper = sym.toUpperCase();
  if (upper === "USDM" || upper === "MENTO" || upper === "CELO_DOLLAR") return TOKENS.USDm;
  if (upper === "USDC") return TOKENS.USDC;
  return DEFAULT_TOKEN;
}

/** Convert a human amount to base units for a specific token */
export function toBaseUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be a positive finite number");
  }
  return BigInt(Math.round(amount * 10 ** decimals));
}

/** Format base units as a human string for a specific token */
export function fromBaseUnits(units: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole   = units / divisor;
  const frac    = units % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}
