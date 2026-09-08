import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { InternalTransfer } from "../../types.js";

function mapTransfer(row: any): InternalTransfer {
  return {
    id: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    chain: row.chain,
    tokenSymbol: row.token_symbol,
    amountHuman: row.amount_human,
    recipientIdentifier: row.recipient_identifier,
    reference: row.reference,
    createdAt: row.created_at,
  };
}

export const internalTransfersRepo = {
  async create(
    client: PoolClient,
    input: {
      fromUserId: string;
      toUserId: string;
      chain: string;
      tokenSymbol: string;
      amountHuman: string;
      recipientIdentifier: string;
      reference: string;
    },
  ): Promise<InternalTransfer> {
    const { rows } = await client.query(
      `insert into internal_transfers (from_user_id, to_user_id, chain, token_symbol, amount_human, recipient_identifier, reference)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *`,
      [
        input.fromUserId,
        input.toUserId,
        input.chain,
        input.tokenSymbol,
        input.amountHuman,
        input.recipientIdentifier,
        input.reference,
      ],
    );
    return mapTransfer(rows[0]);
  },

  async findById(id: string): Promise<InternalTransfer | null> {
    const { rows } = await pool.query(`select * from internal_transfers where id = $1`, [id]);
    return rows[0] ? mapTransfer(rows[0]) : null;
  },

  // Both directions — a user's own transfer history needs to show money
  // they sent AND money they received, not just one side.
  async getForUser(userId: string, limit = 20): Promise<InternalTransfer[]> {
    const { rows } = await pool.query(
      `select * from internal_transfers where from_user_id = $1 or to_user_id = $1 order by created_at desc limit $2`,
      [userId, limit],
    );
    return rows.map(mapTransfer);
  },
};
