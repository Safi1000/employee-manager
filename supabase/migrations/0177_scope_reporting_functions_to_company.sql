-- 0177: keep the SECURITY DEFINER reporting functions inside one company.
--
-- These three run as SECURITY DEFINER, which is what lets them read across
-- payslips + attendance + employees without every caller needing rights to all
-- three. But SECURITY DEFINER also bypasses RLS, and none of them filtered by
-- company — so the row set they built spanned every tenant in the database.
--
-- The UI never showed it: Financial Reports maps over `clients`, which IS
-- RLS-filtered, and simply looks up each client's figure. Anything belonging to
-- another company fell out because nothing looked it up. That is a lucky
-- accident of how the caller happens to be written, not a control. Calling
-- /rest/v1/rpc/payroll_cost_by_client directly returned another company's
-- payroll totals keyed by client_id.
--
-- The scope added here is exactly what the UI already displays, so no visible
-- figure changes. current_company_id() honours view_as_company, so a super
-- super admin inspecting a tenant still gets that tenant's numbers.

-- ---------------------------------------------------------------------------
-- 1. Accrual payroll split (pre-existing, from 0155)
-- ---------------------------------------------------------------------------
create or replace function public.payroll_cost_by_client(p_period_month date)
returns table(client_id uuid, cost numeric)
language sql
stable security definer
set search_path to 'public'
as $function$
  with ps as (
    select p.employee_id,
           sum(p.final_salary)::numeric as salary,
           e.client_id                  as fallback_client
      from public.payslips p
      join public.employees e on e.id = p.employee_id
     where p.period_month = p_period_month
       and e.company_id = public.current_company_id()
     group by p.employee_id, e.client_id
  ),
  days as (
    select a.employee_id,
           coalesce(a.worked_for_client_id, ps.fallback_client) as cid,
           count(*)::numeric as d
      from public.attendance_records a
      join ps on ps.employee_id = a.employee_id
     where a.attendance_date >= p_period_month
       and a.attendance_date < (p_period_month + interval '1 month')
       and lower(a.status) in ('present', 'double_duty', 'relief_cover')
     group by 1, 2
  ),
  totals as (
    select employee_id, sum(d) as total_d from days group by 1
  ),
  split as (
    select days.cid as client_id,
           ps.salary * days.d / nullif(totals.total_d, 0) as cost
      from days
      join totals on totals.employee_id = days.employee_id
      join ps     on ps.employee_id     = days.employee_id
    union all
    select ps.fallback_client, ps.salary
      from ps
     where not exists (
       select 1 from totals t
        where t.employee_id = ps.employee_id and t.total_d > 0
     )
  )
  select client_id, round(sum(cost), 2) as cost
    from split
   where client_id is not null
   group by client_id;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Cash payroll split (0176)
-- ---------------------------------------------------------------------------
create or replace function public.payroll_cash_by_client(p_start date, p_end date)
returns table(client_id uuid, cost numeric)
language sql
stable security definer
set search_path to 'public'
as $function$
  with paid as (
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
       and e.company_id = public.current_company_id()
  ),
  ps as (
    select employee_id,
           period_month,
           fallback_client,
           sum(salary) as salary
      from paid
     where cash_date between p_start and p_end
     group by 1, 2, 3
  ),
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

-- ---------------------------------------------------------------------------
-- 3. Fixed-expense generation (0174)
-- ---------------------------------------------------------------------------
-- Two callers with genuinely different scopes:
--   the app        — a signed-in user, who may raise only their OWN company's
--                    entries. Without this, opening the Expenses page raised
--                    rows in every tenant in the database.
--   pg_cron        — runs with no auth.uid(), and must cover every company.
-- current_company_id() returns null in the cron case, which is what the
-- `v_company is null` branch keys off.
create or replace function public.generate_fixed_expense_instances(p_month date default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_month   date := date_trunc('month', coalesce(p_month, current_date))::date;
  v_company uuid := public.current_company_id();
  v_count   integer;
begin
  insert into public.fixed_expense_instances (
    company_id, fixed_expense_id, period_month,
    category_id, pl_category, client_id, branch_id, vendor_id,
    description, amount, payment_mode, bank_account_id, due_date, notes, status
  )
  select
    f.company_id, f.id, v_month,
    f.category_id, f.pl_category, f.client_id, f.branch_id, f.vendor_id,
    f.description, f.amount, f.payment_mode, f.bank_account_id,
    case when f.payment_mode = 'Payable'
         then (v_month + ((coalesce(f.due_day, 1) - 1) || ' days')::interval)::date
         else null end,
    f.notes, 'pending'
  from public.fixed_expenses f
  where f.is_active
    and f.start_month <= v_month
    and (f.end_month is null or f.end_month >= v_month)
    and (v_company is null or f.company_id = v_company)
  on conflict (fixed_expense_id, period_month) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end $function$;

revoke execute on function public.generate_fixed_expense_instances(date) from public, anon;
grant execute on function public.generate_fixed_expense_instances(date) to authenticated;
