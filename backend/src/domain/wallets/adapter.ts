export interface CreatedWallet {
  externalWalletId: string;
  address: string;
  chain: string;
}

// Implemented by whatever wallet infra creates the deposit address (Blockradar
// in production, a mock in dev). Callers depend only on this interface.
export interface WalletAdapter {
  createWallet(input: { userId: string; email: string | null }): Promise<CreatedWallet>;
}
