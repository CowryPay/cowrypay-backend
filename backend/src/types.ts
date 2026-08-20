export type KycStatus = "unverified" | "pending" | "verified" | "rejected";

export interface User {
  id: string;
  email: string | null;
  phone: string | null;
  kycStatus: KycStatus;
  kycReference: string | null;
  pinHash: string | null;
  pinFailedAttempts: number;
  pinLockedUntil: string | null;
  biometricEnabled: boolean;
  passwordSet: boolean;
  createdAt: string;
}

export interface Wallet {
  id: string;
  userId: string;
  provider: string;
  externalWalletId: string;
  address: string;
  chain: string;
  createdAt: string;
}

export interface LedgerBalance {
  id: string;
  userId: string;
  tokenSymbol: string;
  chain: string;
  availableBalance: string;
  pendingBalance: string;
  updatedAt: string;
}

export type DepositState =
  | "DEPOSIT_DETECTED"
  | "DEPOSIT_COMPLIANCE_SCREENING"
  | "MANUAL_REVIEW"
  | "BALANCE_CREDITED"
  | "DEPOSIT_HELD"
  | "RETURN_TO_SENDER";

export interface Deposit {
  id: string;
  userId: string;
  walletId: string;
  tokenSymbol: string;
  amount: string;
  chain: string;
  txHash: string;
  state: DepositState;
  createdAt: string;
  updatedAt: string;
}

export interface DepositStateTransition {
  id: string;
  depositId: string;
  fromState: DepositState | null;
  toState: DepositState;
  trigger: string;
  actor: string;
  createdAt: string;
}

export type SendState =
  | "SEND_INSTRUCTED"
  | "COMPLIANCE_SCREENING"
  | "MANUAL_REVIEW"
  | "SEND_REJECTED"
  | "ORDER_CREATED"
  | "PAYOUT_INITIATED"
  | "SETTLING"
  | "COMPLETE"
  | "FAILED"
  | "REFUNDED";

export interface SendRecipient {
  institution: string;
  // Human-readable label for `institution` (e.g. "OPay" for code "OPAYNGPC")
  // — Paycrest's code is what routes the payment, not what a user should see.
  institutionName?: string;
  accountIdentifier: string;
  accountName: string;
  memo?: string;
}

export interface Send {
  id: string;
  userId: string;
  walletId: string;
  tokenSymbol: string;
  chain: string;
  amountHuman: string;
  fiatCurrency: string;
  recipient: SendRecipient;
  rate: string | null;
  feeAmount: string | null;
  treasuryAddress: string | null;
  provider: string;
  providerOrderId: string | null;
  reference: string;
  withdrawTxHash: string | null;
  withdrawConfirmedAt: string | null;
  state: SendState;
  createdAt: string;
  updatedAt: string;
}

export interface SendStateTransition {
  id: string;
  sendId: string;
  fromState: SendState | null;
  toState: SendState;
  trigger: string;
  actor: string;
  createdAt: string;
}

// Crypto-to-crypto withdrawal (see db/migrations/0015) — no Paycrest order,
// no fiat, no fee; a direct on-chain payout to a user-supplied address.
// Simpler lifecycle than SendState: no compliance-screening/order-creation
// steps that only exist because of Paycrest's own flow.
export type CryptoWithdrawalState = "PENDING" | "BROADCAST" | "CONFIRMED" | "FAILED";

export interface CryptoWithdrawal {
  id: string;
  userId: string;
  walletId: string;
  tokenSymbol: string;
  chain: string;
  amountHuman: string;
  toAddress: string;
  feeAmount: string | null;
  treasuryAddress: string | null;
  provider: string;
  reference: string;
  withdrawTxHash: string | null;
  withdrawConfirmedAt: string | null;
  state: CryptoWithdrawalState;
  createdAt: string;
  updatedAt: string;
}

export interface CryptoWithdrawalStateTransition {
  id: string;
  cryptoWithdrawalId: string;
  fromState: CryptoWithdrawalState | null;
  toState: CryptoWithdrawalState;
  trigger: string;
  actor: string;
  createdAt: string;
}

// Cross-chain send: source chain's ledger is debited, a real bridge (CCTP
// today) moves the value, the destination chain pays out — see
// domain/crossChainSend/. STUCK is the one state with no analog in
// CryptoWithdrawalState: it means the source-chain burn/lock already
// happened (real, final, on-chain) but the destination leg hasn't
// completed — deliberately excluded from every ledger-credit code path
// (see crossChainSend/service.ts's own risk-handling comment) since a
// confirmed burn can't be silently un-burned the way a same-chain
// broadcast failure can just be refunded.
export type CrossChainSendState =
  | "PENDING"
  | "SOURCE_BROADCAST"
  | "SOURCE_CONFIRMED"
  | "BRIDGING"
  | "DESTINATION_BROADCAST"
  | "COMPLETE"
  | "FAILED"
  | "STUCK"
  | "REFUNDED";

export interface CrossChainSend {
  id: string;
  userId: string;
  walletId: string;
  tokenSymbol: string;
  sourceChain: string;
  destinationChain: string;
  amountHuman: string;
  feeAmount: string;
  netAmount: string;
  toAddress: string;
  treasuryAddress: string;
  bridgeVendor: string;
  provider: string;
  reference: string;
  sourceTxHash: string | null;
  destinationTxHash: string | null;
  bridgeReference: Record<string, unknown> | null;
  sourceConfirmedAt: string | null;
  destinationConfirmedAt: string | null;
  state: CrossChainSendState;
  createdAt: string;
  updatedAt: string;
}

export interface CrossChainSendStateTransition {
  id: string;
  crossChainSendId: string;
  fromState: CrossChainSendState | null;
  toState: CrossChainSendState;
  trigger: string;
  actor: string;
  createdAt: string;
}
