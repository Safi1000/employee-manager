-- 0288 — A control that counts controls nothing invokes.
--
-- DEV ONLY.
--
-- WHY THIS EXISTS, AND WHY IT IS SLIGHTLY ABSURD
--
-- docs/DETECTOR_INVOCATION_AUDIT.md found five controls that nothing calls,
-- one duplicated instead of called, and — the finding that outranks the list —
-- that ledger_checks() itself is called by no application code and no cron job.
--
-- That audit was a query somebody ran once. Left as a document it is a detector
-- nothing invokes, which is the exact defect it was written to report. Point 4
-- of the audit says so. This migration is that point, executed.
--
-- WHAT IT CAN AND CANNOT SEE
--
-- Stated plainly, because a check whose blind spots are undocumented gets
-- trusted beyond its evidence:
--
--   CAN see  — calls from other functions, views, RLS policies, CHECK
--              constraints, index expressions, column defaults, triggers, and
--              cron.job command text.
--   CANNOT see — the application. A function called only from src/ is
--              indistinguishable here from one called by nothing.
--
-- So application-invoked controls are EXEMPT BY NAME below, each with the
-- reason and the caller. An unexplained silence fails; an explained one is a
-- line somebody wrote and review can see. Same rule as tenant_guard_gaps().
--
-- ledger_checks IS DELIBERATELY NOT EXEMPT
--
-- It is the sharpest instance and it should stay visible. Nothing in the
-- database calls it and no cron job runs it, so it reports itself. When it is
-- finally scheduled — which is the ledger deployment's definition of done —
-- this check will find the cron entry and go green on its own. Until then it
-- is telling the truth: the entire check layer runs only when a person types
-- the call.

create or replace function public.uninvoked_controls()
returns table(function_name text, args text, reason text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with cand as (
    select p.oid, p.proname::text as fname,
           pg_get_function_identity_arguments(p.oid) as fargs
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname::text ~ '(gap|check|drift|residue|blocker|completeness|missing|breach|discrepanc|orphan|mismatch|unposted|over_allocated|negative_|invalid|stale|unbalanced|anomal)'
            or (p.proretset and p.proname::text ~ '(_rows|_balances|_held_|_review)'))
       -- trigger functions are invoked by definition; tgfoid is checked below
       and p.prorettype <> 'trigger'::regtype
  ),
  exempt as (
    select * from (values
      ('armed_post_blockers',
       'CALLED BY THE APPLICATION. src/ reads it for the armed-post warning; this check cannot see src/.'),
      ('sweep_ammo_discrepancy_alerts',
       'CALLED BY THE APPLICATION. src/ triggers the ammunition sweep; this check cannot see src/.'),
      ('uninvoked_controls',
       'THIS FUNCTION. It is invoked by ledger_checks(); listing itself would be noise.')
    ) as t(fname, why)
  ),
  reach as (
    select c.oid, c.fname, c.fargs,
           (select count(*) from pg_proc q
             where q.pronamespace='public'::regnamespace and q.oid <> c.oid
               and q.prosrc ~ ('\m'||c.fname||'\M'))                                  as by_fn,
           (select count(*) from pg_views v
             where v.schemaname='public' and v.definition ~ ('\m'||c.fname||'\M'))    as by_view,
           (select count(*) from pg_policy pol
             where pg_get_expr(pol.polqual, pol.polrelid) ~ ('\m'||c.fname||'\M')
                or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),'') ~ ('\m'||c.fname||'\M')) as by_policy,
           (select count(*) from pg_constraint k
             where k.contype='c' and pg_get_constraintdef(k.oid) ~ ('\m'||c.fname||'\M')) as by_check,
           (select count(*) from pg_index i
             where pg_get_indexdef(i.indexrelid) ~ ('\m'||c.fname||'\M'))             as by_index,
           (select count(*) from pg_attrdef d
             where pg_get_expr(d.adbin, d.adrelid) ~ ('\m'||c.fname||'\M'))           as by_default,
           (select count(*) from pg_trigger t where not t.tgisinternal and t.tgfoid = c.oid) as by_trigger,
           (select count(*) from cron.job j where j.active and j.command ~ ('\m'||c.fname||'\M')) as by_cron
      from cand c
  )
  select r.fname, r.fargs,
         'no function, view, policy, constraint, index, default, trigger or cron job invokes it'
    from reach r
   where r.by_fn + r.by_view + r.by_policy + r.by_check
       + r.by_index + r.by_default + r.by_trigger + r.by_cron = 0
     and not exists (select 1 from exempt e where e.fname = r.fname)
   order by 1;
