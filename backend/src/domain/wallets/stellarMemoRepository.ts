import { pool } from "../../db/pool.js";

export const stellarMemoRepo = {
  // Idempotent: a concurrent call for the same user hits stellar_memos'
  // unique(user_id) and just no-ops, then the select below reads back
  // whichever row won — same fallback shape already used elsewhere for
  // "create or return existing" (see users/service.ts's ensureAccount).
  async allocate(userId: string): Promise<bigint> {
    await pool.query(`insert into stellar_memos (user_id) values ($1) on conflict (user_id) do nothing`, [userId]);
    const { rows } = await pool.query(`select memo_id from stellar_memos where user_id = $1`, [userId]);
    return BigInt(rows[0].memo_id);
  },

  async findByMemoId(memoId: bigint): Promise<{ userId: string } | null> {
    const { rows } = await pool.query(`select user_id from stellar_memos where memo_id = $1`, [memoId.toString()]);
    return rows[0] ? { userId: rows[0].user_id } : null;
  },
};
