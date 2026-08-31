-- 0284 — payroll_attendance_drift(): does the accrual still match the attendance
-- it was computed from?
--
-- SCOPE. This is the READ-ONLY half of the accrual proposal in
-- docs/LEDGER_F42_F43_AND_ACCRUAL_PROPOSAL.md, and only that half. It does not
-- recompute payroll, does not post, and does not refuse anything. The recompute
-- path is deliberately not built: it needs the payroll arithmetic to live in one
-- place both callers use, which is its own change and its own authorisation.
--
-- WHAT IT COMPARES, AND WHY THAT PARTICULAR PAIR
--
--   payslips.present_days           the days the accrual was computed on
--   count(attendance 'present')     the days the record now says were worked
--
-- Attendance and accrual are connected by nothing in the database: the payslip
-- stores present_days at the moment payroll runs, and every later correction to
-- attendance leaves it untouched. So the two can diverge silently and for as
-- long as anyone cares to look away. This function is the look.
--
-- THE STATUS MAPPING IS MEASURED, NOT ASSUMED. Five candidate formulas were
-- tested against all 48 payslips on dev:
--
--   present_days = count(present)                       48 of 48
--   present_days = count(present) + count(double_duty)    5 of 48
--   present_days = count(present) + count(relief_cover)   5 of 48
--   present_days = count(present) + 2*count(double_duty)  5 of 48
--   present_days = count(present) + count(leave)          3 of 48
--
-- Only the first holds universally, so that is the comparison. Had this been
-- guessed rather than measured, a wrong mapping would have produced a check that
-- is red on every payslip and therefore tells you nothing — which is the failure
-- mode this project keeps finding in its own instruments.
--
-- WHAT IT ESTABLISHES ABOUT THE 88,467, WHICH IS NOT WHAT WE EXPECTED
--
-- The working theory was that the 88,467 was attendance corrected after accrual:
-- 81 extra days worked, recorded late, paid but never re-accrued. **The data
-- refutes that.** All 48 payslips — the 29 over-paid ones included — have
-- present_days exactly equal to their live attendance count. Drift is zero
-- everywhere.
--
-- So the 81 extra days were never recorded as attendance at all. They were paid
-- against a figure that exists nowhere except in the payment. That is a
-- different and narrower defect than "the accrual never re-runs": the accrual
-- and the attendance agree, and the DISBURSEMENT departed from both. 0277's
-- payslips_paid_not_over_accrued makes that specific departure impossible going
-- forward.
--
-- This check is therefore GREEN ON ARRIVAL and stays useful for a different
-- reason: it covers the gap that is still open — attendance corrected after
-- accrual — which has not fired yet but has nothing preventing it. A check
-- installed only after its failure has been seen is a check installed late.
--
-- Green on arrival means it cannot prove itself on real data, so it is proved
-- against synthetic failure below, per §9.9.

