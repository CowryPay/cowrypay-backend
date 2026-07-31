export interface CreatedWallet {
  externalWalletId: string;
  address: string;
  chain: string;
}

export interface WithdrawResult {
  // Blockradar can accept a withdraw for AML/compliance screening and return
  // no hash yet (confirmed live: a 200 with no data.errors and no hash,
  // followed later by a withdraw.success webhook carrying the real hash) —
  // null here means "accepted, hash pending", not a failure.
  txHash: string | null;
  status: string;
}

// Implemented by whatever wallet infra creates the deposit address (Blockradar
// in production, a mock in dev). Callers depend only on this interface.
export interface WalletAdapter {
  createWallet(input: { userId: string; email: string | null }): Promise<CreatedWallet>;
}
