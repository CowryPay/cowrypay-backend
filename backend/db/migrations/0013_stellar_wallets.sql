-- Stellar uses a shared omnibus deposit address for every user (memo-based,
-- like exchange deposit flows) instead of a unique address per user — the
-- opposite of every EVM chain here. Two of wallets' original constraints
-- assumed "one row per user, one user per address" and must be relaxed
-- before a second (Stellar) row can exist for a user at all, or before two
-- different users can legitimately share the same address.
--
-- Drop the old single-column unique constraints by looking up their real
-- names (never guess auto-generated names — mirrors migration 0012's
-- approach) rather than the array_length trick 0012 used, since wallets
-- has two different single-column unique constraints to tell apart here.
do $$
declare cname text;
begin
  select conname into cname from pg_constraint c
  where c.conrelid = 'wallets'::regclass and c.contype = 'u'
    and c.conkey = (select array_agg(attnum) from pg_attribute
                     where attrelid = 'wallets'::regclass and attname = 'user_id');
  if cname is not null then execute format('alter table wallets drop constraint %I', cname); end if;

  select conname into cname from pg_constraint c
  where c.conrelid = 'wallets'::regclass and c.contype = 'u'
    and c.conkey = (select array_agg(attnum) from pg_attribute
                     where attrelid = 'wallets'::regclass and attname = 'address');
  if cname is not null then execute format('alter table wallets drop constraint %I', cname); end if;
end $$;

-- One wallet row per (user, chain) now, same shape ledger_balances already
-- has since migration 0012.
alter table wallets add constraint wallets_user_chain_key unique (user_id, chain);

-- Real EVM/Blockradar addresses must never collide between users — kept as
-- a hard guarantee for every chain except Stellar, whose shared address is
-- the one deliberate exception.
create unique index wallets_address_unique_non_stellar on wallets (address) where chain <> 'stellar';

-- Maps a user to their unique numeric MEMO_ID (Stellar's uint64 memo type —
-- the scheme exchanges like Bybit/Coinbase/Binance use; some wallets only
-- support numeric memos on send, not text ones). Allocated lazily on first
-- Stellar wallet creation. Not derived from the UUID user_id — Stellar's
-- MEMO_ID needs a real small integer.
create table if not exists stellar_memos (
  user_id uuid primary key references users(id) on delete cascade,
  memo_id bigint not null unique generated always as identity (start with 1000),
  created_at timestamptz not null default now()
);

-- Horizon's pagination cursor ("paging token") is a string, not a block
-- number, so this doesn't reuse chain_scan_cursors' bigint column.
create table if not exists stellar_deposit_cursor (
  id boolean primary key default true check (id),
  last_paging_token text,
  updated_at timestamptz not null default now()
);

-- A payment landing on the shared Stellar address with a missing or
-- unrecognized memo can't be attributed to any user — deposits.user_id and
-- wallet_id are both NOT NULL (see 0001_init.sql), so it can't enter the
-- normal deposit state machine at all. Held here for manual reconciliation;
-- once a human identifies the right user, the original tx_hash is replayed
-- through the normal ingestDeposit path (safe/idempotent via deposits'
-- existing (chain, tx_hash) unique constraint).
create table if not exists unmatched_stellar_deposits (
  id uuid primary key default gen_random_uuid(),
  tx_hash text not null unique,
  from_address text not null,
  amount numeric(38,18) not null,
  raw_memo text,
  memo_type text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);
