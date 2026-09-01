-- 0278 — Remove guard_completeness(), its view, and the two columns that only
-- it read.
--
-- WHAT IT WAS
--
-- A four-tier scoring function (Created / Deployable / Payable / Armed post
-- eligible) over an employee's documents and record fields. It is dead three
-- times over:
--
--   * **Nothing calls it.** The only mention of `guard_completeness` in `src/`
--     is a comment: "Phase 3: tabbed record. The guard_completeness tiers that
--     used to sit above" (EmployeeManagement.tsx:847).
--   * **It scores everyone zero.** Measured, not reasoned:
--     `guard_completeness(id) ->> 'highest'` is **0 for all 69 employees** in
--     the sandbox. Not tier 3 — tier zero.
--   * **Two of its tiers are unreachable by construction.** Tier 3 is a
--     conjunction that includes `e.final_pay is not null`,
--     `e.probation_period_months is not null` and
--     `e.pay_fixed_on_probation is not null`. Nothing anywhere writes those
--     three columns, so Tier 3 — and Tier 4, which is `t3 and ...` — can never
--     be true for any employee, cash-paid or bank-paid.
--
-- The read/write sweep flagged `cash_payment_approved_by` as a possible
-- authorisation control on paying an employee in cash. It is not: nothing
-- consults it before paying anyone — no trigger, no RPC, no policy. It is one
-- clause of this score. The sweep's framing presumed an enforcement point and
-- there is none. Recorded in docs/LEDGER_UNWIRED_SWEEP.md.
--
-- WHAT IS DROPPED, AND WHAT IS NOT
--
-- Dropped: the function, the view `v_guard_completeness` that wraps it, and the
-- two columns authorised by name — `cash_payment_approved_by` and `final_pay`.
--
-- NOT dropped: `probation_period_months`, `pay_fixed_on_probation`,
-- `performance_enrolled_by`, `performance_enrolled_on`. They were candidates in
-- the same sweep and were not authorised, and `performance_enrolled_on` has a
-- plausible writer the sweep's regex did not match. Removing them because they
-- are adjacent would be exactly the over-reach the sweep warns about.
--
-- If the tiers are meant to return, these columns are the specification of what
-- "Payable" means and this migration is the thing to read first.

do $$
declare v_n int;
begin
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~ '\yguard_completeness\y' and p.proname <> 'guard_completeness';
  if v_n > 0 then
    raise exception '0278: % other function(s) reference guard_completeness', v_n;
  end if;

  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname <> 'guard_completeness'
     and p.prosrc ~ '\y(cash_payment_approved_by|final_pay)\y';
  if v_n > 0 then
    raise exception '0278: % function(s) still read cash_payment_approved_by or final_pay', v_n;
  end if;
end $$;

drop view if exists public.v_guard_completeness;
drop function if exists public.guard_completeness(uuid);

alter table public.employees drop column if exists cash_payment_approved_by restrict;
alter table public.employees drop column if exists final_pay restrict;

do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'guard_completeness') then
    raise exception '0278: guard_completeness still exists';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'employees'
                and column_name in ('cash_payment_approved_by', 'final_pay')) then
    raise exception '0278: one of the two columns survived the drop';
  end if;
end $$;