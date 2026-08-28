-- 0200: record WHICH SHIFT an addendum's headcount change applies to.
--
-- An addendum could say "+3 Guard from 2026-09-01" but not whether those three
-- are day, evening or night. The contract's base lines are per-shift, so a
-- headcount addendum that does not name a shift cannot be turned into postings
-- or read back against the right line — the shift had to be inferred, and for a
-- brand-new line there was nothing to infer it from.
--
-- Nullable: hardware categories staff nobody, rate changes and renewals are not
-- per-shift, and every addendum written before this migration has no shift to
-- backfill with.
alter table public.contract_addendums
  add column if not exists shift_code public.shift_code;

comment on column public.contract_addendums.shift_code is
  'Shift the headcount change staffs. Null for hardware lines, rate changes and renewals.';
