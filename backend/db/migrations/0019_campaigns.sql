-- One-off/marketing email campaigns sent from the backend via Resend
-- (distinct from transactional emails, which this app doesn't send any of
-- today). Two tables: who has opted out (checked before every send, forever
-- — not just for the campaign that prompted the unsubscribe), and a
-- per-campaign send log so re-running a campaign send is idempotent instead
-- of re-emailing everyone who already got it.

create table if not exists campaign_unsubscribes (
  email text primary key,
  unsubscribed_at timestamptz not null default now()
);

create table if not exists campaign_sends (
  campaign_key text not null,
  email text not null,
  status text not null,
  resend_id text,
  error text,
  sent_at timestamptz not null default now(),
  primary key (campaign_key, email)
);
