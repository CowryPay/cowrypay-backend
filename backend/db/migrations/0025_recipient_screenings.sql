-- AML screening of remittance recipients (KYC issue #6 follow-up). Separate
-- from aml_screenings (0024): that table's user_id is NOT NULL with a real
-- FK to users(id), since it screens a CowryPay user's own identity — a
-- remittance recipient (SendRecipient) has no corresponding user row at
-- all, just a name and account number. Sharing that table would need the
-- same disambiguation a new table already gives for free, with zero risk
-- to the already-shipped KYC review flow.
--
-- One row per distinct recipient IDENTITY, not per send or per attempt —
-- fingerprint is a cache key (accountIdentifier + fiatCurrency +
-- normalized accountName), deliberately not including the provider-coded
-- institution field (Paycrest/Quidax/Centiiv use different bank-code
-- namespaces for the same real bank, which would fragment one real-world
-- account into multiple fingerprints). A repeat send to an already-cleared
-- recipient reads this row instead of re-billing Dojah, and an admin
-- clearing/blocking a recipient here applies to every sender who might
-- try to reach them, not just whoever triggered the first screen.
create table if not exists recipient_screenings (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  account_name text not null,
  account_identifier text not null,
  fiat_currency text not null,
  provider text not null default 'dojah',
  status text not null check (status in ('clear', 'review', 'blocked')),
  match_status text,
  risk_level text,
  entity_id text,
  response jsonb,
  error text,
  review_decision text check (review_decision in ('cleared', 'blocked')),
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_recipient_screenings_fingerprint on recipient_screenings(fingerprint);
create index if not exists idx_recipient_screenings_pending_review
  on recipient_screenings(created_at)
  where status in ('review', 'blocked') and review_decision is null;
