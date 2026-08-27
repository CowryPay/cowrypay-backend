import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { CrossChainSend, CrossChainSendState, CrossChainSendStateTransition } from "../../types.js";
import { sanitizeForDb } from "../../utils/format.js";

function mapSend(row: any): CrossChainSend {
  return {
    id: row.id,
    userId: row.user_id,
    walletId: row.wallet_id,
    tokenSymbol: row.token_symbol,
    sourceChain: row.source_chain,
    destinationChain: row.destination_chain,
    amountHuman: row.amount_human,
    feeAmount: row.fee_amount,
    netAmount: row.net_amount,
    toAddress: row.to_address,
    treasuryAddress: row.treasury_address,
    bridgeVendor: row.bridge_vendor,
    provider: row.provider,
    reference: row.reference,
    sourceTxHash: row.source_tx_hash,
    destinationTxHash: row.destination_tx_hash,
    bridgeReference: row.bridge_reference,
    sourceConfirmedAt: row.source_confirmed_at,
    destinationConfirmedAt: row.destination_confirmed_at,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransition(row: any): CrossChainSendStateTransition {
  return {
    id: row.id,
    crossChainSendId: row.cross_chain_send_id,
    fromState: row.from_state,
    toState: row.to_state,
    trigger: row.trigger,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export const crossChainSendsRepo = {
  async findById(id: string): Promise<CrossChainSend | null> {
    const { rows } = await pool.query(`select * from cross_chain_sends where id = $1`, [id]);
    return rows[0] ? mapSend(rows[0]) : null;
  },

  async create(
    client: PoolClient,
    input: {
      userId: string;
      walletId: string;
      tokenSymbol: string;
      sourceChain: string;
      destinationChain: string;
      amountHuman: string;
      feeAmount: string;
      netAmount: string;
      toAddress: string;
      treasuryAddress: string;
      bridgeVendor: string;
      provider: string;
      reference: string;
    },
  ): Promise<CrossChainSend> {
    const { rows } = await client.query(
      `insert into cross_chain_sends
        (user_id, wallet_id, token_symbol, source_chain, destination_chain, amount_human, fee_amount, net_amount, to_address, treasury_address, bridge_vendor, provider, reference)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       returning *`,
      [
        input.userId,
        input.walletId,
        input.tokenSymbol,
        input.sourceChain,
        input.destinationChain,
        input.amountHuman,
        input.feeAmount,
        input.netAmount,
        input.toAddress,
        input.treasuryAddress,
        input.bridgeVendor,
        input.provider,
        input.reference,
      ],
    );
    return mapSend(rows[0]);
  },

  // CAS guard, same shape as cryptoWithdrawalsRepo.updateStateIfCurrent —
  // only the caller whose expectedCurrentState still matches wins; the
  // loser gets null back and no-ops. Every transition the poller makes
  // goes through this, not the unconditional updateState below.
  async updateStateIfCurrent(
    client: PoolClient,
    id: string,
    expectedCurrentState: CrossChainSendState,
    input: {
      state: CrossChainSendState;
      sourceTxHash?: string | null;
      destinationTxHash?: string | null;
      bridgeReference?: Record<string, unknown> | null;
      sourceConfirmedAt?: boolean; // true -> set to now()
      destinationConfirmedAt?: boolean; // true -> set to now()
    },
  ): Promise<CrossChainSend | null> {
    const { rows } = await client.query(
      `update cross_chain_sends set
         state = $2,
         source_tx_hash = coalesce($3, source_tx_hash),
         destination_tx_hash = coalesce($4, destination_tx_hash),
         bridge_reference = coalesce($5, bridge_reference),
         source_confirmed_at = case when $6 then now() else source_confirmed_at end,
         destination_confirmed_at = case when $7 then now() else destination_confirmed_at end,
         updated_at = now()
       where id = $1 and state = $8
       returning *`,
      [
        id,
        input.state,
        input.sourceTxHash ?? null,
        input.destinationTxHash ?? null,
        input.bridgeReference ? JSON.stringify(input.bridgeReference) : null,
        input.sourceConfirmedAt ?? false,
        input.destinationConfirmedAt ?? false,
        expectedCurrentState,
      ],
    );
    return rows[0] ? mapSend(rows[0]) : null;
  },

  async updateState(client: PoolClient, id: string, state: CrossChainSendState): Promise<CrossChainSend> {
    const { rows } = await client.query(
      `update cross_chain_sends set state = $2, updated_at = now() where id = $1 returning *`,
      [id, state],
    );
    return mapSend(rows[0]);
  },

  async logTransition(
    client: PoolClient,
    crossChainSendId: string,
    fromState: CrossChainSendState | null,
    toState: CrossChainSendState,
    trigger: string,
    actor = "system",
  ): Promise<void> {
    await client.query(
      `insert into cross_chain_send_state_transitions (cross_chain_send_id, from_state, to_state, trigger, actor)
       values ($1, $2, $3, $4, $5)`,
      [crossChainSendId, fromState, toState, sanitizeForDb(trigger), actor],
    );
  },

  async getForUser(userId: string, limit = 10): Promise<CrossChainSend[]> {
    const { rows } = await pool.query(
      `select * from cross_chain_sends where user_id = $1 order by created_at desc limit $2`,
      [userId, limit],
    );
    return rows.map(mapSend);
  },

  async getTransitions(crossChainSendId: string): Promise<CrossChainSendStateTransition[]> {
    const { rows } = await pool.query(
      `select * from cross_chain_send_state_transitions where cross_chain_send_id = $1 order by created_at asc`,
      [crossChainSendId],
    );
    return rows.map(mapTransition);
  },

  // Three narrow poller queries instead of one — there are three distinct
  // things to wait on (source confirmation, bridge attestation +
  // destination broadcast, destination confirmation), unlike
  // crypto_withdrawals' single broadcast-then-confirm leg.
  async findPendingSourceConfirmations(): Promise<CrossChainSend[]> {
    const { rows } = await pool.query(`select * from cross_chain_sends where state = 'SOURCE_BROADCAST'`);
    return rows.map(mapSend);
  },

  async findPendingBridgeAttestations(): Promise<CrossChainSend[]> {
    const { rows } = await pool.query(
      `select * from cross_chain_sends where state in ('SOURCE_CONFIRMED', 'BRIDGING')`,
    );
    return rows.map(mapSend);
  },

  async findPendingDestinationConfirmations(): Promise<CrossChainSend[]> {
    const { rows } = await pool.query(`select * from cross_chain_sends where state = 'DESTINATION_BROADCAST'`);
    return rows.map(mapSend);
  },

  // STUCK rows the poller should keep retrying the destination completion
  // for — see service.ts's own risk-handling comment on why these are
  // never auto-refunded.
  async findStuck(): Promise<CrossChainSend[]> {
    const { rows } = await pool.query(`select * from cross_chain_sends where state = 'STUCK'`);
    return rows.map(mapSend);
  },
};
