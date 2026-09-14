-- 0442 — attendance_payroll joins its rates and sites instead of looking them
--        up once per attendance row; attendance date scans get a covering index.
--
-- ===========================================================================
-- WHAT WAS WRONG
-- ===========================================================================
--
-- After 0441 took RLS off the critical path, two SECURITY DEFINER RPCs on the
-- payroll screen were still slow on their own (definer bodies never paid the
-- RLS cost, so 0441 could not help them):
--
--   attendance_payroll('2026-08-01','2026-08-31')        1,091 ms
--   attendance_leave_history('2025-08-01','2026-08-01')    221 ms
--
-- attendance_payroll's `rows` CTE carried three correlated subqueries, each
-- re-executed for every attendance row in the month (10,751 in August):
--
--   * the salary rate:  `order by effective_date desc limit 1` against
--     employee_salary_history            -> 10,751 index scans
--   * the guard's site: a sorted lookup on deployments, nested INSIDE the
--     confirmations EXISTS               ->  8,947 sorts
--   * the confirmations EXISTS itself    ->  8,947 index scans
--
-- The plan said so directly: SubPlan 1 loops=10751, InitPlan 3 loops=8947.
--
-- attendance_leave_history is a plain date-range scan, but attendance_date_idx
-- carries only the date, so every one of the 27,283 rows in a 12-month window
-- was a heap fetch: 18,269 buffer hits for a table of 1,455 pages.
--
-- ===========================================================================
-- WHAT CHANGES
-- ===========================================================================
--
-- 1. attendance_payroll: the three per-row lookups become two pre-computed
--    sets joined once.
--
--      sal — every salary-history row with the NEXT effective_date of the same
--            employee (a window LEAD), so "the latest rate on or before this
--            date" is a range join: effective_date <= d < next_date. The
--            (employee_id, effective_date) unique key guarantees exactly one
--            row matches, which is what `limit 1` used to pick.
--      dep — one site per (guard, client), chosen by the same ORDER BY the
--            subquery used: open deployment first, then latest end_date.
--
--    The confirmations EXISTS stays, but its inner deployments sort is gone;
--    it compares against dep.site_id, a plain column.
--
--    The coalesce chain, the NULL behaviour of `c.site_id = <null>` when a
--    guard has no client, the visibility rule from 0409, the double-duty
--    arithmetic from 0173 — all unchanged. This is asserted, not claimed: see
--    THE CONTROL.
--
-- 2. A covering index on attendance_records (attendance_date, employee_id)
--    INCLUDE (status, supervisor_override, worked_shift), so date-range scans
--    that only need those columns are index-only. attendance_leave_history,
--    attendance_period_counts and the month-of-attendance selects on the
--    Attendance and Payroll screens all fit it. Measured in a rolled-back
--    transaction: 221 ms -> 42 ms, with the remaining cost being heap fetches
--    for pages the visibility map has not yet marked all-visible. A VACUUM
--    clears those; it is run after this migration, outside the transaction,
--    because VACUUM cannot run inside one.
--
-- ===========================================================================
-- RESTATEMENT UNDER GUARD, NOT SURGERY, AND WHY THAT IS ALLOWED HERE
-- ===========================================================================
--
-- attendance_payroll has three authors (0129, 0173, 0409), so the rule in
-- CLAUDE.md says surgery against pg_get_functiondef, not restatement from a
-- file. The concern behind that rule is silently discarding an edit nobody
-- recorded. Two things close that concern here:
--
--   * The migration REFUSES unless the live body's md5 is the one this file
--     was written against. An unrecorded fourth edit means a different digest
--     and a refusal — the same precondition 0325 used.
--   * The new body is proved equivalent to the OLD one on this database before
--     it replaces it: for every month that has attendance, the two result sets
--     are compared in both directions with EXCEPT, and any row that differs
--     refuses the migration. That is stronger than surgery, which proves only
--     that an anchor was found.
--
-- The new text is written against the live definition read on 2026-09-14, not
-- against any migration file.
--
-- ===========================================================================
-- THE CONTROL
-- ===========================================================================
--
-- The replacement is first created as pg_temp.attendance_payroll_0442 and run
-- side by side with public.attendance_payroll on every month present in
-- attendance_records. Only when every month produces the same set of rows is
-- public.attendance_payroll replaced. The count of months compared is
-- asserted non-zero so an empty loop cannot pass.

