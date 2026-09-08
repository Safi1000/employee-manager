-- 0409 — payroll counts only CONFIRMED attendance, matching the Monthly Board.
--
-- The board shows only supervisor-confirmed marks (attendanceSheet.ts drops the
-- rest), so its last four columns — Present / Absent / Leave / Double Duty — are
-- the confirmed truth. attendance_payroll counted EVERY attendance_records row in
-- range, so an unconfirmed second shift became a paid double duty the board never
-- shows: Ali Hamza's Aug 1-4 each had a confirmed night double_duty plus an
-- UNCONFIRMED day double_duty, so the board read 31 P / 0 DD while payroll read
-- 31 present / 4 DD and billed the four.
--
-- Fix: apply the board's confirmation gate. A row is visible iff supervisor_override
-- is set (the one edit allowed once locked) OR a confirmation exists for its
-- (date, shift) at the guard's client/category and either client-wide (site_id
-- null) or the guard's site. "The guard's site" mirrors loadSiteByGuard: the site
-- of their latest posting for that client (an open posting first). The gate is
-- applied PER ROW inside the aggregates — not as a WHERE — so a guard with
-- attendance but nothing confirmed still returns a row of zeros (the caller then
-- never falls back to the raw legacy aggregate and re-introduces the gap).
--
-- Double duty stays "worked shifts − distinct worked days": a lone confirmed
-- double_duty row is one shift on one day → 0, exactly as the board folds a lone
-- DD down to a plain present; a genuinely two-shift day → 1.
--
-- ponytail: the confirmation EXISTS and the site sub-select run per attendance
-- row. Payroll is a batch screen, not a hot path; if it ever drags, pre-resolve
-- site-per-guard into a CTE.
create or replace function public.attendance_payroll(p_start date, p_end date)
 returns table(employee_id uuid, worked_shifts numeric, present_days integer, double_duty_shifts integer, earned numeric, leave_days integer, absent_days integer, rate_effective numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with rows as (
    select ar.employee_id, ar.attendance_date, lower(ar.status) as st,
      coalesce(
        (select sh.base_salary from public.employee_salary_history sh
           where sh.employee_id = ar.employee_id and sh.effective_date <= ar.attendance_date
           order by sh.effective_date desc limit 1),
        (select e.base_salary from public.employees e where e.id = ar.employee_id),
        0
      ) as rate,
      extract(day from (date_trunc('month', ar.attendance_date) + interval '1 month - 1 day'))::int as dim,
      (
        ar.supervisor_override = true
        or exists (
          select 1
          from public.attendance_confirmations c
          where c.attendance_date = ar.attendance_date
            and c.shift_code = coalesce(ar.worked_shift, 'day')
            and (
              (e.client_id is not null and c.client_id = e.client_id)
              or (e.client_id is null and e.category is not null and c.category = e.category::text)
            )
            and (
              c.site_id is null
              or c.site_id = (
                select d.site_id
                  from public.deployments d
                 where d.guard_id = ar.employee_id
                   and d.client_id = e.client_id
                 order by (d.end_date is null) desc, d.end_date desc nulls last
                 limit 1
              )
            )
        )
      ) as visible
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
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

-- attendance_payroll takes no tenant uuid parameter, so it adds no gap; assert the
-- detector still reads clean, as every migration must.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
