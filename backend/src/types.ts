export type KycStatus = "unverified" | "pending" | "verified" | "rejected";

export interface User {
  id: string;
  email: string | null;
  phone: string | null;
  kycStatus: KycStatus;
  kycReference: string | null;
  pinHash: string | null;
  biometricEnabled: boolean;
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
