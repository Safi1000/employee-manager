-- 0178: per-region profit (both bases) and the general-expense breakdown.
--
-- The Regional Scorecard already showed operating health per region — headcount,
-- incidents, no-shows, receivables. What it could not answer is the question
-- anyone actually asks of a region: did it make money, and where did the
-- overhead go. These two functions supply that.
--
-- Region attribution, applied consistently by both:
--   invoices / payments  → their own branch_id, else the CLIENT's region
--   payslips             → the EMPLOYEE's region
--   expenses             → their own branch_id, else the client's region
-- Anything still unattributed collects under a single null-branch bucket rather
-- than being dropped, so the region rows always add up to the company total.
--
-- Both are SECURITY DEFINER (they read payslips + invoices + expenses together)
-- and both are scoped to current_company_id(), per 0177.

-- ---------------------------------------------------------------------------
-- 1. Regional P&L — accrual and cash side by side
-- ---------------------------------------------------------------------------
-- Returned together on purpose. The two bases answer different questions of the
-- same month and the interesting number is usually the GAP between them: a
-- region billing well but collecting badly shows a healthy accrual profit and a
-- negative cash one. Splitting this into two functions would have made that
-- comparison a client-side join for no gain.
create or replace function public.regional_pl(p_month date)
returns table(
  branch_id         uuid,
  region_name       text,
  revenue_accrual   numeric,
  payroll_accrual   numeric,
  expenses_accrual  numeric,
  profit_accrual    numeric,
  revenue_cash      numeric,
  payroll_cash      numeric,
  expenses_cash     numeric,
  profit_cash       numeric
)
language sql
stable security definer
set search_path to 'public'
as $function$
  with cid as (select public.current_company_id() as company_id),
  m as (
    select date_trunc('month', p_month)::date as start_d,
           (date_trunc('month', p_month) + interval '1 month - 1 day')::date as end_d
  ),
  -- Revenue, accrual: invoices raised in the month.
  inv as (
    select coalesce(i.branch_id, c.branch_id) as b, sum(i.invoice_amount)::numeric as amt
      from public.invoices i
      left join public.clients c on c.id = i.client_id
     cross join m, cid
     where i.company_id = cid.company_id
       and i.invoice_date between m.start_d and m.end_d
     group by 1
  ),
  -- Revenue, cash: payments actually received in the month.
  rcp as (
    select coalesce(p.branch_id, c.branch_id) as b, sum(p.amount)::numeric as amt
      from public.invoice_payments p
      left join public.clients c on c.id = p.client_id
     cross join m, cid
     where p.company_id = cid.company_id
       and p.payment_date between m.start_d and m.end_d
     group by 1
  ),
  -- Payroll, accrual: everything earned for the period, disbursed or not.
  pay_a as (
    select e.branch_id as b, sum(ps.final_salary)::numeric as amt
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
     cross join m, cid
     where e.company_id = cid.company_id
       and ps.period_month = m.start_d
     group by 1
  ),
  -- Payroll, cash: same rules as payroll_cash_by_client — a cheque counts the
  -- day it clears, and an uncleared one counts not at all.
  pay_c as (
    select e.branch_id as b, sum(ps.net_salary)::numeric as amt
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
      left join public.cheques ch on ch.id = ps.cheque_id
     cross join m, cid
     where e.company_id = cid.company_id
       and ps.disbursed
       and (case
              when ps.payment_mode = 'Cheque'
                then case when ch.status = 'cleared' then ch.cleared_at::date end
              else coalesce(ps.disbursed_at::date, ps.period_month)
            end) between m.start_d and m.end_d
     group by 1
  ),
  -- Expenses, accrual: incurred in the month, however it is being settled.
  exp_a as (
    select coalesce(x.branch_id, c.branch_id) as b, sum(x.amount)::numeric as amt
      from public.expenses x
      left join public.clients c on c.id = x.client_id
     cross join m, cid
     where x.company_id = cid.company_id
       and x.expense_date between m.start_d and m.end_d
     group by 1
  ),
  -- Expenses, cash: the Cash Flow page's rules exactly.
  exp_c as (
    select coalesce(x.branch_id, c.branch_id) as b, sum(x.amount)::numeric as amt
      from public.expenses x
      left join public.clients c on c.id = x.client_id
      left join public.cheques ch on ch.id = x.cheque_id
     cross join m, cid
     where x.company_id = cid.company_id
       and (case
              when x.payment_mode in ('Cash','Bank') then x.expense_date
              when x.payment_mode = 'Cheque'
                then case when ch.status = 'cleared' then ch.cleared_at::date end
              when x.payment_mode = 'Payable' and x.payable_status = 'Paid'
                then x.paid_at::date
            end) between m.start_d and m.end_d
     group by 1
  ),
  -- Every region, plus the null bucket if anything landed unattributed.
  regions as (
    select b.id, b.name::text from public.branches b cross join cid where b.company_id = cid.company_id
    union
    select null::uuid, 'Unassigned'::text
     where exists (select 1 from inv   where b is null)
        or exists (select 1 from rcp   where b is null)
        or exists (select 1 from pay_a where b is null)
        or exists (select 1 from pay_c where b is null)
        or exists (select 1 from exp_a where b is null)
        or exists (select 1 from exp_c where b is null)
  )
  select
    r.id,
    r.name,
    coalesce(inv.amt, 0),
    coalesce(pay_a.amt, 0),
    coalesce(exp_a.amt, 0),
    coalesce(inv.amt, 0) - coalesce(pay_a.amt, 0) - coalesce(exp_a.amt, 0),
    coalesce(rcp.amt, 0),
    coalesce(pay_c.amt, 0),
    coalesce(exp_c.amt, 0),
    coalesce(rcp.amt, 0) - coalesce(pay_c.amt, 0) - coalesce(exp_c.amt, 0)
  from regions r
  left join inv   on inv.b   is not distinct from r.id
  left join rcp   on rcp.b   is not distinct from r.id
  left join pay_a on pay_a.b is not distinct from r.id
  left join pay_c on pay_c.b is not distinct from r.id
  left join exp_a on exp_a.b is not distinct from r.id
  left join exp_c on exp_c.b is not distinct from r.id
  order by r.name;
