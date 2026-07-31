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

  // Atomic decrement-with-guard — the balance check and the subtraction
  // happen in the same SQL statement, so two concurrent sends can't both
  // pass a separate "is there enough?" check and double-spend the same
  // balance. Returns null (not a thrown error) when there isn't enough,
  // since "insufficient balance" is an expected outcome here, not a fault.
  async debitAvailable(
    client: PoolClient,
    userId: string,
    tokenSymbol: string,
    amount: string,
  ): Promise<LedgerBalance | null> {
    const { rows } = await client.query(
      `update ledger_balances
       set available_balance = available_balance - $3, updated_at = now()
       where user_id = $1 and token_symbol = $2 and available_balance >= $3
       returning *`,
      [userId, tokenSymbol, amount],
    );
    return rows[0] ? mapBalance(rows[0]) : null;
  },
};
