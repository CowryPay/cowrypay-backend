-- Real incident (2026-09-08): doubleCreditMonitor.ts's "already alerted"
-- dedup was an in-memory Set, seeded with the two originally-known cases
-- in code. findDoubleCreditedDeposits() detects the SYMPTOM (a deposit
-- with more than one BALANCE_CREDITED transition) by scanning permanent
-- history in deposit_state_transitions — a fact that never becomes false
-- again once true, even after the balance is manually corrected. Every
-- deploy restarts the process and resets that in-memory Set, so the very
-- next 5-minute check re-"discovers" every already-known, already-fixed
-- deposit as new and re-alerts on Telegram — not a one-off nuisance like
-- gasStatusMonitor.ts's own in-memory set (a transient gas dip that
-- naturally stops recurring), but a genuine forever-repeating false alarm
-- for a fact that's permanently true in the deposit history. Persisted
-- here instead so "already alerted" survives restarts.
create table if not exists double_credit_alerts (
  deposit_id uuid primary key,
  alerted_at timestamptz not null default now()
);

-- Backfills every case already known and handled before this table
-- existed: the two originally-seeded IDs from doubleCreditMonitor.ts's
-- old in-memory Set, plus the Base/USDT0-era one found and corrected
-- 2026-09-08 (see the ledger adjustment logged against this same deposit
-- id) — none of these should re-alert the moment this migration lands.
insert into double_credit_alerts (deposit_id) values
  ('95730b99-c809-423a-a9fa-5a336717550d'),
  ('519dfd50-73c2-461f-843f-7a05d0ce032e'),
  ('12e1e0b5-02bb-44d8-af17-8ba64137ea5e')
on conflict (deposit_id) do nothing;
