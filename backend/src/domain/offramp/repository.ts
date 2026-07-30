import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { Send, SendRecipient, SendState, SendStateTransition } from "../../types.js";

function mapSend(row: any): Send {
  return {
    id: row.id,
    userId: row.user_id,
    walletId: row.wallet_id,
    tokenSymbol: row.token_symbol,
    chain: row.chain,
    amountHuman: row.amount_human,
    fiatCurrency: row.fiat_currency,
    recipient: row.recipient,
    rate: row.rate,
    feeAmount: row.fee_amount,
    treasuryAddress: row.treasury_address,
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    reference: row.reference,
    withdrawTxHash: row.withdraw_tx_hash,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransition(row: any): SendStateTransition {
  return {
    id: row.id,
    sendId: row.send_id,
    fromState: row.from_state,
    toState: row.to_state,
    trigger: row.trigger,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export const sendsRepo = {
  async findById(id: string): Promise<Send | null> {
    const { rows } = await pool.query(`select * from sends where id = $1`, [id]);
    return rows[0] ? mapSend(rows[0]) : null;
  },

  async findByProviderOrderId(providerOrderId: string): Promise<Send | null> {
    const { rows } = await pool.query(`select * from sends where provider_order_id = $1`, [providerOrderId]);
    return rows[0] ? mapSend(rows[0]) : null;
  },

  async create(
    client: PoolClient,
    input: {
      userId: string;
      walletId: string;
      tokenSymbol: string;
      chain: string;
      amountHuman: string;
      fiatCurrency: string;
      recipient: SendRecipient;
      reference: string;
      feeAmount?: string;
      treasuryAddress?: string;
    },
  ): Promise<Send> {
    const { rows } = await client.query(
      `insert into sends (user_id, wallet_id, token_symbol, chain, amount_human, fiat_currency, recipient, reference, fee_amount, treasury_address)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning *`,
      [
        input.userId,
        input.walletId,
        input.tokenSymbol,
        input.chain,
        input.amountHuman,
        input.fiatCurrency,
        JSON.stringify(input.recipient),
        input.reference,
        input.feeAmount ?? null,
        input.treasuryAddress ?? null,
      ],
    );
    return mapSend(rows[0]);
  },

  async updateOrderCreated(
    client: PoolClient,
    id: string,
    input: { providerOrderId: string; rate: string },
  ): Promise<Send> {
    const { rows } = await client.query(
      `update sends set state = 'ORDER_CREATED', provider_order_id = $2, rate = $3, updated_at = now()
       where id = $1 returning *`,
      [id, input.providerOrderId, input.rate],
    );
    return mapSend(rows[0]);
  },

  async updateState(
    client: PoolClient,
    id: string,
    input: { state: SendState; withdrawTxHash?: string },
  ): Promise<Send> {
    const { rows } = await client.query(
      `update sends set state = $2, withdraw_tx_hash = coalesce($3, withdraw_tx_hash), updated_at = now()
       where id = $1 returning *`,
      [id, input.state, input.withdrawTxHash ?? null],
    );
    return mapSend(rows[0]);
  },

  async logTransition(
    client: PoolClient,
    sendId: string,
    fromState: SendState | null,
    toState: SendState,
    trigger: string,
    actor = "system",
  ): Promise<void> {
    await client.query(
      `insert into send_state_transitions (send_id, from_state, to_state, trigger, actor)
       values ($1, $2, $3, $4, $5)`,
      [sendId, fromState, toState, trigger, actor],
    );
  },

  async getForUser(userId: string, limit = 10): Promise<Send[]> {
    const { rows } = await pool.query(`select * from sends where user_id = $1 order by created_at desc limit $2`, [
      userId,
      limit,
    ]);
    return rows.map(mapSend);
  },

  async getTransitions(sendId: string): Promise<SendStateTransition[]> {
    const { rows } = await pool.query(
      `select * from send_state_transitions where send_id = $1 order by created_at asc`,
      [sendId],
    );
    return rows.map(mapTransition);
  },
};
