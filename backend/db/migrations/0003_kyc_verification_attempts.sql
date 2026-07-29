create table if not exists kyc_verification_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  provider_reference text,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'rejected')),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_kyc_attempts_user_id on kyc_verification_attempts(user_id);
create unique index if not exists idx_kyc_attempts_provider_reference
  on kyc_verification_attempts(provider_reference)
  where provider_reference is not null;
