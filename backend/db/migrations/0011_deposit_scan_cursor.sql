-- Tracks how far the self-custody deposit scanner (celoDepositScanner.ts)
-- has scanned per chain, so restarts resume instead of re-scanning from
-- scratch or missing a gap.
create table if not exists chain_scan_cursors (
  chain text primary key,
  last_scanned_block bigint not null,
  updated_at timestamptz not null default now()
);
