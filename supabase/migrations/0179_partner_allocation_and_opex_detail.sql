-- 0179: two-tier partner allocation, and itemised operating expenses.
--
-- PART A — the partner model actually has two kinds, and until now the report
-- treated them as one.
--
--   Regional partner (partners.scope = 'BRANCH', branch_id set)
--       takes their specified share of THEIR REGION'S profit, and nothing else.
--
--   Equity partner (partners.scope = 'COMPANY')
--       takes their specified share of what is LEFT OVER once every region has
--       paid its regional partners — summed across all regions, head office
--       included.
--
-- The old computation gave every partner `share × whole-company profit`, which
-- double-counted: a regional partner was paid on revenue earned in regions they
-- have no stake in, and an equity partner was paid on profit already promised
-- to a regional partner.
--
-- Head office matters here. It is a region with no regional partners and, being
-- pure overhead, usually a negative profit. Its whole figure therefore lands in
-- the residual pool — which is the correct business meaning: equity partners
-- carry head-office overhead, regional partners do not.
--
-- PART B — regional_pl generalised to a date range, so an allocation can be run
-- cumulatively (for opening balances) in one call instead of month by month.
-- Profit over a range is the sum of its months and the shares are constant, so
-- a range allocation equals the sum of the monthly ones exactly.

-- ---------------------------------------------------------------------------
-- 1. Regional P&L over an arbitrary range
-- ---------------------------------------------------------------------------
create or replace function public.regional_pl_range(p_start date, p_end date)
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
  inv as (
    select coalesce(i.branch_id, c.branch_id) as b, sum(i.invoice_amount)::numeric as amt
      from public.invoices i
      left join public.clients c on c.id = i.client_id
     cross join cid
     where i.company_id = cid.company_id
       and i.invoice_date between p_start and p_end
     group by 1
  ),
  rcp as (
    select coalesce(p.branch_id, c.branch_id) as b, sum(p.amount)::numeric as amt
      from public.invoice_payments p
      left join public.clients c on c.id = p.client_id
     cross join cid
     where p.company_id = cid.company_id
       and p.payment_date between p_start and p_end
     group by 1
  ),
  -- Accrual payroll follows the PERIOD the payslip is for, so the range is
  -- matched against period_month rather than any payment date.
  pay_a as (
    select e.branch_id as b, sum(ps.final_salary)::numeric as amt
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
     cross join cid
     where e.company_id = cid.company_id
       and ps.period_month between date_trunc('month', p_start)::date and p_end
     group by 1
  ),
  pay_c as (
    select e.branch_id as b, sum(ps.net_salary)::numeric as amt
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
      left join public.cheques ch on ch.id = ps.cheque_id
     cross join cid
     where e.company_id = cid.company_id
       and ps.disbursed
       and (case
              when ps.payment_mode = 'Cheque'
                then case when ch.status = 'cleared' then ch.cleared_at::date end
              else coalesce(ps.disbursed_at::date, ps.period_month)
            end) between p_start and p_end
     group by 1
  ),
  exp_a as (
    select coalesce(x.branch_id, c.branch_id) as b, sum(x.amount)::numeric as amt
      from public.expenses x
      left join public.clients c on c.id = x.client_id
     cross join cid
     where x.company_id = cid.company_id
       and x.expense_date between p_start and p_end
     group by 1
  ),
  exp_c as (
    select coalesce(x.branch_id, c.branch_id) as b, sum(x.amount)::numeric as amt
      from public.expenses x
      left join public.clients c on c.id = x.client_id
      left join public.cheques ch on ch.id = x.cheque_id
     cross join cid
     where x.company_id = cid.company_id
       and (case
              when x.payment_mode in ('Cash','Bank') then x.expense_date
              when x.payment_mode = 'Cheque'
                then case when ch.status = 'cleared' then ch.cleared_at::date end
              when x.payment_mode = 'Payable' and x.payable_status = 'Paid'
                then x.paid_at::date
            end) between p_start and p_end
     group by 1
  ),
  regions as (
    select b.id, b.name::text from public.branches b cross join cid where b.company_id = cid.company_id
    union
    select null::uuid, 'Unassigned'::text
     where exists (select 1 from inv where b is null) or exists (select 1 from rcp where b is null)
        or exists (select 1 from pay_a where b is null) or exists (select 1 from pay_c where b is null)
        or exists (select 1 from exp_a where b is null) or exists (select 1 from exp_c where b is null)
  )
  select r.id, r.name,
    coalesce(inv.amt,0), coalesce(pay_a.amt,0), coalesce(exp_a.amt,0),
    coalesce(inv.amt,0) - coalesce(pay_a.amt,0) - coalesce(exp_a.amt,0),
    coalesce(rcp.amt,0), coalesce(pay_c.amt,0), coalesce(exp_c.amt,0),
    coalesce(rcp.amt,0) - coalesce(pay_c.amt,0) - coalesce(exp_c.amt,0)
  from regions r
  left join inv   on inv.b   is not distinct from r.id
  left join rcp   on rcp.b   is not distinct from r.id
  left join pay_a on pay_a.b is not distinct from r.id
  left join pay_c on pay_c.b is not distinct from r.id
  left join exp_a on exp_a.b is not distinct from r.id
  left join exp_c on exp_c.b is not distinct from r.id
  order by r.name;
