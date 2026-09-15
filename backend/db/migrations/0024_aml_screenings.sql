-- AML/watchlist screening results (KYC issue #6). One row per screening
-- run, not one per user: a future periodic re-screen adds rows with a
-- different `trigger` rather than overwriting history, so what the lists
-- said on a given date stays provable.
create table if not exists aml_screenings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  trigger text not null default 'kyc_completion',
  -- Outcome of the automated screen: clear passes, review holds for an
  -- admin, blocked is a confirmed sanctions match.
  status text not null check (status in ('clear', 'review', 'blocked')),
  match_status text,
  risk_level text,
  screened_name text,
  screened_date_of_birth text,
  entity_id text,
  -- Full vendor response (or null if the call failed — see error), kept
  -- for audit rather than just the derived status.
  response jsonb,
  error text,
  review_decision text check (review_decision in ('cleared', 'blocked')),
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_aml_screenings_user_id on aml_screenings(user_id);
create index if not exists idx_aml_screenings_pending_review
  on aml_screenings(created_at)
  where status in ('review', 'blocked') and review_decision is null;
