-- 0217 — client_statement_loaded() must attribute invoiced revenue to the month
-- the invoice BILLS FOR (period_start), not the day it was generated
-- (invoice_date). Every invoice generated today (invoice_date = today) was
-- landing in the current month, so June/July read zero revenue and the whole
-- back-catalogue piled into the generation month. This matches the frontend's
-- invoicePeriodFilter (period_start, falling back to invoice_date when null).
-- Only the `iv` CTE's date filter changes.
create or replace function public.client_statement_loaded(p_start date, p_end date, p_basis text default 'revenue')
 returns table(client_id uuid, client_name text, client_code text, branch_id uuid, region_name text, revenue numeric, direct_payroll numeric, direct_expenses numeric, regional_overhead numeric, ho_share numeric, net numeric)
 language sql stable security definer set search_path to 'public'
as $function$
  with cid as (select public.current_company_id() as company_id),
  cash as (select lower(p_basis) = 'cash' as on_cash),
  cl as (
    select c.id, c.name::text as name, c.client_code::text as code, c.branch_id
      from public.clients c cross join cid
     where c.company_id = cid.company_id
  ),
  ip as (
    select coalesce(p.client_id, i.client_id) as client_id, sum(p.amount)::numeric as amt
      from public.invoice_payments p
      left join public.invoices i on i.id = p.invoice_id
     cross join cid
     where p.company_id = cid.company_id and p.payment_date between p_start and p_end
       and coalesce(p.client_id, i.client_id) is not null
     group by 1
  ),
  iv as (
    select i.client_id, sum(i.invoice_amount)::numeric as amt
      from public.invoices i cross join cid
     where i.company_id = cid.company_id
       and coalesce(i.period_start, i.invoice_date) between p_start and p_end
       and i.client_id is not null
     group by 1
  ),
  rev as (
    select cl.id as client_id,
           case when cash.on_cash then coalesce(ip.amt, 0) else coalesce(iv.amt, 0) end as amt
      from cl
      cross join cash
      left join ip on ip.client_id = cl.id
      left join iv on iv.client_id = cl.id
  ),
  paid as (
    select ps.employee_id, ps.period_month,
           case when cash.on_cash then ps.net_salary else ps.final_salary end::numeric as salary,
           e.client_id as fallback_client, e.branch_id as emp_branch,
           case when cash.on_cash then
                  case when ps.payment_mode = 'Cheque'
                       then case when ch.status = 'cleared' then ch.cleared_at::date end
                       else coalesce(ps.disbursed_at::date, ps.period_month) end
                else ps.period_month end as eff_date,
           case when cash.on_cash then ps.disbursed else true end as counts
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
      left join public.cheques ch on ch.id = ps.cheque_id
      cross join cid
      cross join cash
     where e.company_id = cid.company_id
  ),
  ps as (
    select employee_id, period_month, fallback_client, emp_branch, sum(salary) as salary
      from paid where counts and eff_date between p_start and p_end group by 1,2,3,4
  ),
  days as (
    select a.employee_id, ps.period_month,
           coalesce(a.worked_for_client_id, ps.fallback_client) as cid2,
           count(*)::numeric as d
      from public.attendance_records a join ps on ps.employee_id = a.employee_id
     where a.attendance_date >= ps.period_month
       and a.attendance_date < (ps.period_month + interval '1 month')
       and lower(a.status) in ('present','double_duty','relief_cover')
     group by 1,2,3
  ),
  totals as (select employee_id, period_month, sum(d) as total_d from days group by 1,2),
  pay_split as (
    select days.cid2 as client_id, ps.emp_branch,
           ps.salary * days.d / nullif(totals.total_d, 0) as cost
      from days
      join totals on totals.employee_id = days.employee_id and totals.period_month = days.period_month
      join ps on ps.employee_id = days.employee_id and ps.period_month = days.period_month
    union all
    select ps.fallback_client, ps.emp_branch, ps.salary from ps
     where not exists (select 1 from totals t
        where t.employee_id = ps.employee_id and t.period_month = ps.period_month and t.total_d > 0)
  ),
  pay_client as (select client_id, sum(cost) as amt from pay_split where client_id is not null group by 1),
  pay_overhead as (select emp_branch as b, sum(cost) as amt from pay_split where client_id is null group by 1),
  exp_rows as (
    select x.client_id, x.branch_id, x.amount::numeric as amount,
           case when cash.on_cash then
                  case when x.payment_mode in ('Cash','Bank') then x.expense_date
                       when x.payment_mode = 'Cheque'
                         then case when ch.status = 'cleared' then ch.cleared_at::date end
                       when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end
                else x.expense_date end as eff_date
      from public.expenses x
      left join public.cheques ch on ch.id = x.cheque_id
      cross join cid
      cross join cash
     where x.company_id = cid.company_id
  ),
  exp_client as (
    select client_id, sum(amount) as amt from exp_rows
     where client_id is not null and eff_date between p_start and p_end group by 1
  ),
  exp_overhead as (
    select branch_id as b, sum(amount) as amt from exp_rows
     where client_id is null and eff_date between p_start and p_end group by 1
  ),
  overhead as (
    select b, sum(amt) as amt from (
      select b, amt from pay_overhead union all select b, amt from exp_overhead
    ) u group by 1
  ),
  ho as (
    select coalesce(sum(o.amt), 0) as pool from overhead o
      join public.branches br on br.id = o.b where br.is_head_office
  ),
  region_overhead as (
    select o.b, o.amt from overhead o left join public.branches br on br.id = o.b
     where coalesce(br.is_head_office, false) = false
  ),
  rev_total as (select coalesce(sum(amt), 0) as amt from rev),
  rev_region as (
    select cl.branch_id as b, coalesce(sum(rev.amt), 0) as amt, count(*) as n_clients
      from cl join rev on rev.client_id = cl.id group by cl.branch_id
  )
  select cl.id, cl.name, cl.code, cl.branch_id,
    coalesce(br.name, 'Unassigned')::text,
    round(coalesce(rev.amt, 0), 2),
    round(coalesce(pay_client.amt, 0), 2),
    round(coalesce(exp_client.amt, 0), 2),
    round(coalesce(ro.amt, 0) * case
        when coalesce(rr.amt, 0) > 0 then coalesce(rev.amt, 0) / rr.amt
        when coalesce(rr.n_clients, 0) > 0 then 1.0 / rr.n_clients else 0 end, 2),
    round(ho.pool * case when rt.amt > 0 then coalesce(rev.amt, 0) / rt.amt else 0 end, 2),
    round(coalesce(rev.amt, 0) - coalesce(pay_client.amt, 0) - coalesce(exp_client.amt, 0)
      - coalesce(ro.amt, 0) * case
          when coalesce(rr.amt, 0) > 0 then coalesce(rev.amt, 0) / rr.amt
          when coalesce(rr.n_clients, 0) > 0 then 1.0 / rr.n_clients else 0 end
      - ho.pool * case when rt.amt > 0 then coalesce(rev.amt, 0) / rt.amt else 0 end, 2)
  from cl
  cross join ho
  cross join rev_total rt
  left join public.branches br on br.id = cl.branch_id
  left join rev on rev.client_id = cl.id
  left join pay_client on pay_client.client_id = cl.id
  left join exp_client on exp_client.client_id = cl.id
  left join region_overhead ro on ro.b is not distinct from cl.branch_id
  left join rev_region rr on rr.b is not distinct from cl.branch_id
  order by cl.name;
$function$;
