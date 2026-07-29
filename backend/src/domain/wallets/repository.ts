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

  async findByAddress(address: string): Promise<Wallet | null> {
    const { rows } = await pool.query(`select * from wallets where address = $1`, [address]);
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
