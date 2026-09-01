-- 0286 — tenant_guard_gaps() becomes a ledger check, because nothing was
-- calling it.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- WHY
--
-- 0243 built a detector for unguarded tenant-scoped parameters. 0251 sharpened
-- it to per-parameter. 0252 closed the 29 it found. All three worked.
--
-- Then twenty-three migrations (0253-0284) added SECURITY DEFINER functions
-- with tenant-scoped parameters, and on dev the detector now reports NINETEEN
-- uncovered parameters. Nothing failed. No test went red, no check reported it,
-- nobody saw it. ledger_checks() does not call tenant_guard_gaps(), so the
-- detector has been sitting there since 0243 answering a question nobody asked.
--
-- One of the nineteen is payroll_attendance_drift, added in 0284 — a function
-- written into a database whose own detector would have caught it on the day.
-- Another is ledger_checks itself: the function that will now report the gaps
-- is one of them.
--
-- This is the fourth vacuity form recorded in 9.10, and the sharpest:
--
--   A CHECK THAT IS NEVER EVALUATED IS INDISTINGUISHABLE FROM ONE THAT ALWAYS
--   PASSES.
--
-- A detector nothing invokes is not a control. It is a function that happens to
-- return the truth to no one.
--
-- WHAT THIS DOES NOT DO
--
-- It does not close the nineteen. Wiring the detector and fixing what it finds
-- are separate changes, and conflating them would mean shipping a check that
-- was green the moment it was written — which is the thing 0251 refused to do.
-- This migration deliberately leaves ledger_checks() RED on dev. That red is
-- the correct state: the gaps are real, they are now visible, and closing them
-- is a prerequisite for the ledger deployment reaching production.
--
-- A NOTE ON SCOPE
--
-- Every other row in ledger_checks() is per-company. This one is not:
-- tenant_guard_gaps() is a property of the SCHEMA, so it returns the same
-- number for every company. It is here anyway, because ledger_checks() is the
-- thing that actually gets run, and a control has value only if something
-- invokes it.

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric, difference numeric, passed boolean)
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
    union all
    -- 0286. SCHEMA-WIDE, not per-company: every tenant-scoped uuid parameter of
    -- a SECURITY DEFINER function reachable by authenticated is covered by a
    -- guard, or is listed inside tenant_guard_gaps() with a written reason.
    select 'tenant_guard_covers_every_parameter'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.tenant_guard_gaps()
  )
  select * from real_checks
  union all
  -- 19 = the number of REAL checks. The function returns one more row than
  -- this — the canary itself. Bump the constant deliberately when adding a
  -- check; never to make this row green.
  select 'checks_evaluated'::text,
         19::numeric,
         (select count(*) from real_checks)::numeric,
         (select count(*) from real_checks)::numeric - 19,
         (select count(*) from real_checks) = 19;
$function$;

comment on function public.ledger_checks(uuid) is
  'Every ledger invariant, plus the tenant-guard coverage check wired in by 0286. The guard row is schema-wide rather than per-company. checks_evaluated is the canary: it must equal the number of real checks, and the constant is bumped when a check is added, never to make the row green.';

-- ---------------------------------------------------------------------------
-- Verification.
--
-- Two things, and the second is the one that matters. That the row EXISTS
-- proves nothing — a row wired to a constant would also exist. It has to be
-- demonstrably SENSITIVE to the thing it claims to measure, so a guard is
-- stripped inside a subtransaction, the row is required to move, and the strip
-- is rolled back.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_co       uuid;
  v_gaps     int;
  v_actual   numeric;
  v_canary   record;
  v_outcome  text;
begin
  select id into v_co from public.companies order by created_at limit 1;
  if v_co is null then
    raise exception '0286 cannot self-test: no company exists';
  end if;

  select count(*) into v_gaps from public.tenant_guard_gaps();

  -- 1. The row is present and reports the live detector, not a constant.
  select actual into v_actual from public.ledger_checks(v_co)
   where check_name = 'tenant_guard_covers_every_parameter';
  if not found then
    raise exception '0286 FAILED: the tenant guard row is not in ledger_checks()';
  end if;
  if v_actual is distinct from v_gaps::numeric then
    raise exception '0286 FAILED: the row reports % but tenant_guard_gaps() returns %',
      v_actual, v_gaps;
  end if;

  -- 2. The canary still counts every real check.
  select * into v_canary from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
  if not v_canary.passed then
    raise exception '0286 FAILED: checks_evaluated is red — expected % real checks, counted %',
      v_canary.expected, v_canary.actual;
  end if;

  -- 3. NON-VACUITY. Break a guard; the row must move. Rolled back either way.
  begin
    declare
      v_src text; v_new text; v_def text; v_hdr text; v_rest text;
      v_oid oid; p1 int; p2 int; v_after numeric;
    begin
      select p.oid, p.prosrc into v_oid, v_src from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname = 'count_client_employees';

      v_new := regexp_replace(v_src, '[^\n]*assert_same_company[^\n]*\n', '', 'g');
      if v_new = v_src then
        raise exception 'PROBE_VACUOUS: count_client_employees carries no guard to strip';
      end if;

      v_def  := pg_get_functiondef(v_oid);
      p1     := strpos(v_def, '$function$');
      v_rest := substr(v_def, p1 + 10);
      p2     := strpos(v_rest, '$function$');
      v_hdr  := left(v_def, p1 - 1);
      execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest, p2 + 10);

      select actual into v_after from public.ledger_checks(v_co)
       where check_name = 'tenant_guard_covers_every_parameter';

      if v_after is distinct from (v_gaps + 1)::numeric then
        raise exception 'PROBE_INSENSITIVE: stripped a guard and the check went from % to %',
          v_gaps, v_after;
      end if;

      raise exception 'PROBE_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'PROBE_OK' then
    raise exception '0286 FAILED: %', v_outcome;
  end if;

  raise notice '0286: tenant guard check wired; it reports % uncovered parameter(s), and it moves when a guard is removed', v_gaps;
end
$verify$;
