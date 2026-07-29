-- Send → off-ramp payout state machine (architecture doc §8.2), adapted to
-- Paycrest's actual order lifecycle. withdraw_tx_hash stays null until the
-- Blockradar withdraw call (not yet implemented) actually broadcasts —
-- balance_debited only happens once that's true, never earlier.
create table if not exists sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete cascade,
  token_symbol text not null,
  chain text not null,
  amount_human numeric(38,18) not null,
  fiat_currency text not null,
  recipient jsonb not null,
  rate numeric(38,18),
  provider text not null default 'paycrest',
  provider_order_id text,
  reference text not null,
  withdraw_tx_hash text,
  state text not null default 'SEND_INSTRUCTED'
    check (state in (
      'SEND_INSTRUCTED',
      'COMPLIANCE_SCREENING',
      'MANUAL_REVIEW',
      'SEND_REJECTED',
      'ORDER_CREATED',
      'PAYOUT_INITIATED',
      'SETTLING',
      'COMPLETE',
      'FAILED',
      'REFUNDED'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reference)
);

create table if not exists send_state_transitions (
  id uuid primary key default gen_random_uuid(),
  send_id uuid not null references sends(id) on delete cascade,
  from_state text,
  to_state text not null,
  trigger text not null,
  actor text not null default 'system',
  created_at timestamptz not null default now()
);

create index if not exists idx_sends_user_id on sends(user_id);
create index if not exists idx_send_transitions_send_id on send_state_transitions(send_id);
