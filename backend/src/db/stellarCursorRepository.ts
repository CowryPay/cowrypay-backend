import { pool } from "./pool.js";

// Horizon's pagination cursor ("paging token") is an opaque string, not a
// block number — a separate table from chain_scan_cursors rather than
// overloading its bigint column, so nothing about the working EVM scanner's
// column type/semantics changes.
export const stellarCursorRepo = {
  async getCursor(): Promise<string | null> {
    const { rows } = await pool.query(`select last_paging_token from stellar_deposit_cursor where id = true`);
    return rows[0]?.last_paging_token ?? null;
  },

  async setCursor(pagingToken: string): Promise<void> {
    await pool.query(
      `insert into stellar_deposit_cursor (id, last_paging_token)
       values (true, $1)
       on conflict (id) do update set last_paging_token = excluded.last_paging_token, updated_at = now()`,
      [pagingToken],
    );
  },
};
