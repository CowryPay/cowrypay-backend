import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT) || 3001,
  databaseUrl: required("DATABASE_URL"),
  databaseSsl: process.env.DATABASE_SSL !== "false",
  supabaseUrl: required("SUPABASE_URL"),
  walletProvider: process.env.WALLET_PROVIDER ?? "mock",
  kycProvider: process.env.KYC_PROVIDER ?? "mock",
  // Only required when walletProvider === "blockradar" — checked lazily by
  // that adapter, not here, so mock mode keeps working with these unset.
  blockradarApiKey: process.env.BLOCKRADAR_API_KEY,
  blockradarWalletId: process.env.BLOCKRADAR_WALLET_ID,
  blockradarBaseUrl: process.env.BLOCKRADAR_BASE_URL ?? "https://api.blockradar.co/v1",
  defaultChain: process.env.DEFAULT_CHAIN ?? "mock-chain",
  defaultTokenSymbol: process.env.DEFAULT_TOKEN_SYMBOL ?? "USDC",
  mockScreeningFlagThreshold: Number(process.env.MOCK_SCREENING_FLAG_THRESHOLD ?? 5000),
  // Comma-separated allowlist for browser callers (the frontend). Unset ==
  // allow any origin — fine for pre-launch testing since auth is bearer-token
  // based (no cookies, so no CSRF exposure from a permissive policy), but
  // set this once there's a real frontend origin to lock down to.
  corsOrigins: process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()),
};
