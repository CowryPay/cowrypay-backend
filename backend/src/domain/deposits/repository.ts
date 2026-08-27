import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { Deposit, DepositState, DepositStateTransition } from "../../types.js";
import { sanitizeForDb } from "../../utils/format.js";

function mapDeposit(row: any): Deposit {
  return {
    id: row.id,
    userId: row.user_id,
    walletId: row.wallet_id,
    tokenSymbol: row.token_symbol,
    amount: row.amount,
    chain: row.chain,
    txHash: row.tx_hash,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransition(row: any): DepositStateTransition {
  return {
    id: row.id,
    depositId: row.deposit_id,
    fromState: row.from_state,
    toState: row.to_state,
    trigger: row.trigger,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export const depositsRepo = {
  async findById(id: string): Promise<Deposit | null> {
    const { rows } = await pool.query(`select * from deposits where id = $1`, [id]);
    return rows[0] ? mapDeposit(rows[0]) : null;
  },

  async findByIdForUpdate(client: PoolClient, id: string): Promise<Deposit | null> {
    const { rows } = await client.query(`select * from deposits where id = $1 for update`, [id]);
    return rows[0] ? mapDeposit(rows[0]) : null;
  },

  async findByChainAndTxHash(chain: string, txHash: string): Promise<Deposit | null> {
    const { rows } = await pool.query(`select * from deposits where chain = $1 and tx_hash = $2`, [
      chain,
      txHash,
    ]);
    return rows[0] ? mapDeposit(rows[0]) : null;
  },

  async listForUser(userId: string, limit: number): Promise<Deposit[]> {
    const { rows } = await pool.query(`select * from deposits where user_id = $1 order by created_at desc limit $2`, [
      userId,
      limit,
    ]);
    return rows.map(mapDeposit);
  },

  // Relies on the (chain, tx_hash) unique constraint for idempotency — a
  // retried webhook delivery for the same deposit returns null here instead
  // of creating a duplicate.
  async insertIfNew(
    client: PoolClient,
    input: {
      userId: string;
      walletId: string;
      tokenSymbol: string;
      amount: string;
      chain: string;
      txHash: string;
    },
  ): Promise<Deposit | null> {
    const { rows } = await client.query(
      `insert into deposits (user_id, wallet_id, token_symbol, amount, chain, tx_hash)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (chain, tx_hash) do nothing
       returning *`,
      [input.userId, input.walletId, input.tokenSymbol, input.amount, input.chain, input.txHash],
    );
    return rows[0] ? mapDeposit(rows[0]) : null;
  },

  async updateState(client: PoolClient, id: string, state: DepositState): Promise<Deposit> {
    const { rows } = await client.query(
      `update deposits set state = $2, updated_at = now() where id = $1 returning *`,
      [id, state],
    );
    return mapDeposit(rows[0]);
  },

  // CAS guard — closes a real double-credit bug: ingestDeposit's own
  // fallback path (re-triggering screening when a concurrent call's
  // insertIfNew conflicts but the row is still DEPOSIT_DETECTED) can run
  // TWICE for the same deposit if two calls race close enough together
  // (e.g. a scanner cycle overrunning its interval, or a redelivered
  // webhook) — both see DEPOSIT_DETECTED, both ran the full screening ->
  // credit sequence independently, since updateState above has no guard
  // against that. Confirmed live: a real $1 Stellar deposit was credited
  // twice this way. Only the update whose expectedCurrentState still
  // matches wins; the loser gets null back and backs off instead of
  // duplicating the credit.
  async updateStateIfCurrent(
    client: PoolClient,
    id: string,
    expectedCurrentState: DepositState,
    nextState: DepositState,
  ): Promise<Deposit | null> {
    const { rows } = await client.query(
      `update deposits set state = $2, updated_at = now() where id = $1 and state = $3 returning *`,
      [id, nextState, expectedCurrentState],
    );
    return rows[0] ? mapDeposit(rows[0]) : null;
  },

  async logTransition(
    client: PoolClient,
    depositId: string,
    fromState: DepositState | null,
    toState: DepositState,
    trigger: string,
    actor = "system",
  ): Promise<void> {
    await client.query(
      `insert into deposit_state_transitions (deposit_id, from_state, to_state, trigger, actor)
       values ($1, $2, $3, $4, $5)`,
      [depositId, fromState, toState, sanitizeForDb(trigger), actor],
    );
  },

  async getForUser(userId: string, limit = 10): Promise<Deposit[]> {
    const { rows } = await pool.query(
      `select * from deposits where user_id = $1 order by created_at desc limit $2`,
      [userId, limit],
    );
    return rows.map(mapDeposit);
  },

  async getTransitions(depositId: string): Promise<DepositStateTransition[]> {
    const { rows } = await pool.query(
      `select * from deposit_state_transitions where deposit_id = $1 order by created_at asc`,
      [depositId],
    );
    return rows.map(mapTransition);
  },

  // Used by solanaAtaReclaimer.ts to tell "this ATA was created but this
  // user has never actually deposited this token" (safe to close and
  // reclaim the rent) apart from "this ATA is at zero right now only
  // because it was just swept" (must NOT be closed — this user is active
  // and will likely receive more). A wallet with any row here, regardless
  // of state, has demonstrated real use of this token on this chain.
  async hasAnyDeposit(walletId: string, tokenSymbol: string): Promise<boolean> {
    const { rows } = await pool.query(
      `select 1 from deposits where wallet_id = $1 and token_symbol = $2 limit 1`,
      [walletId, tokenSymbol],
    );
    return rows.length > 0;
  },
};
