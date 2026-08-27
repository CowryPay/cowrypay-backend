import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { CryptoWithdrawal, CryptoWithdrawalState, CryptoWithdrawalStateTransition } from "../../types.js";
import { sanitizeForDb } from "../../utils/format.js";

function mapWithdrawal(row: any): CryptoWithdrawal {
  return {
    id: row.id,
    userId: row.user_id,
    walletId: row.wallet_id,
    tokenSymbol: row.token_symbol,
    chain: row.chain,
    amountHuman: row.amount_human,
    toAddress: row.to_address,
    feeAmount: row.fee_amount,
    treasuryAddress: row.treasury_address,
    provider: row.provider,
    reference: row.reference,
    withdrawTxHash: row.withdraw_tx_hash,
    withdrawConfirmedAt: row.withdraw_confirmed_at,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransition(row: any): CryptoWithdrawalStateTransition {
  return {
    id: row.id,
    cryptoWithdrawalId: row.crypto_withdrawal_id,
    fromState: row.from_state,
    toState: row.to_state,
    trigger: row.trigger,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export const cryptoWithdrawalsRepo = {
  async findById(id: string): Promise<CryptoWithdrawal | null> {
    const { rows } = await pool.query(`select * from crypto_withdrawals where id = $1`, [id]);
    return rows[0] ? mapWithdrawal(rows[0]) : null;
  },

  async create(
    client: PoolClient,
    input: {
      userId: string;
      walletId: string;
      tokenSymbol: string;
      chain: string;
      amountHuman: string;
      toAddress: string;
      feeAmount: string;
      treasuryAddress: string;
      provider: string;
      reference: string;
    },
  ): Promise<CryptoWithdrawal> {
    const { rows } = await client.query(
      `insert into crypto_withdrawals (user_id, wallet_id, token_symbol, chain, amount_human, to_address, fee_amount, treasury_address, provider, reference)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning *`,
      [
        input.userId,
        input.walletId,
        input.tokenSymbol,
        input.chain,
        input.amountHuman,
        input.toAddress,
        input.feeAmount,
        input.treasuryAddress,
        input.provider,
        input.reference,
      ],
    );
    return mapWithdrawal(rows[0]);
  },

  // CAS guard — closes a real double-credit race: checkPendingCryptoWithdrawals
  // runs on a 30s setInterval with no re-entrancy guard, so an RPC call
  // slow enough to overrun one cycle lets the next tick start while the
  // first is still mid-flight; both would read the same still-BROADCAST
  // row and, without this guard, both independently credit the ledger for
  // the same reverted withdrawal. Only the update whose expectedCurrentState
  // still matches wins; the loser gets null back and no-ops. Mirrors
  // sendsRepo.updateStateIfCurrent exactly.
  async updateStateIfCurrent(
    client: PoolClient,
    id: string,
    expectedCurrentState: CryptoWithdrawalState,
    input: { state: CryptoWithdrawalState; withdrawTxHash?: string | null },
  ): Promise<CryptoWithdrawal | null> {
    const { rows } = await client.query(
      `update crypto_withdrawals set state = $2, withdraw_tx_hash = coalesce($3, withdraw_tx_hash), updated_at = now()
       where id = $1 and state = $4 returning *`,
      [id, input.state, input.withdrawTxHash ?? null, expectedCurrentState],
    );
    return rows[0] ? mapWithdrawal(rows[0]) : null;
  },

  async updateState(
    client: PoolClient,
    id: string,
    input: { state: CryptoWithdrawalState; withdrawTxHash?: string | null },
  ): Promise<CryptoWithdrawal> {
    const { rows } = await client.query(
      `update crypto_withdrawals set state = $2, withdraw_tx_hash = coalesce($3, withdraw_tx_hash), updated_at = now()
       where id = $1 returning *`,
      [id, input.state, input.withdrawTxHash ?? null],
    );
    return mapWithdrawal(rows[0]);
  },

  async logTransition(
    client: PoolClient,
    cryptoWithdrawalId: string,
    fromState: CryptoWithdrawalState | null,
    toState: CryptoWithdrawalState,
    trigger: string,
    actor = "system",
  ): Promise<void> {
    await client.query(
      `insert into crypto_withdrawal_state_transitions (crypto_withdrawal_id, from_state, to_state, trigger, actor)
       values ($1, $2, $3, $4, $5)`,
      [cryptoWithdrawalId, fromState, toState, sanitizeForDb(trigger), actor],
    );
  },

  async getForUser(userId: string, limit = 10): Promise<CryptoWithdrawal[]> {
    const { rows } = await pool.query(
      `select * from crypto_withdrawals where user_id = $1 order by created_at desc limit $2`,
      [userId, limit],
    );
    return rows.map(mapWithdrawal);
  },

  async getTransitions(cryptoWithdrawalId: string): Promise<CryptoWithdrawalStateTransition[]> {
    const { rows } = await pool.query(
      `select * from crypto_withdrawal_state_transitions where crypto_withdrawal_id = $1 order by created_at asc`,
      [cryptoWithdrawalId],
    );
    return rows.map(mapTransition);
  },

  // Mirrors sendsRepo.findPendingKmsWithdrawals exactly — broadcast (via
  // aws-kms, the only async-confirm adapter) but not yet checked for a
  // final on-chain outcome. Stellar/Solana never land here since their
  // withdraw() calls already confirm synchronously before returning.
  async findPendingKmsWithdrawals(): Promise<CryptoWithdrawal[]> {
    const { rows } = await pool.query(
      `select * from crypto_withdrawals
       where state = 'BROADCAST' and withdraw_tx_hash is not null and withdraw_confirmed_at is null`,
    );
    return rows.map(mapWithdrawal);
  },

  async markWithdrawConfirmed(client: PoolClient, id: string): Promise<void> {
    await client.query(`update crypto_withdrawals set withdraw_confirmed_at = now() where id = $1`, [id]);
  },
};
