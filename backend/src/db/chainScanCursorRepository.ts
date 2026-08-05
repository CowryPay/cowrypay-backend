import { pool } from "./pool.js";

export const chainScanCursorRepo = {
  async getCursor(chain: string): Promise<bigint | null> {
    const { rows } = await pool.query(`select last_scanned_block from chain_scan_cursors where chain = $1`, [
      chain,
    ]);
    return rows[0] ? BigInt(rows[0].last_scanned_block) : null;
  },

  async setCursor(chain: string, blockNumber: bigint): Promise<void> {
    await pool.query(
      `insert into chain_scan_cursors (chain, last_scanned_block)
       values ($1, $2)
       on conflict (chain) do update set last_scanned_block = excluded.last_scanned_block, updated_at = now()`,
      [chain, blockNumber.toString()],
    );
  },
};
