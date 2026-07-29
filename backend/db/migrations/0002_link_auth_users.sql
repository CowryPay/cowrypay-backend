-- Identity now comes from Supabase Auth (email OTP) instead of being
-- self-issued at signup — public.users becomes a profile row keyed by the
-- same id as auth.users, not an independent identity table.
alter table users
  alter column id drop default,
  add constraint users_id_fkey foreign key (id) references auth.users(id) on delete cascade;
