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
    const wallet = await walletsRepo.findByUserId(existingUser.id);
    if (!wallet) {
      throw new Error(`User ${existingUser.id} has no wallet — data integrity issue`);
    }
    return { user: existingUser, wallet, created: false };
  }

  const adapter = getWalletAdapter();
  const createdWallet = await adapter.createWallet({ userId: authUser.id, email: authUser.email });

  try {
    return await withTransaction(async (client) => {
      const user = await usersRepo.create(client, { id: authUser.id, email: authUser.email, phone: null });
      const wallet = await walletsRepo.create(client, user.id, createdWallet, env.walletProvider);
      return { user, wallet, created: true };
    });
  } catch (err) {
    // A concurrent call for the same identity already created the account
    // (unique_violation on users.id or wallets.user_id) — fall back to
    // reading what's there instead of surfacing a 500 and leaving the
    // caller with no wallet, even though the wallet-infra call above still
    // created a real address that's now orphaned on that side.
    if ((err as { code?: string }).code !== "23505") throw err;

    const user = await usersRepo.findById(authUser.id);
    const wallet = user ? await walletsRepo.findByUserId(user.id) : null;
    if (!user || !wallet) throw err;
    return { user, wallet, created: false };
  }
}
