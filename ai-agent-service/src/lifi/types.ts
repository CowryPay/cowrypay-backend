// ── LI.FI Earn Data API types ─────────────────────────────────────────────────

export type EarnToken = {
  symbol: string;
  address: string;
  chainId: number;
  decimals: number;
  name?: string;
  logoURI?: string;
};

export type EarnProtocol = {
  name: string;
  key: string;
  logoURI?: string;
  url?: string;
};

export type EarnOpportunity = {
  id: string;
  protocol: EarnProtocol;
  /** Underlying token the user deposits (e.g. USDC) */
  token: EarnToken;
  /** Chain the vault lives on */
  chainId: number;
  chainName: string;
  /** APY as a decimal: 0.0523 = 5.23% */
  apy: number;
  apyBase?: number;
  apyReward?: number;
  /** Total value locked in USD */
  tvl: number;
  /** Vault / protocol contract address */
  vaultAddress: string;
  /** Receipt token received after deposit (LP share / vault share) */
  depositToken?: EarnToken;
  type?: string;
};

/** Slimmed-down version stored in session memory for WhatsApp list selection */
export type CachedOpportunity = {
  id: string;
  label: string;               // e.g. "Aave v3 — 6.42% APY on Arbitrum"
  protocol: string;
  chainId: number;
  chainName: string;
  apy: number;
  tvlUsd: number;
  tokenSymbol: string;
  tokenAddress: string;
  tokenDecimals: number;
  vaultAddress: string;
};

export type EarnPosition = {
  opportunityId?: string;
  protocol?: string;
  chainId?: number;
  chainName?: string;
  tokenSymbol?: string;
  balanceUsd: number;
  apy?: number;
};

// ── LI.FI Composer API types ──────────────────────────────────────────────────

export type ComposerTransactionRequest = {
  to: string;
  from: string;
  data: string;
  /** Hex string, e.g. "0x0" */
  value: string;
  chainId: number;
  gasLimit?: string;
  gasPrice?: string;
};

export type ComposerFeeCost = {
  name: string;
  amount: string;
  amountUSD: string;
  token: { symbol: string; decimals: number };
};

export type ComposerQuote = {
  id: string;
  type?: string;
  tool?: string;
  toolDetails?: { key: string; name: string };
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin?: string;
    executionDuration?: number;
    feeCosts?: ComposerFeeCost[];
    gasCosts?: ComposerFeeCost[];
  };
  transactionRequest: ComposerTransactionRequest;
};

/** Stored in session while awaiting WhatsApp YES/NO for a yield deposit */
export type PendingYieldDeposit = {
  step: "AWAIT_YIELD_CONFIRM";
  opportunity: CachedOpportunity;
  amountHuman: number;
  /** Calldata from Composer */
  txTo: string;
  txData: string;
  txValue: string;
  txChainId: number;
  /** Gas estimates from LI.FI quote (hex strings) — used for pre-flight ETH balance check */
  txGasLimit?: string;
  txGasPrice?: string;
  createdAt: number;
};
