-- 0204 — a revenue-basis regional partner is paid on Total Income, not Total Invoiced.
--
-- The Client Statements screen shows, per basis, a final column the whole report
-- builds toward:
--   Revenue Basis → "Total Income" = Invoiced − payroll − expenses − regional
--                   overhead − head office   (client_statement_loaded.net)
--   Cash Basis    → "Net Cash"     = the same subtraction on cash actually moved
--                   (client_statement_loaded.net, asked on the cash basis)
--
-- partnership_allocation already read the cash side correctly (cs_cash.net), but
-- the revenue side summed `revenue` — Total INVOICED, the first column, before a
-- single cost had been taken off. A 15% revenue-basis partner was therefore paid
-- 15% of gross billings rather than 15% of the region's Total Income, which on
-- any real month is several times too much.
--
-- Both bases now read `net`, so whatever basis a partner is on, their share comes
-- off the same figure the Client Statement puts at the end of that basis's row.
-- Only the cs_rev CTE and the two `when 'revenue'` branches change.

create or replace function public.partnership_allocation(p_start date, p_end date, p_basis text default 'revenue'::text)
returns table(row_kind text, branch_id uuid, region_name text, partner_id uuid, partner_name text, share_pct numeric, own_profit numeric, ho_allocated numeric, base_amount numeric, amount numeric, residual numeric)
language sql
stable security definer
set search_path to 'public'
as $function$
  with cid as (select public.current_company_id() as company_id),
  raw as (
    select r.branch_id,
           r.region_name,
           coalesce(b.is_head_office, false) as is_ho,
           case when lower(p_basis) = 'cash' then r.profit_cash  else r.profit_accrual  end as profit,
           case when lower(p_basis) = 'cash' then r.revenue_cash else r.revenue_accrual end as revenue
      from public.regional_pl_range(p_start, p_end) r
      left join public.branches b on b.id = r.branch_id
  ),
  ho as (
    select coalesce(sum(profit) filter (where is_ho), 0) as ho_profit,
           coalesce(sum(greatest(revenue, 0)) filter (where not is_ho), 0) as rev_base
      from raw
  ),
  adj as (
    select raw.branch_id,
           raw.region_name,
           raw.is_ho,
           raw.profit as own_profit,
           case
             when raw.is_ho then -raw.profit
             when ho.rev_base <= 0 then 0
             else ho.ho_profit * greatest(raw.revenue, 0) / ho.rev_base
           end as ho_allocated
      from raw cross join ho
  ),
  pl as (
    select branch_id, region_name, is_ho, own_profit, ho_allocated,
           own_profit + ho_allocated as profit
      from adj
  ),
  -- Both bases take the statement's FINAL column (net): "Net Cash" on the cash
  -- basis, "Total Income" on the revenue basis.
  cs_cash as (
    select branch_id, coalesce(sum(net), 0) as net
      from public.client_statement_loaded(p_start, p_end, 'cash')
     group by branch_id
  ),
  cs_rev as (
    select branch_id, coalesce(sum(net), 0) as net
      from public.client_statement_loaded(p_start, p_end, 'revenue')
     group by branch_id
  ),
  reg_p as (
    select p.id, p.name, p.branch_id, p.profit_share_percent, p.basis
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
  reg_alloc as (
    select pl.branch_id, pl.region_name, pl.own_profit, pl.ho_allocated, pl.profit,
           coalesce(sum(round(
             case lower(reg_p.basis)
               when 'cash'    then coalesce(csc.net, 0)
               when 'revenue' then coalesce(csr.net, 0)
               else pl.profit
             end * reg_p.profit_share_percent / 100, 2)), 0) as taken
      from pl
      left join reg_p on reg_p.branch_id = pl.branch_id
      left join cs_cash csc on csc.branch_id = pl.branch_id
      left join cs_rev  csr on csr.branch_id = pl.branch_id
     group by pl.branch_id, pl.region_name, pl.own_profit, pl.ho_allocated, pl.profit
  ),
  pool as (select coalesce(sum(profit - taken), 0) as residual from reg_alloc)
  select 'REGION'::text, ra.branch_id, ra.region_name,
         null::uuid, null::text, null::numeric,
         ra.own_profit, ra.ho_allocated, ra.profit, ra.taken, ra.profit - ra.taken
    from reg_alloc ra
  union all
  select 'REGIONAL_PARTNER'::text, pl.branch_id, pl.region_name,
         reg_p.id, reg_p.name, reg_p.profit_share_percent,
         pl.own_profit, pl.ho_allocated, pl.profit,
         round(
           case lower(reg_p.basis)
             when 'cash'    then coalesce(csc.net, 0)
             when 'revenue' then coalesce(csr.net, 0)
             else pl.profit
           end * reg_p.profit_share_percent / 100, 2), null::numeric
    from reg_p
    join pl on pl.branch_id = reg_p.branch_id
    left join cs_cash csc on csc.branch_id = reg_p.branch_id
    left join cs_rev  csr on csr.branch_id = reg_p.branch_id
  union all
  select 'EQUITY_PARTNER'::text, null::uuid, null::text,
         eq_p.id, eq_p.name, eq_p.profit_share_percent,
         null::numeric, null::numeric, pool.residual,
         round(pool.residual * eq_p.profit_share_percent / 100, 2), null::numeric
    from eq_p cross join pool
  union all
  select 'UNALLOCATED'::text, null::uuid, null::text, null::uuid, null::text,
         100 - coalesce((select sum(profit_share_percent) from eq_p), 0),
         null::numeric, null::numeric, pool.residual,
         pool.residual - coalesce((select sum(round(pool.residual * profit_share_percent / 100, 2)) from eq_p), 0),
         null::numeric
    from pool;
$function$;
