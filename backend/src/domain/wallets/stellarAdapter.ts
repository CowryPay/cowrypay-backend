import { env } from "../../config/env.js";
import type { CreatedWallet, WalletAdapter, WithdrawInput, WithdrawResult } from "./adapter.js";
import { stellarMemoRepo } from "./stellarMemoRepository.js";

function requireStellarDepositAddress(): string {
  if (!env.stellarDepositAddress) {
    throw new Error("STELLAR_DEPOSIT_ADDRESS must be set to create Stellar wallets");
  }
  return env.stellarDepositAddress;
}

// Shared omnibus deposit address for every user (Bybit/Coinbase/Binance-style
// memo-based deposits), the opposite of every EVM adapter here — there's no
// per-user address, so "creating a wallet" just means allocating this user's
// unique numeric MEMO_ID (see stellarMemoRepository.ts / migration 0013) and
// handing back the one shared address every user is told to send USDC to.
export const stellarWalletAdapter: WalletAdapter = {
  async createWallet({ userId }): Promise<CreatedWallet> {
    const address = requireStellarDepositAddress();
    const memoId = await stellarMemoRepo.allocate(userId);
    return { externalWalletId: memoId.toString(), address, chain: "stellar" };
  },

  // Not implemented yet — signing requires decrypting the shared account's
  // seed (stellarKms.ts, not built yet) and building/submitting a real
  // Stellar payment transaction (stellar-sdk). Phase 1 only ships wallet
  // creation, inert otherwise, mirroring how the aws-kms self-custody work
  // shipped in phases — see the Stellar integration plan for what's still
  // missing (withdraw, deposit detection) before this can go live.
  async withdraw(_input: WithdrawInput): Promise<WithdrawResult> {
    throw new Error("Stellar withdraw is not implemented yet (Phase 1 of the Stellar integration)");
  },
};
