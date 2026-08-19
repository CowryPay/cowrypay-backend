import type { Pool, PoolClient } from "pg";
import type { SendRecipient } from "../../types.js";

export interface LockedOfframpOrder {
  reference: string;
  userId: string;
  chain: string;
  tokenSymbol: string;
  fiatCurrency: string;
  amountHuman: string;
  feeAmount: string;
  treasuryAddress: string;
  provider: string;
  providerOrderId: string;
  receiveAddress: string;
  rate: string;
  recipient: SendRecipient;
  validUntil: string;
  consumedAt: string | null;
  createdAt: string;
}

function mapRow(row: any): LockedOfframpOrder {
  return {
    reference: row.reference,
    userId: row.user_id,
    chain: row.chain,
    tokenSymbol: row.token_symbol,
    fiatCurrency: row.fiat_currency,
    amountHuman: row.amount_human,
    feeAmount: row.fee_amount,
    treasuryAddress: row.treasury_address,
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    receiveAddress: row.receive_address,
    rate: row.rate,
    recipient: row.recipient,
    validUntil: row.valid_until,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

export const lockedOrdersRepo = {
  // Called once, right after a real order is actually created with a
  // provider (remittanceDraft.ts) — not inside any transaction, since it's
  // a standalone insert with nothing else to coordinate.
  async create(
    pool: Pool,
    input: {
      reference: string;
      userId: string;
      chain: string;
      tokenSymbol: string;
      fiatCurrency: string;
      amountHuman: string;
      feeAmount: string;
      treasuryAddress: string;
      provider: string;
      providerOrderId: string;
      receiveAddress: string;
      rate: string;
      recipient: SendRecipient;
      validUntil: string;
    },
  ): Promise<LockedOfframpOrder> {
    const { rows } = await pool.query(
      `insert into locked_offramp_orders
        (reference, user_id, chain, token_symbol, fiat_currency, amount_human, fee_amount, treasury_address, provider, provider_order_id, receive_address, rate, recipient, valid_until)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning *`,
      [
        input.reference,
        input.userId,
        input.chain,
        input.tokenSymbol,
        input.fiatCurrency,
        input.amountHuman,
        input.feeAmount,
        input.treasuryAddress,
        input.provider,
        input.providerOrderId,
        input.receiveAddress,
        input.rate,
        JSON.stringify(input.recipient),
        input.validUntil,
      ],
    );
    return mapRow(rows[0]);
  },

  // Read-only preview — used before the debit transaction starts, purely to
  // learn which chain/token/amount this quote was locked for (so the right
  // wallet gets looked up). Never itself sufficient to authorize spending
  // anything; claim() below is what actually matters for that.
  async findByReference(reference: string, userId: string, pool: Pool): Promise<LockedOfframpOrder | null> {
    const { rows } = await pool.query(`select * from locked_offramp_orders where reference = $1 and user_id = $2`, [
      reference,
      userId,
    ]);
    return rows[0] ? mapRow(rows[0]) : null;
  },

  // Atomically claims the order for use, inside the same transaction as
  // the ledger debit it authorizes — only succeeds if it belongs to this
  // user and hasn't already been consumed, so a client can't replay one
  // locked order into two separate sends. Called alongside (not before)
  // the balance check so a legitimate insufficient-balance retry — which
  // rolls the whole transaction back, claim included — still leaves the
  // quote reusable, same as it was before this table existed.
  async claim(client: PoolClient, reference: string, userId: string): Promise<LockedOfframpOrder | null> {
    const { rows } = await client.query(
      `update locked_offramp_orders set consumed_at = now()
       where reference = $1 and user_id = $2 and consumed_at is null
       returning *`,
      [reference, userId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },
};