create or replace function public.payroll_attendance_drift(p_company_id uuid)
returns table(payslip_id uuid, employee_id uuid, period_month date,
              accrued_days int, attendance_days int, day_delta int,
              rupee_delta numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select ps.id,
         ps.employee_id,
         ps.period_month,
         coalesce(ps.present_days, 0)::int,
         a.n::int,
         (a.n - coalesce(ps.present_days, 0))::int,
         round((a.n - coalesce(ps.present_days, 0)) * coalesce(ps.per_day_salary, 0), 2)
    from public.payslips ps
    cross join lateral (
      select count(*) as n
        from public.attendance_records ar
       where ar.employee_id = ps.employee_id
         and ar.status = 'present'
         and date_trunc('month', ar.attendance_date)::date = ps.period_month
    ) a
   where ps.company_id = p_company_id
     and a.n <> coalesce(ps.present_days, 0)
   order by abs(a.n - coalesce(ps.present_days, 0)) desc;
$function$;

comment on function public.payroll_attendance_drift(uuid) is
  'Payslips whose accrued present_days no longer equals the attendance record for that employee and month, valued at per_day_salary. Read-only: attendance and accrual are joined by nothing in the database, so a correction to either leaves the other stale and silent. The present-day mapping is measured against all payslips, not assumed. See 0284.';

revoke execute on function public.payroll_attendance_drift(uuid) from anon, public;
grant  execute on function public.payroll_attendance_drift(uuid) to authenticated, service_role;

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric,
              difference numeric, passed boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with real_checks as (
    select b.check_name, b.expected, b.actual, b.difference, b.passed
      from public.ledger_checks_base(p_company_id) b
     where b.check_name <> 'checks_evaluated'
    union all
    select 'cash_per_location_gl_equals_operational'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.custodian_held_operational(p_company_id) h
     where abs(h.difference) > 0.005
    union all
    select 'every_source_row_posted'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.unposted_source_rows(p_company_id)
    union all
    select 'bank_per_account_gl_equals_operational'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.bank_held_operational(p_company_id) b
     where abs(b.difference) > 0.005
    union all
    select 'no_negative_custodian_balance'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.negative_custodian_balances(p_company_id)
    union all
    select 'profit_allocation_exhausts_pool'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.profit_allocation_over_allocated(p_company_id)
    union all
    select 'payroll_accrual_matches_attendance'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.payroll_attendance_drift(p_company_id)
  )
  select * from real_checks
  union all
  -- 18 = the number of REAL checks. The function returns one more row than
  -- this — the canary itself. Bump the constant deliberately when adding a
  -- check; never to make this row green.
  select 'checks_evaluated'::text,
         18::numeric,
         (select count(*) from real_checks)::numeric,
         (select count(*) from real_checks)::numeric - 18,
         (select count(*) from real_checks) = 18;
$function$;

-- ---------------------------------------------------------------------------
-- PROOF AGAINST SYNTHETIC FAILURE (§9.9)
--
-- The real failure is not reachable: drift is zero on every payslip, and the
-- over-payment that motivated this work turned out not to be drift at all. So
-- the check is fed a fabricated divergence — one payslip's present_days moved by
-- three days — and must go red with the right rupee magnitude, then be rolled
-- back by a deliberate raise. Both directions are asserted: green before, red
-- after, green again once the subtransaction unwinds.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid := (select id from public.companies where name = 'SANDBOX TESTING ORG');
  v_ps    uuid;
  v_pd    numeric;
  v_before int;
  v_after  int;
  v_delta  int;
  v_rupees numeric;
  v_rows   int;
begin
  if v_co is null then
    raise notice '0284: no sandbox company; synthetic proof skipped';
  else
    select count(*) into v_before from public.payroll_attendance_drift(v_co);
    if v_before <> 0 then
      raise exception '0284: expected zero drift before the synthetic change, found %', v_before;
    end if;

    -- a payslip in a month that is not closed, so the period lock is not what
    -- this proof ends up testing
    select ps.id, ps.per_day_salary into v_ps, v_pd
      from public.payslips ps
     where ps.company_id = v_co
       and coalesce(ps.per_day_salary, 0) > 0
       and not public.is_period_closed(v_co, ps.period_month)
     order by ps.period_month desc
     limit 1;

    if v_ps is null then
      raise notice '0284: no payslip in an open month; synthetic proof not run';
    else
      begin
        update public.payslips set present_days = present_days + 3 where id = v_ps;

        select count(*) into v_after from public.payroll_attendance_drift(v_co);
        select day_delta, rupee_delta into v_delta, v_rupees
          from public.payroll_attendance_drift(v_co) where payslip_id = v_ps;

        raise exception 'ROLLBACK_PROOF';
      exception
        when others then
          if sqlerrm <> 'ROLLBACK_PROOF' then
            raise exception '0284: the synthetic change failed for the wrong reason: % %',
              sqlstate, sqlerrm;
          end if;
      end;

      if coalesce(v_after, 0) <> 1 then
        raise exception '0284: THE CHECK CANNOT FAIL — a three-day divergence produced % drift row(s)',
          coalesce(v_after, 0);
      end if;
      if v_delta <> -3 then
        raise exception '0284: drift reported % days, -3 expected', v_delta;
      end if;
      if round(v_rupees, 2) <> round(-3 * v_pd, 2) then
        raise exception '0284: drift valued at %, % expected', v_rupees, round(-3 * v_pd, 2);
      end if;

      select count(*) into v_rows from public.payroll_attendance_drift(v_co);
      if v_rows <> 0 then
        raise exception '0284: the synthetic change did not unwind — % row(s) remain', v_rows;
      end if;

      raise notice '0284: check proved able to fail (3 days = %) and green again after rollback', v_rupees;
    end if;
  end if;

  -- the canary
  select count(*) into v_rows from public.ledger_checks(
    (select id from public.companies order by created_at limit 1));
  if v_rows <> 19 then
    raise exception '0284: ledger_checks returns % rows, 19 expected (18 checks + canary)', v_rows;
  end if;
end $$;
