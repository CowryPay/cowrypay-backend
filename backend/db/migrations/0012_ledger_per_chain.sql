-- Balance moves from one pooled number per token to one per (token, chain)
-- — USDC on one chain isn't spendable on another, so "pick a chain to send
-- from" only means something once balance actually tracks that. Every
-- existing row is real Celo balance (Blockradar is Celo-only), so backfill
-- is unambiguous and production behavior is unchanged: every current call
-- site keeps passing "celo" explicitly.
alter table ledger_balances add column if not exists chain text;
update ledger_balances set chain = 'celo' where chain is null;
alter table ledger_balances alter column chain set not null;

-- Drop the old 2-column unique constraint by looking it up rather than
-- guessing its auto-generated name, then add the 3-column one — without
-- dropping it, a second chain's balance row for the same user+token would
-- be rejected outright.
do $$
declare cname text;
begin
  select conname into cname from pg_constraint
  where conrelid = 'ledger_balances'::regclass and contype = 'u' and array_length(conkey, 1) = 2;
  if cname is not null then execute format('alter table ledger_balances drop constraint %I', cname); end if;
end $$;

alter table ledger_balances add constraint ledger_balances_user_token_chain_key unique (user_id, token_symbol, chain);
