-- CowryPay-to-CowryPay transfers, identified by recipient memo — a pure
-- ledger movement (debit sender, credit recipient), never touching any
-- blockchain. Built after a real incident: a user tried to "send to
-- another CowryPay user" on Stellar by withdrawing to our own shared
-- Stellar deposit address with no memo, which our deposit scanner
-- correctly couldn't attribute to anyone (see unmatched_stellar_deposits)
-- — there was previously no real "send to a CowryPay user" feature at
-- all, just crypto withdrawal to an arbitrary external address. No state
-- machine/transitions table: unlike every other money-moving flow here,
-- this is a single atomic DB transaction with no async external step, so
-- there's no meaningful intermediate state to log transitions through —
-- it either fully succeeds or never happens at all.
create table if not exists internal_transfers (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references users(id) on delete cascade,
  to_user_id uuid not null references users(id) on delete cascade,
  chain text not null,
  token_symbol text not null,
  amount_human numeric(38,18) not null,
  -- The recipient identifier the sender actually provided — Stellar memo
  -- today, kept as text (not bigint) since a future chain's own recipient
  -- identifier might not be numeric.
  recipient_identifier text not null,
  reference uuid not null unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_internal_transfers_from_user on internal_transfers(from_user_id);
create index if not exists idx_internal_transfers_to_user on internal_transfers(to_user_id);
