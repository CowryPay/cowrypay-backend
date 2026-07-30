-- domain/pin/service.ts already flagged this as a prerequisite before PIN
-- verification is relied on to authorize an actual fund-moving action —
-- without it, a stolen bearer token could brute-force a 4-6 digit PIN in
-- seconds. Locks out after 5 consecutive failures for 15 minutes.
alter table users add column if not exists pin_failed_attempts integer not null default 0;
alter table users add column if not exists pin_locked_until timestamptz;
