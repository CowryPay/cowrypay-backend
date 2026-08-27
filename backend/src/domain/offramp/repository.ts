import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { Send, SendRecipient, SendState, SendStateTransition } from "../../types.js";
import { sanitizeForDb } from "../../utils/format.js";

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
    withdrawConfirmedAt: row.withdraw_confirmed_at,
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

  async findByReference(reference: string): Promise<Send | null> {
    const { rows } = await pool.query(`select * from sends where reference = $1`, [reference]);
    return rows[0] ? mapSend(rows[0]) : null;
  },

  async findByWithdrawTxHash(hash: string): Promise<Send | null> {
    const { rows } = await pool.query(`select * from sends where withdraw_tx_hash = $1`, [hash]);
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
    input: { providerOrderId: string; rate: string; provider?: string },
  ): Promise<Send> {
    // provider defaults (via coalesce) to the row's existing value — set
    // explicitly once selectOfframpProvider actually picks one; the column
    // itself still defaults to 'paycrest' at the DB level for any row this
    // is never called with a provider for.
    const { rows } = await client.query(
      `update sends set state = 'ORDER_CREATED', provider_order_id = $2, rate = $3, provider = coalesce($4, provider), updated_at = now()
       where id = $1 returning *`,
      [id, input.providerOrderId, input.rate, input.provider ?? null],
    );
    return mapSend(rows[0]);
  },

  async updateState(
    client: PoolClient,
    id: string,
    input: { state: SendState; withdrawTxHash?: string | null; rate?: string | null },
  ): Promise<Send> {
    // rate is normally set once, at order creation (updateOrderCreated) —
    // the one exception is Centiiv, which gives no rate upfront at all
    // (see centiivAdapter.ts) and only reveals it once settlement actually
    // happens, discovered by centiivSettlementPoller.ts alongside the same
    // state transition to COMPLETE this call already makes.
    const { rows } = await client.query(
      `update sends set state = $2, withdraw_tx_hash = coalesce($3, withdraw_tx_hash), rate = coalesce($4, rate), updated_at = now()
       where id = $1 returning *`,
      [id, input.state, input.withdrawTxHash ?? null, input.rate ?? null],
    );
    return mapSend(rows[0]);
  },

  // Same as updateState, except the write only lands if the row is still
  // in exactly the state the caller last read it as — the guard
  // applyTerminalFailureTransition (sendStateTransition.ts) relies on to
  // decide whether IT is the one that actually won a webhook-vs-poller
  // race and should credit the ledger, vs. losing the race and no-op'ing.
  async updateStateIfCurrent(
    client: PoolClient,
    id: string,
    expectedCurrentState: SendState,
    input: { state: SendState; withdrawTxHash?: string | null; rate?: string | null },
  ): Promise<Send | null> {
    const { rows } = await client.query(
      `update sends set state = $2, withdraw_tx_hash = coalesce($3, withdraw_tx_hash), rate = coalesce($4, rate), updated_at = now()
       where id = $1 and state = $5 returning *`,
      [id, input.state, input.withdrawTxHash ?? null, input.rate ?? null, expectedCurrentState],
    );
    return rows[0] ? mapSend(rows[0]) : null;
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
      [sendId, fromState, toState, sanitizeForDb(trigger), actor],
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

  // Sends broadcast (via any wallet adapter) but not yet checked for a
  // final on-chain outcome — withdraw_confirmed_at is only ever set once a
  // receipt is actually seen, so this naturally excludes anything already
  // processed by the confirmation poller.
  async findPendingKmsWithdrawals(): Promise<Send[]> {
    const { rows } = await pool.query(
      `select * from sends
       where state = 'PAYOUT_INITIATED' and withdraw_tx_hash is not null and withdraw_confirmed_at is null`,
    );
    return rows.map(mapSend);
  },

  async markWithdrawConfirmed(client: PoolClient, id: string): Promise<void> {
    await client.query(`update sends set withdraw_confirmed_at = now() where id = $1`, [id]);
  },

  // Safety net for paycrestSettlementPoller.ts — every send genuinely
  // waiting on Paycrest's payment_order.* webhook to advance it further.
  // Real incident that motivated this: the webhook never reached either
  // environment at all (confirmed via Railway HTTP logs — zero hits ever)
  // while Paycrest's own dashboard showed these same orders as settled.
  // Scoped to one provider — each provider's settlement poller (see
  // paycrestSettlementPoller.ts / quidaxSettlementPoller.ts) calls its own
  // provider's getOrderStatus API, which would just error on the other
  // provider's order IDs, so this must never mix them.
  async findAwaitingSettlement(provider: string): Promise<Send[]> {
    const { rows } = await pool.query(
      `select * from sends where state in ('PAYOUT_INITIATED', 'SETTLING') and provider_order_id is not null and provider = $1`,
      [provider],
    );
    return rows.map(mapSend);
  },
};
