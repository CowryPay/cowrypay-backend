-- Crypto-to-crypto withdrawal: a user sends USDC from their CowryPay
-- balance directly to an external wallet address on-chain, bypassing
-- Paycrest entirely (no fiat conversion) — distinct from `sends`, which is
-- always an off-ramp-to-fiat payout with a bank-account-shaped recipient.
-- No fee (see fee.ts's off-ramp fee — deliberately not reused here).
create table if not exists crypto_withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete cascade,
  token_symbol text not null,
  chain text not null,
  amount_human numeric(38,18) not null,
  to_address text not null,
  provider text not null,
  reference text not null,
  withdraw_tx_hash text,
  withdraw_confirmed_at timestamptz,
  state text not null default 'PENDING'
    check (state in (
      'PENDING',
      'BROADCAST',
      'CONFIRMED',
      'FAILED'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reference)
);

create table if not exists crypto_withdrawal_state_transitions (
  id uuid primary key default gen_random_uuid(),
  crypto_withdrawal_id uuid not null references crypto_withdrawals(id) on delete cascade,
  from_state text,
  to_state text not null,
  trigger text not null,
  actor text not null default 'system',
  created_at timestamptz not null default now()
);

create index if not exists idx_crypto_withdrawals_user_id on crypto_withdrawals(user_id);
create index if not exists idx_crypto_withdrawal_transitions_withdrawal_id on crypto_withdrawal_state_transitions(crypto_withdrawal_id);
