-- 0443 — attendance_payroll computes `visible` once per row, and the
--        confirmations check is four hashed sets instead of a per-row probe.
--
-- ===========================================================================
-- CORRECTION TO 0442'S HEADER
-- ===========================================================================
--
-- 0442 reports its rewrite as "1,091 ms -> 17 ms". The 17 ms was a
-- measurement artefact and 0442 is applied, so the correction lives here.
--
-- The candidate body was tested as a plain `language sql` temp function with
-- no SECURITY DEFINER and no SET clause. That makes it inlinable, and it was
-- called under `select count(*) from …`, so the planner inlined it and then
-- dropped every column the count did not need — including `visible`, which is
-- the expensive one. The installed function is SECURITY DEFINER with
-- SET search_path, is not inlinable, and computes everything. Measured
-- honestly after 0442 landed: 680 ms. Better than 1,091, not 17.
--
-- The lesson is the one CLAUDE.md already states for header figures: a number
-- fetched under different conditions from the thing it describes is a second
-- copy of a fact. Time the function that will actually run, with the
-- attributes it will actually have, and read every column.
--
-- ===========================================================================
-- WHAT WAS STILL WRONG, AND HOW IT WAS FOUND
-- ===========================================================================
--
-- EXPLAIN on the installed body showed SubPlan 1 … SubPlan 7, each the same
-- confirmations EXISTS, each with loops=8947 and ~83,700 buffer hits. Seven
-- copies because the `rows` CTE was inlined into the aggregate, and `visible`
-- is referenced by seven aggregate expressions, so the expression tree carried
-- seven copies of the EXISTS and evaluated each of them for every row. 586,000
-- buffer hits for a 10,751-row month. The original 0129/0173/0409 body had the
-- same shape, so this was true all along.
--
-- Two changes:
--
--   1. `rows as MATERIALIZED`. One evaluation of `visible` per row.
--      710 ms -> 161 ms on August.
--
--   2. The correlated EXISTS becomes four uncorrelated IN-lists over the
--      month's confirmations. Each is hashed once and probed per row. The four
--      cover the same predicate as the EXISTS's two ORed match rules
--      (client_id match / category match) × two site rules (confirmation
--      site is null / equals the guard's site). 161 ms -> 73 ms.
--
-- NULL is the same as before: a guard with no client gives dp.site_id NULL,
-- the row-constructor IN with a NULL member yields NULL, and NULL in a CASE or
-- FILTER predicate counts as not-visible exactly as the EXISTS's
-- `c.site_id = NULL` did. The equivalence assertion is the proof, not this
-- paragraph.
--
-- ===========================================================================
-- THE CONTROL — the same as 0442
-- ===========================================================================
--
-- Digest guard on the live (0442) body; replacement created as a temp
-- function with the SAME attributes as the real one (definer, search_path) so
-- it cannot be inlined; both-direction EXCEPT on every month with data;
-- refused on any difference or on zero months compared.

-- ---------------------------------------------------------------------------
-- 1. Digest guard on the live body (as left by 0442).
-- ---------------------------------------------------------------------------
do $$
declare v_md5 text;
begin
  select md5(pg_get_functiondef(p.oid)) into v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'attendance_payroll';
  if v_md5 is null then
    raise exception '0443 REFUSED: public.attendance_payroll does not exist.';
  end if;
  if v_md5 <> 'e555b7bebf71792f575afbdef98bd14b' then
    raise exception '0443 REFUSED: attendance_payroll body digest is %, expected e555b7bebf71792f575afbdef98bd14b (the 0442 body). Read pg_get_functiondef and redo the rewrite against that.', v_md5;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The replacement, as a temp function with the real attributes.
-- ---------------------------------------------------------------------------
create function pg_temp.attendance_payroll_0443(p_start date, p_end date)
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
  -- The month's confirmations, once. Each IN below is uncorrelated, so the
  -- planner hashes it a single time instead of probing per attendance row.
  conf as (
    select c.attendance_date, c.client_id, c.category, c.site_id
      from public.attendance_confirmations c
     where c.attendance_date between p_start and p_end
  ),
  -- MATERIALIZED is load-bearing: `visible` is referenced by seven aggregate
  -- expressions below, and an inlined CTE evaluates it seven times per row.
  rows as materialized (
    select ar.employee_id, ar.attendance_date, lower(ar.status) as st,
      coalesce(s.base_salary, e.base_salary, 0) as rate,
      extract(day from (date_trunc('month', ar.attendance_date) + interval '1 month - 1 day'))::int as dim,
      (
        ar.supervisor_override = true
        or (e.client_id is not null and (ar.attendance_date, e.client_id) in (select attendance_date, client_id from conf where site_id is null))
        or (e.client_id is not null and (ar.attendance_date, e.client_id, dp.site_id) in (select attendance_date, client_id, site_id from conf where site_id is not null))
        or (e.client_id is null and e.category is not null and (ar.attendance_date, e.category::text) in (select attendance_date, category from conf where site_id is null))
        or (e.client_id is null and e.category is not null and (ar.attendance_date, e.category::text, dp.site_id) in (select attendance_date, category, site_id from conf where site_id is not null))
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
       except select * from pg_temp.attendance_payroll_0443(v_s, v_e))
      union all
      (select * from pg_temp.attendance_payroll_0443(v_s, v_e)
       except select * from public.attendance_payroll(v_s, v_e))
    ) x;
    if v_diff <> 0 then
      raise exception '0443 REFUSED: attendance_payroll rewrite differs from the live function for % by % row(s).', v_s, v_diff;
    end if;
    v_months := v_months + 1;
  end loop;
  if v_months = 0 then
    raise exception '0443 REFUSED: no months compared; attendance_records is empty, so equivalence was not tested.';
  end if;
  raise notice '0443: attendance_payroll equivalent on % month(s)', v_months;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Replace the live function with the proven body.
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
  -- The month's confirmations, once. Each IN below is uncorrelated, so the
  -- planner hashes it a single time instead of probing per attendance row.
  conf as (
    select c.attendance_date, c.client_id, c.category, c.site_id
      from public.attendance_confirmations c
     where c.attendance_date between p_start and p_end
  ),
  -- MATERIALIZED is load-bearing: `visible` is referenced by seven aggregate
  -- expressions below, and an inlined CTE evaluates it seven times per row.
  rows as materialized (
    select ar.employee_id, ar.attendance_date, lower(ar.status) as st,
      coalesce(s.base_salary, e.base_salary, 0) as rate,
      extract(day from (date_trunc('month', ar.attendance_date) + interval '1 month - 1 day'))::int as dim,
      (
        ar.supervisor_override = true
        or (e.client_id is not null and (ar.attendance_date, e.client_id) in (select attendance_date, client_id from conf where site_id is null))
        or (e.client_id is not null and (ar.attendance_date, e.client_id, dp.site_id) in (select attendance_date, client_id, site_id from conf where site_id is not null))
        or (e.client_id is null and e.category is not null and (ar.attendance_date, e.category::text) in (select attendance_date, category from conf where site_id is null))
        or (e.client_id is null and e.category is not null and (ar.attendance_date, e.category::text, dp.site_id) in (select attendance_date, category, site_id from conf where site_id is not null))
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
  'Per-employee payroll figures from attendance for a date range. 0442: rates and sites joined from pre-computed sets. 0443: rows CTE MATERIALIZED so visible is evaluated once per row (it was seven times), and the confirmations check is four hashed IN-sets over the month''s confirmations. Proven equivalent on every month of data before each replacement. Visibility rule (0409) and double-duty arithmetic (0173) unchanged.';

-- Installed body equals tested body over the full range.
do $$
declare v_diff int; v_s date; v_e date;
begin
  select min(attendance_date), max(attendance_date) into v_s, v_e from public.attendance_records;
  select count(*) into v_diff from (
    (select * from public.attendance_payroll(v_s, v_e) except select * from pg_temp.attendance_payroll_0443(v_s, v_e))
    union all
    (select * from pg_temp.attendance_payroll_0443(v_s, v_e) except select * from public.attendance_payroll(v_s, v_e))
  ) x;
  if v_diff <> 0 then
    raise exception '0443 REFUSED: the installed body differs from the tested body by % row(s) over the full range.', v_diff;
  end if;
end $$;

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
      '0443 REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see.',
      v_n, v_who;
  end if;
end $$;
