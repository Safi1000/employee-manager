-- 0266 — Make checks_evaluated count the checks that actually ran, and make it
-- an assertion rather than a tautology.
--
-- TWO DEFECTS, ONE OF WHICH I INTRODUCED.
--
-- (a) 0262 added cash_per_location_gl_equals_operational OUTSIDE
--     ledger_checks_base, so the canary kept reporting 12 while 13 checks were
--     returned. A canary that undercounts is worse than none: it tells a reader
--     the result set is complete when it is short. That is my error and this is
--     the fix.
--
-- (b) The canary has always been shaped `expected = n, actual = n, passed =
--     true`. It can never fail. Nothing in the repo reads it — grep finds it
--     only in the four migrations that define it. It is a marker nobody checks,
--     which is the second half of the rule recorded in section 9.6: ASK WHAT A
--     CHECK MEASURES, NOT WHETHER IT PASSES.
--
-- It now compares a HARDCODED expected count against the number of checks
-- actually returned. Add or remove a check without updating the constant and
-- this row goes red. That is the same mechanism as the expected-red allowlist in
-- ledger_foundation.sql, and for the same reason.
--
-- The base function is still not retyped. The wrapper drops the base's canary
-- row and emits its own.

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
           0::numeric,
           count(*)::numeric,
           count(*)::numeric,
           count(*) = 0
      from public.custodian_held_operational(p_company_id) h
     where abs(h.difference) > 0.005
  )
  select * from real_checks
  union all
  -- 13 = the count this function is known to return. Bump it deliberately when
  -- adding a check; never to make this row green.
  select 'checks_evaluated'::text,
         13::numeric,
         (select count(*) from real_checks)::numeric,
         (select count(*) from real_checks)::numeric - 13,
         (select count(*) from real_checks) = 13;
$function$;

comment on function public.ledger_checks(uuid) is
  'Ledger reconciliation checks. One row per check plus a checks_evaluated row that ASSERTS the expected number of checks against the number returned — it goes red if a check is added or lost without the constant being updated. cash_per_location_gl_equals_operational (0262) compares each custodian location''s GL balance to the operational held-cash figure that src/app/lib/custodian.ts computes; the older cash_control_equals_cash_locations compares the control subtree to a view that is itself derived from journal_lines, so it measures parent-vs-children, not ledger-vs-reality.';