$function$;

revoke execute on function public.regional_pl(date) from public, anon;
grant execute on function public.regional_pl(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. General (overhead) expenses, by category and region
-- ---------------------------------------------------------------------------
-- "General expenses" means the running cost of the business rather than the
-- cost of delivering a client's guards: office rent, utilities, stationery,
-- travel, and the office salaries that keep the place open.
--
-- Two sources, because they live in two places:
--   expenses with pl_category = 'operating_expense' — rent, utilities, travel,
--     misc. Cost-of-services rows are excluded: those are a client's guards.
--   office-staff payroll — the "staff salaries" line. It is in `payslips`, not
--     `expenses`, so it would be invisible here without being added explicitly.
--     Flagged with is_payroll so the UI can label it as the derived line it is.
create or replace function public.regional_general_expenses(p_month date)
returns table(
  branch_id   uuid,
  region_name text,
  category    text,
  amount      numeric,
  is_payroll  boolean
)
language sql
stable security definer
set search_path to 'public'
as $function$
  with cid as (select public.current_company_id() as company_id),
  m as (
    select date_trunc('month', p_month)::date as start_d,
           (date_trunc('month', p_month) + interval '1 month - 1 day')::date as end_d
  ),
  rows as (
    select coalesce(x.branch_id, c.branch_id) as b,
           coalesce(cat.name, 'Uncategorized')::text as category,
           sum(x.amount)::numeric as amount,
           false as is_payroll
      from public.expenses x
      left join public.clients c on c.id = x.client_id
      left join public.expense_categories cat on cat.id = x.category_id
     cross join m, cid
     where x.company_id = cid.company_id
       and x.pl_category = 'operating_expense'
       and x.expense_date between m.start_d and m.end_d
     group by 1, 2
    union all
    select e.branch_id,
           'Office staff salaries'::text,
           sum(ps.final_salary)::numeric,
           true
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
     cross join m, cid
     where e.company_id = cid.company_id
       and e.category = 'office_staff'
       and ps.period_month = m.start_d
     group by 1
  )
  select rows.b,
         coalesce(br.name, 'Unassigned')::text,
         rows.category,
         rows.amount,
         rows.is_payroll
    from rows
    left join public.branches br on br.id = rows.b
   where rows.amount <> 0
   order by 2, 4 desc, 3;
$function$;

revoke execute on function public.regional_general_expenses(date) from public, anon;
grant execute on function public.regional_general_expenses(date) to authenticated;
