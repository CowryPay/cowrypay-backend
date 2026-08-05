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
  // Only used for the free-form chat fallback — unset means that path
  // degrades to a static reply instead of erroring (see domain/chat/llm.ts).
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
  // Fallback only — used when Groq is unavailable/errors, or for intent
  // parsing that needs the stronger model. Unset means no fallback; Groq
  // failures degrade to the static reply, same as before.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
  // Off-ramp provider (Paycrest). API key only needed for order-creation and
  // authenticated endpoints — rate quotes are public. Secret is only used to
  // verify webhook signatures.
  paycrestApiKey: process.env.PAYCREST_API_KEY,
  paycrestApiSecret: process.env.PAYCREST_API_SECRET,
  paycrestBaseUrl: process.env.PAYCREST_BASE_URL ?? "https://api.paycrest.io/v2",
  // How long a half-finished multi-turn chat draft (e.g. a partial send
  // request) survives with no reply before the next message starts fresh.
  chatSessionIdleMinutes: Number(process.env.CHAT_SESSION_IDLE_MINUTES ?? 10),
  // Platform fee skimmed from every remittance, in basis points (100 = 1%).
  // Only required when a send is actually resolved — checked lazily by
  // domain/offramp/fee.ts, not here.
  remittanceTreasuryAddress: process.env.REMITTANCE_TREASURY_ADDRESS,
  remittanceFeeBps: Number(process.env.REMITTANCE_FEE_BPS ?? 100),
  // Any secret string — a 32-byte encryption key gets derived from it via
  // scrypt, so this doesn't need to be exact raw key bytes. Only required
  // when a recipient is actually saved — checked lazily, not here.
  recipientEncryptionKey: process.env.RECIPIENT_ENCRYPTION_KEY,
  // Gates POST /admin/deposits/:id/review — there's no role/permission
  // system in this codebase yet, so this is a shared-secret header check
  // (x-admin-key) rather than real per-admin auth. Only required when that
  // endpoint is actually called — checked lazily, not here.
  adminApiKey: process.env.ADMIN_API_KEY,
  // Only required when walletProvider === "aws-kms" — checked lazily by
  // that adapter, not here, same pattern as the Blockradar vars above.
  awsRegion: process.env.AWS_REGION,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  // The single KMS key every aws-kms withdraw() call signs with — mirrors
  // BLOCKRADAR_WALLET_ID being one fixed master payout wallet today, not a
  // per-user key. Only required when walletProvider === "aws-kms".
  awsKmsPayoutKeyArn: process.env.AWS_KMS_PAYOUT_KEY_ARN,
  celoRpcUrl: process.env.CELO_RPC_URL ?? "https://forno.celo.org",
  baseRpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
  optimismRpcUrl: process.env.OPTIMISM_RPC_URL ?? "https://mainnet.optimism.io",
};
