-- 0133: Contract renewal / extend-end-date addendum (Part 2).
--
-- Some contracts pass their end date while guards keep working under a not-yet-
-- signed renewal. Invoice generation is (correctly) bounded by the contract end,
-- so those months go unbilled. This adds a DATED renewal addendum that sets a new
-- end date (or makes the contract open-ended), preserving the §23 contract lock:
-- the base contracts row is never edited in place — the renewal lives in the
-- addendum log as an audit trail. Downstream (invoice window, expired detection)
-- reads the EFFECTIVE end = base end date overridden by the latest renewal in effect.
--
-- Additive only. No existing addendum, contract, or invoice data is modified.

-- 1. New change type on the addendum enum. IF NOT EXISTS keeps this idempotent.
--    (PG15: ADD VALUE is transaction-safe as long as the value isn't USED in the
--    same migration — we only add it + columns here, so this is fine.)
alter type addendum_change_type add value if not exists 'EXTEND_END_DATE';

-- 2. The renewal target, carried on the addendum row. Only meaningful for
--    EXTEND_END_DATE rows (null elsewhere). new_is_infinite = renew to open-ended;
--    when false, new_end_date holds the extended end date.
alter table public.contract_addendums
  add column if not exists new_end_date    date,
  add column if not exists new_is_infinite boolean not null default false;
