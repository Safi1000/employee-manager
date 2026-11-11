-- 0653: the Payroll screen's client split must keep agreeing with the posted
-- split, every night, not only on the day 0649 was applied.
--
-- 0649 made payroll_client_shares() a SECOND statement of
-- payslip_client_split()'s rule (present / double_duty / relief_cover days per
-- client, weights summing to 1, current client when there are none) and
-- asserted the two agree over every payslip on file. That assertion ran once.
-- If either function is edited later, the screen and the ledger disagree about
-- which client a guard's pay belongs to, and nothing goes red: a second copy of
-- a fact is where the disagreement lives (CLAUDE.md, "A comment is a
-- measurement of the moment it was written").
--
-- The change:
--   1. payroll_client_share_gaps(company) — one row per payslip whose screen
--      split differs from its posted split. The comparison is 0649's own,
--      scoped to one company.
--   2. ledger_checks() evaluates it as 'payroll_screen_split_matches_posted'.
--      ledger_checks has many authors (0286, 0288, 0302, 0318, 0347, 0400,
--      0402, 0516, 0518, 0520, 0542, 0590 …), so this is surgery against the
--      live definition: each anchor must appear exactly once or the migration
--      refuses. The canary's expected_check_count goes 48 → 49 in the same
--      edit (0400's mistake was skipping exactly this).
--
-- Internal only, like fuel_card_portal_gaps(): definer, executable by nobody
-- but the owner and the service role; ledger_checks() reaches it as owner.
--
-- Asserted on what can break: after the edit, ledger_checks() for every
-- company must return the new row AND the canary must pass. A count of rows
-- cannot see a canary that disagrees with itself; its own `passed` can.

create or replace function public.payroll_client_share_gaps(p_company_id uuid)
returns table(payslip_id uuid, period_month date, employee_id uuid)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if p_company_id is not null then
    perform public.assert_same_company(p_company_id);
  end if;

  return query
  with ps as (
    select p.id, p.employee_id, p.period_month
      from public.payslips p
     where p.company_id = p_company_id
  ),
  posted as (
    select ps.id, s.client_id, round(s.weight, 6) as w
      from ps cross join lateral public.payslip_client_split(ps.id) s
  ),
  months as (select distinct ps.period_month from ps),
  sh as (
    select mo.period_month, s.employee_id, s.client_id, s.weight
      from months mo cross join lateral public.payroll_client_shares(mo.period_month) s
  ),
  screen as (
    select ps.id,
           case when sh.employee_id is null then e.client_id else sh.client_id end as client_id,
           round(coalesce(sh.weight, 1), 6) as w
      from ps
      join public.employees e on e.id = ps.employee_id
      left join sh on sh.employee_id = ps.employee_id and sh.period_month = ps.period_month
  ),
  diff as (
    (select * from posted except select * from screen)
    union all
    (select * from screen except select * from posted)
  )
  select distinct ps.id, ps.period_month, ps.employee_id
    from diff join ps on ps.id = diff.id;
end $function$;

comment on function public.payroll_client_share_gaps(uuid) is
  '0653: payslips whose Payroll-screen client split (payroll_client_shares) differs from the posted split '
  '(payslip_client_split). Evaluated nightly by ledger_checks as payroll_screen_split_matches_posted. '
  'If either function changes, change both.';

revoke all on function public.payroll_client_share_gaps(uuid) from public, anon, authenticated;
grant execute on function public.payroll_client_share_gaps(uuid) to service_role;

do $mig$
declare
  v_src text;
  v_cnt int;
  v_a1 constant text := E'      from public.security_gaps()\n  )\n  select * from real_checks';
  v_b1 constant text := E'      from public.security_gaps()\n    union all\n    -- 0653. The Payroll screen groups pay by client with payroll_client_shares;\n    -- the ledger posts it with payslip_client_split. One rule, two statements:\n    -- red when any payslip''s two splits differ.\n    select ''payroll_screen_split_matches_posted''::text,\n           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0\n      from public.payroll_client_share_gaps(p_company_id)\n  )\n  select * from real_checks';
  v_a2 constant text := '(select 48::numeric n) e (n);   -- expected_check_count (0516: +5, 0518: +1, 0520: +1, 0542: +1)';
  v_b2 constant text := '(select 49::numeric n) e (n);   -- expected_check_count (0516: +5, 0518: +1, 0520: +1, 0542: +1, 0653: +1)';
  r record;
  v_companies int := 0;
begin
  select pg_get_functiondef('public.ledger_checks(uuid)'::regprocedure) into v_src;

  -- Idempotent: already applied → nothing to do (the marker is the new check).
  if position('payroll_screen_split_matches_posted' in v_src) > 0 then
    raise notice '0653: ledger_checks already evaluates payroll_screen_split_matches_posted; skipping surgery.';
  else
    v_cnt := (length(v_src) - length(replace(v_src, v_a1, ''))) / length(v_a1);
    if v_cnt <> 1 then
      raise exception '0653 REFUSED: anchor 1 (end of real_checks) appears % times in ledger_checks, expected 1.', v_cnt;
    end if;
    v_cnt := (length(v_src) - length(replace(v_src, v_a2, ''))) / length(v_a2);
    if v_cnt <> 1 then
      raise exception '0653 REFUSED: anchor 2 (expected_check_count 48) appears % times in ledger_checks, expected 1.', v_cnt;
    end if;

    v_src := replace(v_src, v_a1, v_b1);
    v_src := replace(v_src, v_a2, v_b2);
    execute v_src;
  end if;

  -- What can break: the canary disagreeing with the count, or the new check
  -- missing. Read the canary's own verdict, for every company the nightly
  -- ledger-check job evaluates (a company with no partner basis configured —
  -- the demo and the empty sign-up — makes ledger_checks raise and has never
  -- been checked; that is unchanged here).
  for r in select c.id, c.name from public.companies c
            where exists (select 1 from public.ledger_check_results x where x.company_id = c.id) loop
    v_companies := v_companies + 1;
    if not exists (select 1 from public.ledger_checks(r.id) c
                    where c.check_name = 'payroll_screen_split_matches_posted') then
      raise exception '0653 REFUSED: ledger_checks(%) does not return payroll_screen_split_matches_posted.', r.name;
    end if;
    if not (select c.passed from public.ledger_checks(r.id) c where c.check_name = 'checks_evaluated') then
      raise exception '0653 REFUSED: the checks_evaluated canary fails for % after the edit.', r.name;
    end if;
  end loop;
  if v_companies = 0 then
    raise exception '0653 REFUSED: no company has nightly ledger-check results to verify against; the assertion would be vacuous.';
  end if;

  if exists (select 1 from public.security_gaps()) then
    raise exception '0653 REFUSED: security_gaps() reports a gap.';
  end if;
  if exists (select 1 from public.tenant_guard_gaps()) then
    raise exception '0653 REFUSED: tenant_guard_gaps() reports a gap.';
  end if;
end $mig$;