-- Real vulnerability closed: POST /offramp/sends accepted a full
-- client-supplied `existingOrder` object (receiveAddress, treasuryAddress,
-- amount, feeAmount, provider, etc.) with zero server-side verification —
-- only a client-controlled validUntil string gated whether it was trusted.
-- An authenticated user with any funded balance could fabricate an order
-- pointing receiveAddress/treasuryAddress at their own wallet, bypassing
-- Paycrest/Quidax/Centiiv entirely and diverting a real custodial payout
-- plus the platform fee straight to themselves.
--
-- Locked orders are now persisted here the moment they're actually created
-- with a real provider (domain/chat/remittanceDraft.ts's
-- finalizeRemittanceDraft), and initiateSend looks one up by its
-- server-generated reference instead of trusting anything the client sends
-- about where money should go. consumed_at, claimed atomically alongside
-- the ledger debit, prevents replaying the same locked order into two sends.
create table if not exists locked_offramp_orders (
  reference uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  chain text not null,
  token_symbol text not null,
  fiat_currency text not null,
  amount_human numeric(38,18) not null,
  fee_amount numeric(38,18) not null,
  treasury_address text not null,
  provider text not null,
  provider_order_id text not null,
  receive_address text not null,
  rate numeric(38,18) not null,
  recipient jsonb not null,
  valid_until timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_locked_offramp_orders_user_id on locked_offramp_orders(user_id);
