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
// Every user ends up with all three wallet types without any explicit
// opt-in step, but the two ways that happens are deliberately asymmetric —
// Stellar and Solana aren't actually the same cost to create:
//
// - EVM: already automatic (createAccountCore below), unchanged.
// - Stellar: also made synchronous here. Allocating a memo is just a DB
//   insert against the one shared deposit address (stellarAdapter.ts) —
//   no on-chain transaction, no treasury spend — so there's no real reason
//   to keep it lazy/opt-in the way it started out.
// - Solana: kicked off in the background, NOT awaited. Unlike Stellar,
//   creating a Solana wallet is a real on-chain transaction (pre-funding
//   the new address's rent-exemption + creating its USDC ATA — see
//   solanaAdapter.ts) with real on-chain confirmation latency and a real
//   (if small) treasury cost. Blocking every signup on that would put
//   Solana's confirmation time inside the signup request for every user,
//   including the share who may never touch Solana at all.
// - ensureStellarWallet/ensureSolanaWallet are both already idempotent, so
//   GET /wallets/stellar, GET /wallets/solana, and the chat deposit-chain
//   flow all still call them directly too — the on-demand path is the
//   safety net for the rare case someone asks for their Solana address in
//   the second or two before this background call finishes (or if it
//   failed and needs a retry).
// - Errors from either are logged, never thrown — a hiccup allocating a
//   Stellar memo or creating a Solana wallet must not fail the signup
//   itself, which only ever promises the EVM wallet every other part of
//   the app actually depends on.
// - Runs on every ensureAccount call, not just brand-new signups — this is
//   also how a user who signed up before this existed gets backfilled;
//   the idempotent check inside each ensure*Wallet call makes the repeat
//   work for already-provisioned users cheap (one lookup, no-op).
export async function ensureAccount(
  authUser: { id: string; email: string | null },
): Promise<{ user: User; wallet: Wallet; created: boolean }> {
  const result = await ensureAccountCore(authUser);

  await ensureStellarWallet(result.user.id).catch((err) => {
    console.error(`[ensureAccount] failed to ensure Stellar wallet for ${result.user.id}:`, err);
  });
  ensureSolanaWallet(result.user.id).catch((err) => {
    console.error(`[ensureAccount] background Solana wallet creation failed for ${result.user.id}:`, err);
  });

  return result;
}

async function ensureAccountCore(authUser: {
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

// Called automatically (and awaited) from ensureAccount above, but kept as
// its own exported function since GET /wallets/stellar and the chat
// deposit-chain flow also call it directly — idempotent either way, and
// "creating a wallet" here just means allocating this user's memo against
// the one shared deposit address (see stellarAdapter.ts), not a new
// on-chain address, which is exactly why it's cheap enough to run
// synchronously on every signup. Requires the user to already exist
// (created via ensureAccountCore) — this never creates a user account
// itself.
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

// Called automatically from ensureAccount above too, but deliberately NOT
// awaited there (fire-and-forget) — unlike ensureStellarWallet, "creating a
// wallet" here really does mean a brand-new on-chain address (see
// solanaAdapter.ts), pre-funded from the treasury before it's handed back,
// so this is meaningfully slower (a real on-chain transaction, not just a
// DB insert) and shouldn't sit inside every signup's response time. Kept
// as its own exported function since GET /wallets/solana and the chat
// deposit-chain flow also call it directly — idempotent either way, and
// that direct/on-demand path is the safety net for the rare case someone
// asks for their Solana address before the background call from signup has
// finished (or if it failed and needs a retry).
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
