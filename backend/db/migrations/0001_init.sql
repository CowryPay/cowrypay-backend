create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  phone text unique,
  kyc_status text not null default 'unverified'
    check (kyc_status in ('unverified','pending','verified','rejected')),
  kyc_reference text,
  pin_hash text,
  biometric_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  constraint users_identifier_present check (email is not null or phone is not null)
);

create table if not exists wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  provider text not null default 'blockradar',
  external_wallet_id text not null,
  address text not null unique,
  chain text not null,
  created_at timestamptz not null default now()
);

create table if not exists ledger_balances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_symbol text not null,
  available_balance numeric(38,18) not null default 0,
  pending_balance numeric(38,18) not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, token_symbol)
);

create table if not exists deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete cascade,
  token_symbol text not null,
  amount numeric(38,18) not null,
  chain text not null,
  tx_hash text not null,
  state text not null default 'DEPOSIT_DETECTED'
    check (state in (
      'DEPOSIT_DETECTED',
      'DEPOSIT_COMPLIANCE_SCREENING',
      'MANUAL_REVIEW',
      'BALANCE_CREDITED',
      'DEPOSIT_HELD',
      'RETURN_TO_SENDER'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain, tx_hash)
);

create table if not exists deposit_state_transitions (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references deposits(id) on delete cascade,
  from_state text,
  to_state text not null,
  trigger text not null,
  actor text not null default 'system',
  created_at timestamptz not null default now()
);

create index if not exists idx_deposits_user_id on deposits(user_id);
create index if not exists idx_deposit_transitions_deposit_id on deposit_state_transitions(deposit_id);
