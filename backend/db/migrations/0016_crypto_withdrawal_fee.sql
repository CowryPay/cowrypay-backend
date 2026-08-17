-- Crypto-to-crypto withdrawals were originally fee-free (see migration
-- 0015's own comment) — now charges 0.3%, taken from the amount, same
-- shape as the off-ramp fee columns added in 0007 for `sends`.
alter table crypto_withdrawals add column if not exists fee_amount numeric(38,18);
alter table crypto_withdrawals add column if not exists treasury_address text;
