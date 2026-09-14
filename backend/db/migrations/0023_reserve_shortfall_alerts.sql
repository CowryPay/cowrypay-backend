-- Real incident (2026-09-14): reserveMonitor.ts's "already alerted" dedup
-- was an in-memory Set, exactly the same mistake double_credit_alerts
-- (migration 0021) already fixed for the double-credit monitor. Every
-- deploy restarts the process and resets that Set, so a shortfall that's
-- already known and explained (e.g. a platform fee already swept
-- on-chain before a provider refunded the send, see treasury.ts's
-- KNOWN_WRITE_OFFS) gets re-"discovered" as newly breached and re-alerts
-- on Telegram after every single deploy — a genuine forever-repeating
-- false alarm for a gap that isn't changing, not a one-off nuisance.
--
-- Persisted here instead: alert again only when a chain/token's shortfall
-- actually WORSENS past its last-alerted amount (a new, undiagnosed
-- problem), not merely because the process restarted. Deleted on recovery
-- (status back to OK) so a genuinely new future shortfall on the same
-- chain/token still alerts fresh.
create table if not exists reserve_shortfall_alerts (
  chain text not null,
  token_symbol text not null,
  last_delta_usdc numeric not null,
  alerted_at timestamptz not null default now(),
  primary key (chain, token_symbol)
);

-- Seeds the two shortfalls already known and explained before this table
-- existed (see treasury.ts's KNOWN_WRITE_OFFS for base/celo) plus
-- Stellar's own equivalent — three sends (0a0e36ac, 40c79a4c, a3b7ee7e)
-- refunded by the off-ramp provider after their platform fee had already
-- been swept on-chain; per sendStateTransition.ts's own documented
-- design, the user is credited back in full and the already-swept fee is
-- absorbed as the cost of the failed send, not chased. None of these
-- should re-alert the moment this migration lands.
insert into reserve_shortfall_alerts (chain, token_symbol, last_delta_usdc) values
  ('base', 'USDC', -2.8196090000000003),
  ('celo', 'USDC', -0.2995000000000001),
  ('stellar', 'USDC', -1.6599000000000501)
on conflict (chain, token_symbol) do nothing;
