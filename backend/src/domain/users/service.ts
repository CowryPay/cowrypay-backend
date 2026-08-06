import { withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import type { User, Wallet } from "../../types.js";
import { getWalletAdapter } from "../wallets/index.js";
import { walletsRepo } from "../wallets/repository.js";
import { usersRepo } from "./repository.js";

// Identity is already established by the time this runs — the caller has a
// verified Supabase Auth token (email OTP). This just makes sure a profile
// + wallet exist for that identity, creating them on first call and
// returning the existing ones on every call after (idempotent, matches
// §7.4's "reuse the existing wallet, never create a second one").
export async function ensureAccount(authUser: {
  id: string;
  email: string | null;
}): Promise<{ user: User; wallet: Wallet; created: boolean }> {
  const existingUser = await usersRepo.findById(authUser.id);
  if (existingUser) {
    const wallet = await walletsRepo.findByUserIdAndChain(existingUser.id, env.defaultChain);
    if (!wallet) {
      throw new Error(`User ${existingUser.id} has no wallet — data integrity issue`);
    }
    return { user: existingUser, wallet, created: false };
  }

  const adapter = getWalletAdapter(env.defaultChain);
  const createdWallet = await adapter.createWallet({ userId: authUser.id, email: authUser.email });

  try {
    return await withTransaction(async (client) => {
      const user = await usersRepo.create(client, { id: authUser.id, email: authUser.email, phone: null });
      const wallet = await walletsRepo.create(client, user.id, createdWallet, env.walletProvider);
      return { user, wallet, created: true };
    });
  } catch (err) {
    // A concurrent call for the same identity already created the account
    // (unique_violation on users.id or wallets' (user_id, chain) pair) —
    // fall back to reading what's there instead of surfacing a 500 and
    // leaving the caller with no wallet, even though the wallet-infra call
    // above still created a real address that's now orphaned on that side.
    if ((err as { code?: string }).code !== "23505") throw err;

    const user = await usersRepo.findById(authUser.id);
    const wallet = user ? await walletsRepo.findByUserIdAndChain(user.id, env.defaultChain) : null;
    if (!user || !wallet) throw err;
    return { user, wallet, created: false };
  }
}

// Separate from ensureAccount deliberately — Stellar is opt-in, not part of
// the default signup path (the highest-traffic path in the app), and
// "creating a wallet" here just means allocating this user's memo against
// the one shared deposit address (see stellarAdapter.ts), not a new
// on-chain address. Requires the user to already exist (created via
// ensureAccount) — this never creates a user account itself.
export async function ensureStellarWallet(userId: string): Promise<Wallet> {
  const existing = await walletsRepo.findByUserIdAndChain(userId, "stellar");
  if (existing) return existing;

  const user = await usersRepo.findById(userId);
  if (!user) throw new Error(`User ${userId} not found`);

  const adapter = getWalletAdapter("stellar");
  const createdWallet = await adapter.createWallet({ userId, email: user.email });

  try {
    return await withTransaction((client) => walletsRepo.create(client, userId, createdWallet, "stellar"));
  } catch (err) {
    // Concurrent call already created it — same fallback shape as ensureAccount.
    if ((err as { code?: string }).code !== "23505") throw err;
    const wallet = await walletsRepo.findByUserIdAndChain(userId, "stellar");
    if (!wallet) throw err;
    return wallet;
  }
}

// Same shape as ensureStellarWallet, opt-in — but unlike Stellar,
// "creating a wallet" here really does mean a brand-new on-chain address
// (see solanaAdapter.ts), pre-funded from the treasury before it's handed
// back, so this can be slower than the other ensure* calls (a real
// on-chain transaction, not just a DB insert).
export async function ensureSolanaWallet(userId: string): Promise<Wallet> {
  const existing = await walletsRepo.findByUserIdAndChain(userId, "solana");
  if (existing) return existing;

  const user = await usersRepo.findById(userId);
  if (!user) throw new Error(`User ${userId} not found`);

  const adapter = getWalletAdapter("solana");
  const createdWallet = await adapter.createWallet({ userId, email: user.email });

  try {
    return await withTransaction((client) => walletsRepo.create(client, userId, createdWallet, "solana"));
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    const wallet = await walletsRepo.findByUserIdAndChain(userId, "solana");
    if (!wallet) throw err;
    return wallet;
  }
}
