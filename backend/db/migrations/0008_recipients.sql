-- Saved recipients — lets a send reference "mom" instead of re-typing and
-- re-verifying bank/mobile-money details every time. account_identifier is
-- encrypted at rest (AES-256-GCM, see domain/recipients/encryption.ts), not
-- stored as plain text — it's sensitive PII even though it's not part of
-- the KYC pipeline itself.
create table if not exists recipients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  nickname text not null,
  institution text not null,
  institution_name text not null,
  account_identifier_encrypted text not null,
  account_name text not null,
  fiat_currency text not null,
  created_at timestamptz not null default now(),
  unique (user_id, nickname)
);

create index if not exists idx_recipients_user_id on recipients(user_id);
