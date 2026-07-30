export interface CreatedWallet {
  externalWalletId: string;
  address: string;
  chain: string;
}

export interface WithdrawInput {
  externalWalletId: string;
  chain: string;
  tokenSymbol: string;
  toAddress: string;
  amount: string;
  reference: string;
}

export interface WithdrawResult {
  txHash: string;
  status: string;
}

// Implemented by whatever wallet infra creates the deposit address (Blockradar
// in production, a mock in dev). Callers depend only on this interface.
export interface WalletAdapter {
  createWallet(input: { userId: string; email: string | null }): Promise<CreatedWallet>;
  // Broadcasts an outbound transfer from a custodial address. `status` is
  // whatever the provider hands back synchronously (e.g. Blockradar's
  // "PENDING") — the hash confirms the request was accepted for broadcast,
  // not that it's confirmed on-chain; final confirmation arrives via webhook.
  withdraw(input: WithdrawInput): Promise<WithdrawResult>;
}
