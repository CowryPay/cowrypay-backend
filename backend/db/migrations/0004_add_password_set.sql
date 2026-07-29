-- Bookkeeping only — the password itself lives entirely in Supabase Auth's
-- own auth.users table, never touches this database. This flag just tracks
-- whether the user has completed the mandatory post-signup "set a password"
-- step, so the frontend knows whether to show that screen.
alter table users add column if not exists password_set boolean not null default false;
