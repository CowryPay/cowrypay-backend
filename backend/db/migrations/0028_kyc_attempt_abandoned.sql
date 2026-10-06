-- A user who opens the Dojah widget and backs out before finishing left
-- kyc_verification_attempts stuck "pending" forever — nothing but a
-- webhook that will never fire could resolve it. 'abandoned' is a new
-- terminal status for that case, deliberately distinct from 'rejected':
-- rejected means Dojah (or AML) actively reviewed and said no; abandoned
-- means no verdict was ever reached and the user should be freely
-- retryable. Looked up via pg_constraint rather than the guessed
-- auto-generated name, mirroring migrations 0012/0013's own stated
-- reasoning: never guess auto-generated constraint names.
do $$
declare cname text;
begin
  select conname into cname from pg_constraint c
  where c.conrelid = 'kyc_verification_attempts'::regclass and c.contype = 'c'
    and c.conkey = (select array_agg(attnum) from pg_attribute
                     where attrelid = 'kyc_verification_attempts'::regclass and attname = 'status');
  if cname is not null then execute format('alter table kyc_verification_attempts drop constraint %I', cname); end if;
end $$;

alter table kyc_verification_attempts add constraint kyc_verification_attempts_status_check
  check (status in ('pending', 'verified', 'rejected', 'abandoned'));

-- Persisted alongside provider_reference so a reused/resumed attempt
-- (service.ts's startKyc dedupe) can hand back the exact widgetId it
-- originally got without re-deriving Dojah's country routing logic.
-- Nullable: existing rows predate this, and mock mode has no widget at all.
alter table kyc_verification_attempts add column if not exists widget_id text;