$function$;

revoke execute on function public.regional_pl_range(date, date) from public, anon;
grant execute on function public.regional_pl_range(date, date) to authenticated;

-- The single-month entry point is now a thin wrapper, so the two can never
-- disagree about how a region's profit is derived.
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
  select * from public.regional_pl_range(
    date_trunc('month', p_month)::date,
    (date_trunc('month', p_month) + interval '1 month - 1 day')::date
  );
$function$;

revoke execute on function public.regional_pl(date) from public, anon;
grant execute on function public.regional_pl(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The two-tier allocation
-- ---------------------------------------------------------------------------
-- One call returns the whole picture, tagged by row_kind so the report can lay
-- it out without doing any of the money arithmetic itself:
--
--   REGION            one per region: its profit, what its regional partners
--                     took, and the residual that fell through to the pool.
--   REGIONAL_PARTNER  one per regional partner: their share of their region.
--   EQUITY_PARTNER    one per equity partner: their share of the pooled residual.
--   UNALLOCATED       whatever the equity shares did not add up to. Surfaced
--                     rather than silently spread, so shares totalling 90% show
--                     10% retained instead of quietly inflating everyone.
--
-- p_basis picks which profit the shares bite on: 'revenue' (accrual — earned)
-- or 'cash' (received). Both are real questions and the report offers both.
create or replace function public.partnership_allocation(
  p_start date,
  p_end   date,
  p_basis text default 'revenue'
)
returns table(
  row_kind     text,
  branch_id    uuid,
  region_name  text,
  partner_id   uuid,
  partner_name text,
  share_pct    numeric,
  base_amount  numeric,
  amount       numeric,
  residual     numeric
)
language sql
stable security definer
set search_path to 'public'
as $function$
  with cid as (select public.current_company_id() as company_id),
  pl as (
    select r.branch_id,
           r.region_name,
           case when lower(p_basis) = 'cash' then r.profit_cash else r.profit_accrual end as profit
      from public.regional_pl_range(p_start, p_end) r
  ),
  -- Only active partners allocate. An inactive one keeps its history but stops
  -- taking a cut.
  reg_p as (
    select p.id, p.name, p.branch_id, p.profit_share_percent
      from public.partners p cross join cid
     where p.company_id = cid.company_id
       and p.scope = 'BRANCH'
       and p.is_active
       and p.branch_id is not null
  ),
  eq_p as (
    select p.id, p.name, p.profit_share_percent
      from public.partners p cross join cid
     where p.company_id = cid.company_id
       and p.scope = 'COMPANY'
       and p.is_active
  ),
  -- What each region owes its own partners, and what is left after that.
  reg_alloc as (
    select pl.branch_id,
           pl.region_name,
           pl.profit,
           coalesce(sum(round(pl.profit * reg_p.profit_share_percent / 100, 2)), 0) as taken
      from pl
      left join reg_p on reg_p.branch_id = pl.branch_id
     group by pl.branch_id, pl.region_name, pl.profit
  ),
  pool as (select coalesce(sum(profit - taken), 0) as residual from reg_alloc)
  select 'REGION'::text, ra.branch_id, ra.region_name,
         null::uuid, null::text, null::numeric,
         ra.profit, ra.taken, ra.profit - ra.taken
    from reg_alloc ra
  union all
  select 'REGIONAL_PARTNER'::text, pl.branch_id, pl.region_name,
         reg_p.id, reg_p.name, reg_p.profit_share_percent,
         pl.profit, round(pl.profit * reg_p.profit_share_percent / 100, 2), null::numeric
    from reg_p join pl on pl.branch_id = reg_p.branch_id
  union all
  select 'EQUITY_PARTNER'::text, null::uuid, null::text,
         eq_p.id, eq_p.name, eq_p.profit_share_percent,
         pool.residual, round(pool.residual * eq_p.profit_share_percent / 100, 2), null::numeric
    from eq_p cross join pool
  union all
  select 'UNALLOCATED'::text, null::uuid, null::text, null::uuid, null::text,
         100 - coalesce((select sum(profit_share_percent) from eq_p), 0),
         pool.residual,
         pool.residual - coalesce((select sum(round(pool.residual * profit_share_percent / 100, 2)) from eq_p), 0),
         null::numeric
    from pool;
$function$;

revoke execute on function public.partnership_allocation(date, date, text) from public, anon;
grant execute on function public.partnership_allocation(date, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Itemised operating expenses, by region and category
-- ---------------------------------------------------------------------------
-- Every individual operating-expense line for the month, so the report can show
-- category → the expenses inside it → totals. Cost-of-services rows are
-- excluded: those are the cost of a client's guards, not of running the
-- business.
--
-- Office-staff salaries are appended as ONE derived line per region. They are
-- an operating cost by any sensible reading, but they live in payslips rather
-- than expenses, so there is no individual row to itemise and none is invented.
create or replace function public.operating_expense_detail(p_month date)
returns table(
  branch_id    uuid,
  region_name  text,
  category     text,
  expense_id   uuid,
  expense_date date,
  description  text,
  client_name  text,
  vendor_name  text,
  payment_mode text,
  amount       numeric,
  is_derived   boolean
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
           x.id as expense_id,
           x.expense_date,
           x.description,
           c.name::text as client_name,
           v.name::text as vendor_name,
           x.payment_mode::text,
           x.amount::numeric,
           false as is_derived
      from public.expenses x
      left join public.clients c on c.id = x.client_id
      left join public.vendors v on v.id = x.vendor_id
      left join public.expense_categories cat on cat.id = x.category_id
     cross join m, cid
     where x.company_id = cid.company_id
       and x.pl_category = 'operating_expense'
       and x.expense_date between m.start_d and m.end_d
    union all
    select e.branch_id,
           'Office staff salaries'::text,
           null::uuid,
           m.start_d,
           count(*)::text || ' office staff',
           null::text,
           null::text,
           null::text,
           sum(ps.final_salary)::numeric,
           true
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
     cross join m, cid
     where e.company_id = cid.company_id
       and e.category = 'office_staff'
       and ps.period_month = m.start_d
     group by e.branch_id, m.start_d
  )
  select rows.b,
         coalesce(br.name, 'Unassigned')::text,
         rows.category,
         rows.expense_id,
         rows.expense_date,
         rows.description,
         rows.client_name,
         rows.vendor_name,
         rows.payment_mode,
         rows.amount,
         rows.is_derived
    from rows
    left join public.branches br on br.id = rows.b
   order by 2, 3, 5, 10 desc;
$function$;

revoke execute on function public.operating_expense_detail(date) from public, anon;
grant execute on function public.operating_expense_detail(date) to authenticated;
