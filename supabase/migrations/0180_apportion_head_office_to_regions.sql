-- 0180: head-office cost is apportioned to the regions BEFORE partners are paid.
--
-- 0179 left head office in the residual pool, which meant regional partners were
-- paid on their region's gross profit and the equity partners alone absorbed
-- every rupee of head-office overhead. That is not how the business works: head
-- office exists to serve the regions, so its cost belongs to them.
--
-- The order of operations is now:
--
--   1. each region's own profit
--   2. + its share of head office, apportioned PRO-RATA BY REVENUE
--   3. regional partners take their % of that ADJUSTED figure
--   4. what is left in every region pools
--   5. equity partners split the pool
--
-- Revenue is the apportionment driver, and it follows the basis being asked
-- for: on the revenue basis a region is charged in proportion to what it
-- INVOICED, on the cash basis in proportion to what it COLLECTED. Charging a
-- region by one measure while judging its profit by another would make the two
-- tabs disagree about the same month.
--
-- Head office ends up netting to exactly zero — its whole cost is pushed out to
-- the regions — so the pool is now built purely from operating regions. The
-- arithmetic still closes: sum of adjusted region profits = company profit,
-- because the apportionment only moves money between rows.
--
-- Degenerate case: if no region has any revenue there is nothing to apportion
-- in proportion to, and dividing by zero would be worse than not apportioning.
-- Head office then stays in the pool exactly as it did before, which is the
-- only defensible fallback.
create or replace function public.partnership_allocation(
  p_start date,
  p_end   date,
  p_basis text default 'revenue'
)
returns table(
  row_kind      text,
  branch_id     uuid,
  region_name   text,
  partner_id    uuid,
  partner_name  text,
  share_pct     numeric,
  own_profit    numeric,
  ho_allocated  numeric,
  base_amount   numeric,
  amount        numeric,
  residual      numeric
)
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
    -- Head office's total cost, and the revenue base it is spread across.
    -- Only POSITIVE revenue counts toward the base: a region that invoiced
    -- nothing cannot be charged a share, and a negative weight would hand it a
    -- credit instead of a cost.
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
             -- Head office keeps nothing: its own cost, pushed straight back out.
             when raw.is_ho then -raw.profit
             -- Nothing to apportion against — leave it where it was.
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
  reg_alloc as (
    select pl.branch_id, pl.region_name, pl.own_profit, pl.ho_allocated, pl.profit,
           coalesce(sum(round(pl.profit * reg_p.profit_share_percent / 100, 2)), 0) as taken
      from pl
      left join reg_p on reg_p.branch_id = pl.branch_id
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
         round(pl.profit * reg_p.profit_share_percent / 100, 2), null::numeric
    from reg_p join pl on pl.branch_id = reg_p.branch_id
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

revoke execute on function public.partnership_allocation(date, date, text) from public, anon;
grant execute on function public.partnership_allocation(date, date, text) to authenticated;
