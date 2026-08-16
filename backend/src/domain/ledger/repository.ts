import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { LedgerBalance } from "../../types.js";

function mapBalance(row: any): LedgerBalance {
  return {
    id: row.id,
    userId: row.user_id,
    tokenSymbol: row.token_symbol,
    chain: row.chain,
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

  // What we owe, in total, per chain — the number a treasury dashboard
  // actually needs alongside the operational wallet's on-chain balance:
  // "what we hold" only means something next to "what we owe." A chain
  // where this exceeds the operational balance is under-collateralized
  // right now, not necessarily a bug — see fee.ts's requireTreasuryAddress
  // and offramp/service.ts's just-in-time sweep for why the two numbers
  // can legitimately diverge moment to moment.
  async getTotalAvailableByChain(tokenSymbol: string): Promise<Record<string, string>> {
    const { rows } = await pool.query(
      `select chain, coalesce(sum(available_balance), 0) as total
       from ledger_balances
       where token_symbol = $1
       group by chain`,
      [tokenSymbol],
    );
    const result: Record<string, string> = {};
    for (const row of rows) result[row.chain] = row.total;
    return result;
  },

  // Atomic upsert-increment — the addition happens in SQL, never in JS, so
  // floating-point arithmetic never touches money. Keyed on (user, token,
  // chain) since USDC on one chain isn't spendable on another — see the
  // Phase 7 migration plan.
  async creditAvailable(
    client: PoolClient,
    userId: string,
    tokenSymbol: string,
    chain: string,
    amount: string,
  ): Promise<LedgerBalance> {
    const { rows } = await client.query(
      `insert into ledger_balances (user_id, token_symbol, chain, available_balance)
       values ($1, $2, $3, $4)
       on conflict (user_id, token_symbol, chain)
       do update set available_balance = ledger_balances.available_balance + excluded.available_balance,
                     updated_at = now()
       returning *`,
      [userId, tokenSymbol, chain, amount],
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
    chain: string,
    amount: string,
  ): Promise<LedgerBalance | null> {
    const { rows } = await client.query(
      `update ledger_balances
       set available_balance = available_balance - $4, updated_at = now()
       where user_id = $1 and token_symbol = $2 and chain = $3 and available_balance >= $4
       returning *`,
      [userId, tokenSymbol, chain, amount],
    );
    return rows[0] ? mapBalance(rows[0]) : null;
  },
};
