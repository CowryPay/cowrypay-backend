-- Cross-chain send: a user's ledger balance on one chain becomes real
-- USDC on a different chain via a real bridge per send (Circle CCTP for
-- Base/Optimism/Solana/Stellar; a separate third-party bridge for Celo,
-- which CCTP doesn't support at all — see domain/crossChainSend/bridge/).
-- Distinct from crypto_withdrawals (same-chain only, single
-- broadcast-then-confirm leg): this has a genuine multi-phase lifecycle,
-- since funds are, for a real window, in flight between two chains with
-- no synchronous fallback if the destination leg fails.
create table if not exists cross_chain_sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete cascade,
  token_symbol text not null,
  source_chain text not null,
  destination_chain text not null,
  amount_human numeric(38,18) not null,
  fee_amount numeric(38,18) not null,
  net_amount numeric(38,18) not null,
  to_address text not null,
  treasury_address text not null,
  -- 'cctp' | 'celo-bridge' (Phase 3) — audit/debug field, not branched on
  -- anywhere outside the bridge adapter that produced the row.
  bridge_vendor text not null,
  provider text not null,
  reference text not null,
  source_tx_hash text,
  destination_tx_hash text,
  -- Opaque, adapter-specific handle needed to poll/complete the bridge
  -- (CCTP's message bytes + nonce, or a future vendor's own transfer id).
  -- Only the adapter that produced it ever parses this — same "opaque
  -- handle" discipline as WithdrawResult.txHash being adapter-produced.
  bridge_reference jsonb,
  source_confirmed_at timestamptz,
  destination_confirmed_at timestamptz,
  state text not null default 'PENDING'
    check (state in (
      'PENDING',               -- ledger debited, source leg not yet broadcast
      'SOURCE_BROADCAST',      -- burn/lock tx sent, unconfirmed
      'SOURCE_CONFIRMED',      -- burn/lock finalized on the source chain
      'BRIDGING',              -- attestation/vendor confirmation in progress
      'DESTINATION_BROADCAST', -- mint/release tx sent on the destination chain, unconfirmed
      'COMPLETE',              -- destination tx confirmed, funds landed
      'FAILED',                -- failed before the source leg confirmed — safe to auto-refund
      'STUCK',                 -- source leg confirmed but destination leg failed — NOT auto-refunded, needs the manual-refund path
      'REFUNDED'                -- ops-resolved STUCK case, manually reconciled and credited back
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reference)
);

create table if not exists cross_chain_send_state_transitions (
  id uuid primary key default gen_random_uuid(),
  cross_chain_send_id uuid not null references cross_chain_sends(id) on delete cascade,
  from_state text,
  to_state text not null,
  trigger text not null,
  actor text not null default 'system',
  created_at timestamptz not null default now()
);

create index if not exists idx_cross_chain_sends_user_id on cross_chain_sends(user_id);
create index if not exists idx_cross_chain_sends_state on cross_chain_sends(state);
create index if not exists idx_cross_chain_send_transitions_send_id on cross_chain_send_state_transitions(cross_chain_send_id);
