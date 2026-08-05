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
