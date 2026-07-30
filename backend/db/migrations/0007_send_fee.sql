-- Platform fee bookkeeping — accounting only for now. The actual on-chain
-- fee transfer to treasury_address happens once the withdraw broadcast
-- (Blockradar) is built; until then this just records what fee *would* be
-- taken and where it's slated to go, computed at quote time.
alter table sends add column if not exists fee_amount numeric(38,18);
alter table sends add column if not exists treasury_address text;
