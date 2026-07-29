import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { LedgerBalance } from "../../types.js";

function mapBalance(row: any): LedgerBalance {
  return {
    id: row.id,
    userId: row.user_id,
    tokenSymbol: row.token_symbol,
    availableBalance: row.available_balance,
    pendingBalance: row.pending_balance,
    updatedAt: row.updated_at,
  };
}

export const ledgerRepo = {
  async getBalancesForUser(userId: string): Promise<LedgerBalance[]> {
    const { rows } = await pool.query(`select * from ledger_balances where user_id = $1`, [userId]);
    return rows.map(mapBalance);
  },

  // Atomic upsert-increment — the addition happens in SQL, never in JS, so
  // floating-point arithmetic never touches money.
  async creditAvailable(
    client: PoolClient,
    userId: string,
    tokenSymbol: string,
    amount: string,
  ): Promise<LedgerBalance> {
    const { rows } = await client.query(
      `insert into ledger_balances (user_id, token_symbol, available_balance)
       values ($1, $2, $3)
       on conflict (user_id, token_symbol)
       do update set available_balance = ledger_balances.available_balance + excluded.available_balance,
                     updated_at = now()
       returning *`,
      [userId, tokenSymbol, amount],
    );
    return mapBalance(rows[0]);
  },
};