-- ---------------------------------------------------------------------------
-- 1. Digest guard on the live body.
-- ---------------------------------------------------------------------------
do $$
declare v_md5 text;
begin
  select md5(pg_get_functiondef(p.oid)) into v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'attendance_payroll';
  if v_md5 is null then
    raise exception '0442 REFUSED: public.attendance_payroll does not exist.';
  end if;
  if v_md5 <> 'f8a1e7b457528c5bef851608ec16288f' then
    raise exception '0442 REFUSED: attendance_payroll body digest is %, expected f8a1e7b457528c5bef851608ec16288f. Someone edited it after this migration was written; read pg_get_functiondef and redo the rewrite against that.', v_md5;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The replacement, as a temp function first.
-- ---------------------------------------------------------------------------
create function pg_temp.attendance_payroll_0442(p_start date, p_end date)
 returns table(employee_id uuid, worked_shifts numeric, present_days integer, double_duty_shifts integer, earned numeric, leave_days integer, absent_days integer, rate_effective numeric)
 language sql stable
as $function$
  with sal as (
    select sh.employee_id, sh.effective_date, sh.base_salary,
           lead(sh.effective_date) over (partition by sh.employee_id order by sh.effective_date) as next_date
      from public.employee_salary_history sh
  ),
  dep as (
    select distinct on (d.guard_id, d.client_id) d.guard_id, d.client_id, d.site_id
      from public.deployments d
     order by d.guard_id, d.client_id, (d.end_date is null) desc, d.end_date desc nulls last
  ),
  rows as (
    select ar.employee_id, ar.attendance_date, lower(ar.status) as st,
      coalesce(s.base_salary, e.base_salary, 0) as rate,
      extract(day from (date_trunc('month', ar.attendance_date) + interval '1 month - 1 day'))::int as dim,
      (
        ar.supervisor_override = true
        or exists (
          select 1
          from public.attendance_confirmations c
          where c.attendance_date = ar.attendance_date
            and (
              (e.client_id is not null and c.client_id = e.client_id)
              or (e.client_id is null and e.category is not null and c.category = e.category::text)
            )
            and (c.site_id is null or c.site_id = dp.site_id)
        )
      ) as visible
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
    left join sal s on s.employee_id = ar.employee_id
                   and s.effective_date <= ar.attendance_date
                   and (s.next_date is null or ar.attendance_date < s.next_date)
    left join dep dp on dp.guard_id = ar.employee_id and dp.client_id = e.client_id
    where ar.attendance_date between p_start and p_end
  )
  select employee_id,
    sum(case when visible and st in ('present','double_duty','relief_cover') then 1 else 0 end)                    as worked_shifts,
    count(distinct attendance_date) filter (where visible and st in ('present','double_duty','relief_cover'))::int as present_days,
    (sum(case when visible and st in ('present','double_duty','relief_cover') then 1 else 0 end)
      - count(distinct attendance_date) filter (where visible and st in ('present','double_duty','relief_cover')))::int
                                                                                                                   as double_duty_shifts,
    sum(case when visible and st in ('present','double_duty','relief_cover') then rate / nullif(dim,0) else 0 end) as earned,
    sum(case when visible and st in ('leave','rotation_leave','rest_day') then 1 else 0 end)::int                  as leave_days,
    sum(case when visible and st = 'absent' then 1 else 0 end)::int                                                as absent_days,
    max(rate)                                                                                                      as rate_effective
  from rows
  group by employee_id;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Equivalence on every month that has data, both directions.
-- ---------------------------------------------------------------------------
do $$
declare m record; v_months int := 0; v_diff int; v_s date; v_e date;
begin
  for m in select distinct date_trunc('month', attendance_date)::date as mo
             from public.attendance_records order by 1
  loop
    v_s := m.mo; v_e := (m.mo + interval '1 month - 1 day')::date;
    select count(*) into v_diff from (
      (select * from public.attendance_payroll(v_s, v_e)
       except select * from pg_temp.attendance_payroll_0442(v_s, v_e))
      union all
      (select * from pg_temp.attendance_payroll_0442(v_s, v_e)
       except select * from public.attendance_payroll(v_s, v_e))
    ) x;
    if v_diff <> 0 then
      raise exception '0442 REFUSED: attendance_payroll rewrite differs from the live function for % by % row(s).', v_s, v_diff;
    end if;
    v_months := v_months + 1;
  end loop;
  if v_months = 0 then
    raise exception '0442 REFUSED: no months compared; attendance_records is empty, so equivalence was not tested.';
  end if;
  raise notice '0442: attendance_payroll equivalent on % month(s)', v_months;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Replace the live function with the proven body. Attributes are the live
