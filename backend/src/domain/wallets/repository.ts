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
  async findByUserId(userId: string): Promise<Wallet | null> {
    const { rows } = await pool.query(`select * from wallets where user_id = $1`, [userId]);
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
  async findByAddress(address: string): Promise<Wallet | null> {
    const { rows } = await pool.query(`select * from wallets where lower(address) = lower($1)`, [address]);
    return rows[0] ? mapWallet(rows[0]) : null;
  },

  async create(client: PoolClient, userId: string, created: CreatedWallet): Promise<Wallet> {
    const { rows } = await client.query(
      `insert into wallets (user_id, external_wallet_id, address, chain)
       values ($1, $2, $3, $4)
       returning *`,
      [userId, created.externalWalletId, created.address, created.chain],
    );
    return mapWallet(rows[0]);
  },
};
