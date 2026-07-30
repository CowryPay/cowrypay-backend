-- Multi-turn chat draft state (currently only remittance send drafts).
-- One row per user — a new draft simply overwrites the old one. Expiry is
-- enforced lazily at read time (see domain/chat/sessionRepository.ts)
-- against CHAT_SESSION_IDLE_MINUTES, not by a cleanup job — an expired row
-- just gets ignored and overwritten on the user's next message.
create table if not exists chat_sessions (
  user_id uuid primary key references users(id) on delete cascade,
  draft jsonb not null,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
