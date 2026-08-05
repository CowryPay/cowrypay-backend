-- Marks when a self-custody (aws-kms) withdraw's on-chain receipt has been
-- checked and found successful, so the confirmation poller's query doesn't
-- re-process the same send forever (state itself doesn't advance on
-- success — see withdrawConfirmationPoller.ts).
alter table sends add column if not exists withdraw_confirmed_at timestamptz;
