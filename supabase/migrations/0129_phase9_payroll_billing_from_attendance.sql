-- 0129: Phase 9 — payroll + billing from verified attendance (§10).
--
-- Additive. New read functions/views; nothing dropped. Existing payroll pipeline
-- (payslips, tax/EOBI/advance/allowance logic) is preserved — only the EARNINGS
-- source is switched to attendance × salary-history rate.
--
-- ASSUMPTIONS (spec-silent, noted): a present-equivalent attendance ROW =
-- present | double_duty | relief_cover; each is paid one shift at rate ÷
-- days_in_month, so a double-duty day (two rows) pays two shifts (the extra-shift
-- pay of §10.1). Blocked/absent/leave rows are not worked shifts. Rate per date =
-- the guard_salary_history (employee_salary_history) row effective on that date
-- (mid-month changes handled), falling back to employees.base_salary.

-- ---------------------------------------------------------------------------
-- 1. attendance_payroll(start, end) — per-guard earnings from verified attendance.
--    earned = Σ present-equiv rows of rate_effective(date) / days_in_month(date).
--    Partial months for joiners/leavers fall out naturally (fewer rows).
-- ---------------------------------------------------------------------------
create or replace function public.attendance_payroll(p_start date, p_end date)
returns table (
  employee_id    uuid,
  worked_shifts  numeric,
  earned         numeric,
  leave_days     integer,
  absent_days    integer,
  rate_effective numeric
)
language sql stable security definer set search_path = public as $$
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
    sum(case when st in ('present','double_duty','relief_cover') then 1 else 0 end)                        as worked_shifts,
    sum(case when st in ('present','double_duty','relief_cover') then rate / nullif(dim,0) else 0 end)     as earned,
    sum(case when st in ('leave','rotation_leave','rest_day') then 1 else 0 end)::int                      as leave_days,
    sum(case when st = 'absent' then 1 else 0 end)::int                                                    as absent_days,
    max(rate)                                                                                              as rate_effective
  from rows
  group by employee_id;
$$;

grant execute on function public.attendance_payroll(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. attendance_billable_quantity(client, start, end) — §10.4 Variable billing.
--    Average guards on ground = Σ present-equiv shifts (for the client) ÷
--    days_in_month. This is the attendance-driven invoice quantity.
-- ---------------------------------------------------------------------------
create or replace function public.attendance_billable_quantity(p_client uuid, p_start date, p_end date)
returns numeric
language sql stable security definer set search_path = public as $$
  select round(
    coalesce(sum(case when lower(ar.status) in ('present','double_duty','relief_cover') then 1 else 0 end), 0)::numeric
    / nullif(extract(day from (date_trunc('month', p_start) + interval '1 month - 1 day'))::int, 0)
  , 2)
  from public.attendance_records ar
  where ar.attendance_date between p_start and p_end
    and ar.worked_for_client_id = p_client;
$$;

grant execute on function public.attendance_billable_quantity(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. v_client_billing_reconciliation — §10.6 contracted vs deployed vs billed.
--    security_invoker so tenant RLS applies.
-- ---------------------------------------------------------------------------
create or replace view public.v_client_billing_reconciliation
with (security_invoker = true) as
select
  c.company_id,
  c.id   as client_id,
  c.name as client_name,
  coalesce((select sum(cl.billed_qty) from public.contract_lines cl
              join public.sites s on s.id = cl.site_id
             where s.client_id = c.id), 0)                              as contracted,
  (select count(*) from public.deployments d
     where d.client_id = c.id and d.end_date is null)                   as deployed,
  coalesce((select round(
      sum(case when lower(ar.status) in ('present','double_duty','relief_cover') then 1 else 0 end)::numeric
      / nullif(extract(day from (date_trunc('month', current_date) + interval '1 month - 1 day'))::int, 0)
    , 1)
    from public.attendance_records ar
    where ar.worked_for_client_id = c.id
      and ar.attendance_date >= date_trunc('month', current_date)::date), 0) as attendance_on_ground,
  coalesce((select sum(cl.billed_qty) from public.contract_lines cl
              join public.sites s on s.id = cl.site_id
             where s.client_id = c.id), 0)
    - (select count(*) from public.deployments d
         where d.client_id = c.id and d.end_date is null)               as shortfall
from public.clients c;
