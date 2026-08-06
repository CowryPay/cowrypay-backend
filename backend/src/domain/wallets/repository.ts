import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { Wallet } from "../../types.js";
import type { CreatedWallet } from "./adapter.js";

function mapWallet(row: any): Wallet {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    externalWalletId: row.external_wallet_id,
    address: row.address,
    chain: row.chain,
    createdAt: row.created_at,
  };
}

export const walletsRepo = {
  // Required `chain` param, deliberately not optional — since migration
  // 0013, a user can have more than one wallet row (one per chain, e.g. an
  // EVM wallet plus a Stellar one), so "the wallet for this user" is no
  // longer well-defined without saying which chain. Making this required
  // forces every call site to say which chain it means instead of silently
  // getting back an arbitrary row.
  async findByUserIdAndChain(userId: string, chain: string): Promise<Wallet | null> {
    const { rows } = await pool.query(`select * from wallets where user_id = $1 and chain = $2`, [userId, chain]);
    return rows[0] ? mapWallet(rows[0]) : null;
  },

  // Case-insensitive: an EVM address has no single canonical casing (the
  // same address can be represented all-lowercase or EIP-55 checksummed),
  // and different Blockradar API responses aren't guaranteed to agree on
  // which form they use. An exact-string match here would silently miss a
  // real wallet whenever the casing differs from what was originally
  // stored — the webhook handler would then just log it as "no wallet
  // registered" and ack 200, so Blockradar never retries and the deposit
  // never gets credited, with nothing anywhere surfacing it as a failure.
  //
  // Only safe where `address` is genuinely unique to one user — never for
  // chain='stellar', where every user's row shares the same shared deposit
  // address and this would return an arbitrary one of them. Today's only
  // callers (routes/blockradarWebhook.ts, routes/deposits.ts) are both
  // Blockradar-only, so no live bug — this is a guard against future misuse.
  async findByAddress(address: string): Promise<Wallet | null> {
    const { rows } = await pool.query(`select * from wallets where lower(address) = lower($1)`, [address]);
    return rows[0] ? mapWallet(rows[0]) : null;
  },

  async create(client: PoolClient, userId: string, created: CreatedWallet, provider: string): Promise<Wallet> {
    const { rows } = await client.query(
      `insert into wallets (user_id, provider, external_wallet_id, address, chain)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [userId, provider, created.externalWalletId, created.address, created.chain],
    );
    return mapWallet(rows[0]);
  },

  async listByProvider(provider: string): Promise<Wallet[]> {
    const { rows } = await pool.query(`select * from wallets where provider = $1`, [provider]);
    return rows.map(mapWallet);
  },

  // Exact match, deliberately not reusing findByAddress's case-insensitive
  // lower() comparison — that's correct for EVM hex (no single canonical
  // casing) but wrong for Solana's base58 addresses, where two different,
  // both-valid pubkeys can lowercase to the same string. Used by the
  // Solana deposit webhook instead of findByAddress.
  async findByChainAndAddress(chain: string, address: string): Promise<Wallet | null> {
    const { rows } = await pool.query(`select * from wallets where chain = $1 and address = $2`, [chain, address]);
    return rows[0] ? mapWallet(rows[0]) : null;
  },

  async listByChain(chain: string): Promise<Wallet[]> {
    const { rows } = await pool.query(`select * from wallets where chain = $1`, [chain]);
    return rows.map(mapWallet);
  },
};
