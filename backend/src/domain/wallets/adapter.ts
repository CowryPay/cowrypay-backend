export interface CreatedWallet {
  externalWalletId: string;
  address: string;
  chain: string;
}

// Distinguished from a generic broadcast failure so callers can show a
// clean, honest message instead of relaying a raw chain revert reason —
// this fires when OUR payout wallet doesn't have enough on-chain USDC to
// cover an otherwise-valid withdraw, not when the user's own balance is
// insufficient. Those are different failures at different points: the
// user's ledger balance is checked and atomically debited before any
// blockchain call happens (ledgerRepo.debitAvailable in
// domain/offramp/service.ts) — if this error fires at all, that check
// already passed, so the payout wallet's real liquidity is the only thing
// that can be short. Seen live in production: "ERC20: transfer amount
// exceeds balance" from an aws-kms withdraw.
export class PayoutLiquidityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutLiquidityError";
  }
}

export interface WithdrawResult {
  // Blockradar can accept a withdraw for AML/compliance screening and return
  // no hash yet (confirmed live: a 200 with no data.errors and no hash,
  // followed later by a withdraw.success webhook carrying the real hash) —
  // null here means "accepted, hash pending", not a failure.
  txHash: string | null;
  status: string;
}

export interface WithdrawInput {
  chain: string;
  tokenSymbol: string;
  toAddress: string;
  amount: string;
  reference: string;
}

// Implemented by whatever wallet infra creates the deposit address and pays
// sends out (Blockradar in production today, a mock in dev). Callers
// (domain/offramp/service.ts) depend only on this interface, never on a
// specific provider's SDK/API directly — swapping providers is then a
// WALLET_PROVIDER flag flip (see wallets/index.ts's getWalletAdapter),
// with an instant rollback path if something's wrong. `withdraw` operates
// at "wherever this provider pays sends out from" (Blockradar's master
// wallet today) — a provider whose payout source differs per user, or
// needs its own internal sweep step, handles that inside its own adapter
// implementation rather than expanding this interface.
export interface WalletAdapter {
  createWallet(input: { userId: string; email: string | null }): Promise<CreatedWallet>;
  withdraw(input: WithdrawInput): Promise<WithdrawResult>;
}
