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
  // llama-3.3-70b-versatile (the old default here) was fully decommissioned
  // by Groq on 2026-08-16 — every call silently failed and fell through to
  // Claude/static fallbacks, undetected until traced directly (see
  // domain/chat/llm.ts's now-added logging on every one of those catches).
  // openai/gpt-oss-120b is Groq's own recommended replacement, verified
  // live against the real intent-parsing prompt before switching (a
  // smaller 20b variant was tried first but failed to reliably produce
  // valid JSON against this prompt's length).
  groqModel: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
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
  // Second off-ramp provider (Quidax Ramp) — a second-opinion quote for
  // Base/Solana sends only (the one two of our five chains it supports for
  // USDC, verified live against their real API, not just their docs — see
  // domain/offramp/providerSelection.ts). secretKey signs both outbound
  // requests (x-private-key header) and inbound webhook verification
  // (HMAC-SHA256 over the raw body, x-ramp-signature header); publicKey is
  // currently unused server-side (kept for parity/future use).
  quidaxPublicKey: process.env.QUIDAX_PUBLIC_KEY,
  quidaxSecretKey: process.env.QUIDAX_SECRET_KEY,
  quidaxBaseUrl: process.env.QUIDAX_RAMP_BASE_URL ?? "https://ramp-be.quidax.io/api/v1",
  // Third off-ramp provider (Centiiv Protocol API) — explicit-only, never
  // auto-selected by providerSelection.ts's rate comparison (see
  // centiivAdapter.ts's own comment: unlike Paycrest/Quidax, Centiiv gives
  // no rate until after a real order is created and the deposit settles,
  // so there's nothing to compare upfront). Verified live against their
  // real API (api.centiiv.io), not their docs site, which blocked/redirected
  // every automated fetch attempted. publicKey (X-API-Key header) is what
  // every confirmed endpoint actually uses; secretKey is documented as
  // "server-to-server only" but no endpoint requiring it has been found
  // yet — kept for when webhook signature verification (still unconfirmed,
  // see centiivSettlementPoller.ts) or another privileged use turns up.
  centiivPublicKey: process.env.CENTIIV_PUBLIC_KEY,
  centiivSecretKey: process.env.CENTIIV_SECRET_KEY,
  centiivBaseUrl: process.env.CENTIIV_BASE_URL ?? "https://api.centiiv.io",
  // How long a half-finished multi-turn chat draft (e.g. a partial send
  // request) survives with no reply before the next message starts fresh.
  chatSessionIdleMinutes: Number(process.env.CHAT_SESSION_IDLE_MINUTES ?? 10),
  // Platform fee skimmed from every remittance, in basis points (100 = 1%).
  // Only required when a send is actually resolved — checked lazily by
  // domain/offramp/fee.ts, not here.
  remittanceTreasuryAddress: process.env.REMITTANCE_TREASURY_ADDRESS,
  remittanceFeeBps: Number(process.env.REMITTANCE_FEE_BPS ?? 100),
  // Crypto-to-crypto withdrawals were originally fee-free (see migration
  // 0015's own comment) — now 0.3% (much lower than the 1% off-ramp fee,
  // since there's no fiat conversion/provider rail involved), with a
  // minimum floor so a small withdrawal doesn't carry a near-zero fee.
  // Reuses the SAME treasury addresses as the off-ramp fee (fee.ts's
  // requireTreasuryAddress) — both are platform fee revenue, no reason to
  // route them to separate wallets per chain.
  cryptoWithdrawalFeeBps: Number(process.env.CRYPTO_WITHDRAWAL_FEE_BPS ?? 30),
  cryptoWithdrawalMinFeeUsd: process.env.CRYPTO_WITHDRAWAL_MIN_FEE_USD ?? "0.1",
  // Dedicated fee-only treasury addresses for Stellar/Solana — deliberately
  // separate from those chains' own shared deposit/operational treasury
  // (STELLAR_DEPOSIT_ADDRESS, the Solana treasury signer), mirroring how
  // REMITTANCE_TREASURY_ADDRESS above is already its own address distinct
  // from the EVM payout wallet. Checked lazily by domain/offramp/fee.ts.
  stellarTreasuryFeeAddress: process.env.STELLAR_TREASURY_FEE_ADDRESS,
  solanaTreasuryFeeAddress: process.env.SOLANA_TREASURY_FEE_ADDRESS,
  // Any secret string — a 32-byte encryption key gets derived from it via
  // scrypt, so this doesn't need to be exact raw key bytes. Only required
  // when a recipient is actually saved — checked lazily, not here.
  recipientEncryptionKey: process.env.RECIPIENT_ENCRYPTION_KEY,
  // Gates POST /admin/deposits/:id/review — there's no role/permission
  // system in this codebase yet, so this is a shared-secret header check
  // (x-admin-key) rather than real per-admin auth. Only required when that
  // endpoint is actually called — checked lazily, not here.
  adminApiKey: process.env.ADMIN_API_KEY,
  // Narrower sibling of adminApiKey — grants ONLY the read-only dashboard
  // endpoints (requireMetricsKey), not the write endpoints requireAdminKey
  // alone guards (correct-state, deposit resolve). Handed to the frontend
  // admin dashboard's own backend so a leaked/compromised dashboard key
  // can't be used to tamper with financial records.
  adminMetricsKey: process.env.ADMIN_METRICS_KEY,
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
  // Stellar support (USDC only, shared omnibus deposit address + per-user
  // memo — a different custody model from every EVM chain above). All only
  // required once Stellar code paths are actually exercised — checked
  // lazily by that code, not here, same pattern as the vars above.
  stellarNetwork: process.env.STELLAR_NETWORK ?? "testnet",
  stellarHorizonUrl: process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
  stellarDepositAddress: process.env.STELLAR_DEPOSIT_ADDRESS,
  // Circle's USDC-on-Stellar issuer — re-verify against
  // developers.circle.com/stablecoins/quickstart-transfer-usdc-stellar
  // before ever setting this in production; do not trust a hardcoded value.
  stellarUsdcIssuer: process.env.STELLAR_USDC_ISSUER,
  // KMS *symmetric* Encrypt/Decrypt key — protects the shared Stellar
  // account's secret seed at rest. Deliberately not the same key/mechanism
  // as awsKmsPayoutKeyArn above: that's an asymmetric Sign-only key (KMS
  // never releases the private key), but AWS KMS cannot sign Ed25519
  // (Stellar's curve) at all — so here KMS only wraps/unwraps the seed,
  // which is decrypted into process memory at the moment of signing. See
  // stellarKms.ts for the full custody-model tradeoff this implies.
  stellarKmsKeyArn: process.env.STELLAR_KMS_KEY_ARN,
  stellarSigningKeyCiphertext: process.env.STELLAR_SIGNING_KEY_CIPHERTEXT,
  // Independent on/off switch for the Stellar deposit poller — deliberately
  // not tied to WALLET_PROVIDER, since Stellar must run alongside whichever
  // EVM provider is active, not replace it.
  stellarDepositsEnabled: process.env.STELLAR_DEPOSITS_ENABLED === "true",
  // Solana support (USDC only, per-user self-custody deposit addresses —
  // unlike Stellar's shared address, this matches Solana's own official
  // exchange-integration guidance). All only required once Solana code
  // paths are actually exercised — checked lazily, same pattern as above.
  solanaNetwork: process.env.SOLANA_NETWORK ?? "devnet",
  // Public mainnet-beta RPC is rate-limited/unreliable for real use — a
  // paid RPC (e.g. the chosen deposit-indexer's own) is expected in prod.
  solanaRpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  // Circle's official USDC mint on Solana mainnet (developers.circle.com/
  // stablecoins/usdc-contract-addresses) — devnet's differs, MUST override
  // per environment.
  solanaUsdcMint: process.env.SOLANA_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  // Symmetric KMS key wrapping every Solana seed at rest (per-user AND the
  // treasury's) — may point at the same underlying key as
  // STELLAR_KMS_KEY_ARN (one symmetric key can wrap either curve's seed
  // bytes fine) or a distinct one.
  solanaKmsKeyArn: process.env.SOLANA_KMS_KEY_ARN,
  // The single treasury keypair's own KMS-wrapped seed — mirrors
  // STELLAR_SIGNING_KEY_CIPHERTEXT's role exactly, just Solana's curve.
  solanaTreasurySigningKeyCiphertext: process.env.SOLANA_TREASURY_SIGNING_KEY_CIPHERTEXT,
  // Shared-secret the deposit-indexer webhook (Helius or equivalent) sends
  // back on every call — verified in domain/deposits/solanaWebhook.ts.
  solanaWebhookSecret: process.env.SOLANA_WEBHOOK_SECRET,
  // Gates both the webhook route's actual processing and the sweeper's
  // interval — deliberately one flag, not tied to WALLET_PROVIDER, same
  // reasoning as STELLAR_DEPOSITS_ENABLED.
  solanaDepositsEnabled: process.env.SOLANA_DEPOSITS_ENABLED === "true",
  // Used only to keep the existing Helius webhook's accountAddresses in
  // sync as new Solana wallets are created (see solanaAdapter.ts) — a
  // best-effort call, never required for wallet creation itself to
  // succeed. Not the same as SOLANA_WEBHOOK_SECRET (that's what Helius
  // sends back to verify inbound calls; this is what we send to Helius's
  // own management API).
  heliusApiKey: process.env.HELIUS_API_KEY,
  heliusWebhookId: process.env.HELIUS_WEBHOOK_ID,
  // Ops-only alerting (gasStatusMonitor.ts) — a private Telegram chat, never
  // the public support group linked in chat replies. Both required for the
  // monitor to actually send anything; unset just means it logs instead of
  // posting (see gasStatusMonitor.ts's own guard).
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramOpsChatId: process.env.TELEGRAM_OPS_CHAT_ID,
  // Stellar's native gas token (XLM) — Stellar fees are tiny, so this is a
  // generous default, not a tightly calibrated one.
  stellarXlmAlertThreshold: process.env.STELLAR_XLM_ALERT_THRESHOLD ?? "5",
  // Solana's treasury needs ~0.0031 SOL per new wallet created (see
  // solanaAdapter.ts's SYSTEM_ACCOUNT_RENT_LAMPORTS + ATA_RENT_LAMPORTS) —
  // 0.05 SOL is roughly 16 signups' worth of runway, the same real incident
  // this whole monitor was built in response to.
  solanaSolAlertThreshold: process.env.SOLANA_SOL_ALERT_THRESHOLD ?? "0.05",
};
