-- Which country a KYC attempt was verified against (KYC issue: routing to
-- Nigeria/Kenya's Government-Data-capable workflow vs the global
-- Government-ID-only workflow for every other country). Nullable: existing
-- rows predate this, and the mock provider doesn't route by country at all.
-- Pure audit trail -- nothing reads this to make a decision, it just
-- records which workflow a given attempt actually used, since this exact
-- question ("which config was this evaluated against") was the root cause
-- behind more than one real incident in this feature's own history.
alter table kyc_verification_attempts add column if not exists country text;