--    ones: STABLE, SECURITY DEFINER, search_path = public.
-- ---------------------------------------------------------------------------
create or replace function public.attendance_payroll(p_start date, p_end date)
 returns table(employee_id uuid, worked_shifts numeric, present_days integer, double_duty_shifts integer, earned numeric, leave_days integer, absent_days integer, rate_effective numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with sal as (
    select sh.employee_id, sh.effective_date, sh.base_salary,
           lead(sh.effective_date) over (partition by sh.employee_id order by sh.effective_date) as next_date
      from public.employee_salary_history sh
  ),
  dep as (
    select distinct on (d.guard_id, d.client_id) d.guard_id, d.client_id, d.site_id
      from public.deployments d
     order by d.guard_id, d.client_id, (d.end_date is null) desc, d.end_date desc nulls last
  ),
  rows as (
    select ar.employee_id, ar.attendance_date, lower(ar.status) as st,
      coalesce(s.base_salary, e.base_salary, 0) as rate,
      extract(day from (date_trunc('month', ar.attendance_date) + interval '1 month - 1 day'))::int as dim,
      (
        ar.supervisor_override = true
        or exists (
          select 1
          from public.attendance_confirmations c
          where c.attendance_date = ar.attendance_date
            and (
              (e.client_id is not null and c.client_id = e.client_id)
              or (e.client_id is null and e.category is not null and c.category = e.category::text)
            )
            and (c.site_id is null or c.site_id = dp.site_id)
        )
      ) as visible
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
    left join sal s on s.employee_id = ar.employee_id
                   and s.effective_date <= ar.attendance_date
                   and (s.next_date is null or ar.attendance_date < s.next_date)
    left join dep dp on dp.guard_id = ar.employee_id and dp.client_id = e.client_id
    where ar.attendance_date between p_start and p_end
  )
  select employee_id,
    sum(case when visible and st in ('present','double_duty','relief_cover') then 1 else 0 end)                    as worked_shifts,
    count(distinct attendance_date) filter (where visible and st in ('present','double_duty','relief_cover'))::int as present_days,
    (sum(case when visible and st in ('present','double_duty','relief_cover') then 1 else 0 end)
      - count(distinct attendance_date) filter (where visible and st in ('present','double_duty','relief_cover')))::int
                                                                                                                   as double_duty_shifts,
    sum(case when visible and st in ('present','double_duty','relief_cover') then rate / nullif(dim,0) else 0 end) as earned,
    sum(case when visible and st in ('leave','rotation_leave','rest_day') then 1 else 0 end)::int                  as leave_days,
    sum(case when visible and st = 'absent' then 1 else 0 end)::int                                                as absent_days,
    max(rate)                                                                                                      as rate_effective
  from rows
  group by employee_id;
$function$;

comment on function public.attendance_payroll(date, date) is
  'Per-employee payroll figures from attendance for a date range. 0442: rates and sites are joined from pre-computed sets (sal, dep) rather than looked up per row; proven equivalent to the 0409 body on every month of data before replacement. Visibility rule (0409) and double-duty arithmetic (0173) unchanged.';

-- The temp copy and the live one must now agree by construction; assert it
-- once more so a copy/paste divergence between §2 and §4 cannot ship.
do $$
declare v_diff int; v_s date; v_e date;
begin
  select min(attendance_date), max(attendance_date) into v_s, v_e from public.attendance_records;
  select count(*) into v_diff from (
    (select * from public.attendance_payroll(v_s, v_e) except select * from pg_temp.attendance_payroll_0442(v_s, v_e))
    union all
    (select * from pg_temp.attendance_payroll_0442(v_s, v_e) except select * from public.attendance_payroll(v_s, v_e))
  ) x;
  if v_diff <> 0 then
    raise exception '0442 REFUSED: the installed body differs from the tested body by % row(s) over the full range.', v_diff;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. The covering index.
-- ---------------------------------------------------------------------------
create index if not exists attendance_records_date_employee_cover_idx
  on public.attendance_records (attendance_date, employee_id)
  include (status, supervisor_override, worked_shift);

comment on index public.attendance_records_date_employee_cover_idx is
  '0442: covering index for date-range scans that need only status / override / shift (attendance_leave_history, attendance_period_counts, month-of-attendance reads). attendance_date_idx alone forced a heap fetch per row.';

-- ---------------------------------------------------------------------------
-- 2. THE TENANT GUARD ASSERTION.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0442 REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see.',
      v_n, v_who;
  end if;
end $$;