$function$;

comment on function public.uninvoked_controls() is
  'Check-shaped functions that nothing inside the database invokes and no cron job runs. Cannot see the application, so application-invoked controls are exempt by name with their caller stated. ledger_checks is deliberately not exempt: it reports itself until it is scheduled. See 0288 and docs/DETECTOR_INVOCATION_AUDIT.md.';

revoke execute on function public.uninvoked_controls() from anon, public;
grant  execute on function public.uninvoked_controls() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Wire it in. 20 real checks now.
-- ---------------------------------------------------------------------------

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric, difference numeric, passed boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return query
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
    union all
    select 'tenant_guard_covers_every_parameter'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.tenant_guard_gaps()
    union all
    -- 0288. SCHEMA-WIDE. Controls that exist and that nothing asks.
    select 'every_control_is_invoked'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.uninvoked_controls()
  )
  select * from real_checks
  union all
  -- 20 = the number of REAL checks. Bump deliberately when adding one; never
  -- to make this row green.
  select 'checks_evaluated'::text,
         20::numeric,
         (select count(*) from real_checks)::numeric,
         (select count(*) from real_checks)::numeric - 20,
         (select count(*) from real_checks) = 20;
end
$function$;

-- ---------------------------------------------------------------------------
-- Verification.
--
-- The count is NOT asserted: 0289 collapses a duplicate and will change it, and
-- a verification pinned to today's number would have to be edited every time
-- somebody fixes something. What is asserted is that the check SEES, by
-- creating a control nothing invokes and requiring it to be reported.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_before int; v_after int; v_rows int; v_canary boolean;
    begin
      select id into v_co from public.companies order by created_at limit 1;

      select count(*) into v_rows from public.ledger_checks(v_co);
      if v_rows <> 21 then
        raise exception '0288 FAILED: ledger_checks returned % rows, expected 21', v_rows;
      end if;
      select passed into v_canary from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
      if not v_canary then
        raise exception '0288 FAILED: the canary is red';
      end if;

      -- The known-dead five must be among the reported. If the predicate stops
      -- matching them, it has been narrowed without anyone noticing.
      if (select count(*) from public.uninvoked_controls()
           where function_name in ('bonus_accrual_missing','check_deploy_guard',
                                   'check_disbursement','first_breach_week',
                                   'profit_allocation_review')) <> 5 then
        raise exception '0288 FAILED: the five known-uninvoked controls are not all reported';
      end if;

      -- SENSITIVITY: a new control nobody calls must appear.
      select count(*) into v_before from public.uninvoked_controls();
      execute 'create function public._probe_orphan_check() returns integer language sql stable as $p$ select 1 $p$';
      select count(*) into v_after from public.uninvoked_controls();
      if v_after <> v_before + 1 then
        raise exception 'PROBE INSENSITIVE: added an uninvoked control and the count went % -> %',
          v_before, v_after;
      end if;
      if not exists (select 1 from public.uninvoked_controls()
                      where function_name = '_probe_orphan_check') then
        raise exception 'PROBE INSENSITIVE: the new control was not named in the report';
      end if;
      execute 'drop function public._probe_orphan_check()';

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0288 verification failed: %', v_outcome;
  end if;
end
$verify$;
