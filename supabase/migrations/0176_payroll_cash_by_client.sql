-- 0176: payroll attributed to clients on a CASH basis.
--
-- payroll_cost_by_client (0155) answers "what did this client's labour COST in
-- month M", keyed on payslips.period_month. That is the accrual question, and
-- it is the right one for the P&L and for the revenue-basis Client Statement.
--
-- The Cash Flow page asks a different question: "what money actually LEFT in
-- month M". A July payslip disbursed on 5 August is July's cost and August's
-- cash. A payslip sitting undisbursed is neither. A cheque that has not cleared
-- is not cash at all.
--
-- This function is the cash twin. Same days-worked splitting — a guard who
-- transferred mid-month still lands partly on each client he actually stood
-- for, using the attendance of the payslip's OWN period_month — but the rows
-- are selected by cash date and valued at net_salary, so the totals reconcile
-- against the Cash Flow tab beside it rather than against the P&L.
create or replace function public.payroll_cash_by_client(p_start date, p_end date)
returns table(client_id uuid, cost numeric)
language sql
stable security definer
set search_path to 'public'
as $function$
  with paid as (
    -- Cash date, by exactly the rules the Cash Flow page uses:
    --   Cheque  → the day the cheque CLEARED; null (and so excluded) until it
    --             does, because an uncleared cheque has moved no money.
    --   otherwise → the day it was disbursed, falling back to the period month
    --             for older rows that predate disbursed_at being stamped.
    select p.employee_id,
           p.period_month,
           p.net_salary::numeric as salary,
           e.client_id           as fallback_client,
           case
             when p.payment_mode = 'Cheque'
               then case when c.status = 'cleared' then c.cleared_at::date end
             else coalesce(p.disbursed_at::date, p.period_month)
           end as cash_date
      from public.payslips p
      join public.employees e on e.id = p.employee_id
      left join public.cheques c on c.id = p.cheque_id
     where p.disbursed
  ),
  ps as (
    -- fallback_client is grouped rather than aggregated: it comes off the
    -- employee row, so it is constant within an employee and there is no
    -- min(uuid) to reach for.
    select employee_id,
           period_month,
           fallback_client,
           sum(salary) as salary
      from paid
     -- A null cash_date fails BETWEEN, which is how uncleared cheques drop out.
     where cash_date between p_start and p_end
     group by 1, 2, 3
  ),
  -- Split across the clients the guard actually worked for THAT PERIOD, not the
  -- month the cash moved: an August payment for July must follow July's days.
  days as (
    select a.employee_id,
           ps.period_month,
           coalesce(a.worked_for_client_id, ps.fallback_client) as cid,
           count(*)::numeric as d
      from public.attendance_records a
      join ps on ps.employee_id = a.employee_id
     where a.attendance_date >= ps.period_month
       and a.attendance_date < (ps.period_month + interval '1 month')
       and lower(a.status) in ('present', 'double_duty', 'relief_cover')
     group by 1, 2, 3
  ),
  totals as (
    select employee_id, period_month, sum(d) as total_d from days group by 1, 2
  ),
  split as (
    select days.cid as client_id,
           ps.salary * days.d / nullif(totals.total_d, 0) as cost
      from days
      join totals on totals.employee_id = days.employee_id
                 and totals.period_month = days.period_month
      join ps     on ps.employee_id     = days.employee_id
                 and ps.period_month    = days.period_month
    union all
    -- Paid but no attendance that period (office staff, back-pay): the whole
    -- amount falls to whoever they are posted to now.
    select ps.fallback_client, ps.salary
      from ps
     where not exists (
       select 1 from totals t
        where t.employee_id = ps.employee_id
          and t.period_month = ps.period_month
          and t.total_d > 0
     )
  )
  select client_id, round(sum(cost), 2) as cost
    from split
   where client_id is not null
   group by client_id;
$function$;

revoke execute on function public.payroll_cash_by_client(date, date) from public, anon;
grant execute on function public.payroll_cash_by_client(date, date) to authenticated;
