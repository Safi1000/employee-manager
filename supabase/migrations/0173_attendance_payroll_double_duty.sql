-- 0173: split double duty out of "present", and honour attendance.backdate.
--
-- 1. attendance_payroll gains present_days and double_duty_shifts.
--
--    worked_shifts counts SHIFTS, so a guard who covered two shifts on one day
--    contributed 2 to it. The payslip then read "26 present" for someone who
--    stood on 24 days — the two extra shifts were real and paid, but calling
--    them "days present" made the figure impossible to reconcile against a
--    31-day month.
--
--    present_days       = distinct dates actually worked
--    double_duty_shifts = worked_shifts - present_days, i.e. the EXTRA shifts
--
--    So 26 worked shifts over 24 dates now reads "24 present + 2 double duty".
--    Pay is unchanged: earned still comes from worked_shifts, because both
--    shifts were worked and both are owed.
--
--    Deliberately derived from the dates rather than from status='double_duty':
--    an extra shift is sometimes stored as a second 'Present' row on the same
--    date, and counting the status alone would miss those. 7 employee-months in
--    this database already have a second worked row on a date.
drop function if exists public.attendance_payroll(date, date);
create function public.attendance_payroll(p_start date, p_end date)
returns table(
  employee_id uuid,
  worked_shifts numeric,
  present_days integer,
  double_duty_shifts integer,
  earned numeric,
  leave_days integer,
  absent_days integer,
  rate_effective numeric
)
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
      extract(day from (date_trunc('month', ar.attendance_date) + interval '1 month - 1 day'))::int as dim
    from public.attendance_records ar
    where ar.attendance_date between p_start and p_end
  )
  select employee_id,
    sum(case when st in ('present','double_duty','relief_cover') then 1 else 0 end)                    as worked_shifts,
    count(distinct attendance_date) filter (where st in ('present','double_duty','relief_cover'))::int as present_days,
    (sum(case when st in ('present','double_duty','relief_cover') then 1 else 0 end)
      - count(distinct attendance_date) filter (where st in ('present','double_duty','relief_cover')))::int
                                                                                                       as double_duty_shifts,
    sum(case when st in ('present','double_duty','relief_cover') then rate / nullif(dim,0) else 0 end) as earned,
    sum(case when st in ('leave','rotation_leave','rest_day') then 1 else 0 end)::int                  as leave_days,
    sum(case when st = 'absent' then 1 else 0 end)::int                                                as absent_days,
    max(rate)                                                                                          as rate_effective
  from rows
  group by employee_id;
$function$;

-- 2. The attendance.backdate permission never did anything.
--
-- It has always been listed in Users & Permissions ("Backdate attendance past
-- the marking cutoff"), but attendance_gate returned 'override_required' for
-- anything older than 3 days no matter who was asking. Someone granted the
-- permission still had to type a supervisor override reason, which is exactly
-- what the permission was supposed to spare them.
--
-- Mirrors hasPermission() in src/app/lib/auth.tsx: both admin roles imply every
-- permission; everyone else needs the key in profiles.permissions.
create or replace function public.has_permission(p_key text)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.role::text in ('super_admin','super_super_admin')
           or p_key = any(coalesce(p.permissions, '{}')))
  );
$function$;

revoke execute on function public.has_permission(text) from public, anon;

create or replace function public.attendance_gate(p_guard uuid, p_date date, p_backdate_limit integer default 3)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  e public.employees%rowtype;
  v_reason text;
  v_has_posting boolean;
begin
  select * into e from public.employees where id = p_guard;
  if e.id is null then return jsonb_build_object('mode','blocked','reason','Guard not found'); end if;

  v_reason := public.attendance_window_block_reason(p_guard, p_date);
  if v_reason is not null then
    return jsonb_build_object('mode','blocked','reason',v_reason);
  end if;

  if exists (select 1 from public.accounting_periods ap
             where ap.company_id = e.company_id and ap.period_month = date_trunc('month', p_date)::date) then
    return jsonb_build_object('mode','blocked','reason','Payroll closed for ' || to_char(p_date,'Mon YYYY') || '. Post a reversal instead.');
  end if;

  -- THE CHANGE. A closed payroll period still blocks everyone above; this only
  -- waives the soft 3-day cutoff, and only for someone holding the permission.
  if p_date < current_date - p_backdate_limit
     and not public.has_permission('attendance.backdate') then
    return jsonb_build_object('mode','override_required','reason','Backdated beyond ' || p_backdate_limit || ' days - supervisor override required');
  end if;

  select exists (select 1 from public.deployments d
    where d.guard_id = p_guard and d.start_date <= p_date
      and (d.end_date is null or d.end_date >= p_date)) into v_has_posting;

  if v_has_posting then
    return jsonb_build_object('mode','allowed','reason',null);
  else
    return jsonb_build_object('mode','allowed_unposted','reason','No active posting - recorded against pool (not billable)');
  end if;
end $function$;
