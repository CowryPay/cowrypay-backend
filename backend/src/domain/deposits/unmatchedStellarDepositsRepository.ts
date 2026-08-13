import { pool } from "../../db/pool.js";

export interface UnmatchedStellarDeposit {
  id: string;
  txHash: string;
  fromAddress: string;
  amount: string;
  rawMemo: string | null;
  memoType: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

function mapRow(row: any): UnmatchedStellarDeposit {
  return {
    id: row.id,
    txHash: row.tx_hash,
    fromAddress: row.from_address,
    amount: row.amount,
    rawMemo: row.raw_memo,
    memoType: row.memo_type,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

export const unmatchedStellarDepositsRepo = {
  // Relies on tx_hash's unique constraint for idempotency — a payment with
  // a missing/unrecognized memo re-seen on a later poll (e.g. after a
  // restart moved the cursor back) doesn't create a duplicate row.
  async insertIfNew(input: {
    txHash: string;
    fromAddress: string;
    amount: string;
    rawMemo: string | null;
    memoType: string | null;
  }): Promise<void> {
    await pool.query(
      `insert into unmatched_stellar_deposits (tx_hash, from_address, amount, raw_memo, memo_type)
       values ($1, $2, $3, $4, $5)
       on conflict (tx_hash) do nothing`,
      [input.txHash, input.fromAddress, input.amount, input.rawMemo, input.memoType],
    );
  },

  async listUnresolved(): Promise<UnmatchedStellarDeposit[]> {
    const { rows } = await pool.query(
      `select * from unmatched_stellar_deposits where resolved_at is null order by created_at asc`,
    );
    return rows.map(mapRow);
  },

  async findById(id: string): Promise<UnmatchedStellarDeposit | null> {
    const { rows } = await pool.query(`select * from unmatched_stellar_deposits where id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async findByTxHash(txHash: string): Promise<UnmatchedStellarDeposit | null> {
    const { rows } = await pool.query(`select * from unmatched_stellar_deposits where tx_hash = $1`, [txHash]);
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async markResolved(id: string, resolvedBy: string): Promise<void> {
    await pool.query(`update unmatched_stellar_deposits set resolved_at = now(), resolved_by = $2 where id = $1`, [
      id,
      resolvedBy,
    ]);
  },
};
