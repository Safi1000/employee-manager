-- 0206 — partnership_allocation now sums a regional partner's take PER CLIENT,
-- so a per-client share override (partner_client_shares, 0205) changes what that
-- partner actually receives. With no overrides the number is identical:
-- Sum(client_net * pct) = total_net * pct. Summed unrounded and rounded once, so
-- parity with the old per-region rounding is exact.
--
-- A partner with no `basis` set keeps the legacy behaviour — share of the
-- region's adjusted profit — because that path never looked at clients at all.
create or replace function public.partnership_allocation(
  p_start date, p_end date, p_basis text default 'revenue'
) returns table (
  row_kind text, branch_id uuid, region_name text,
  partner_id uuid, partner_name text, share_pct numeric,
  own_profit numeric, ho_allocated numeric, base_amount numeric,
  amount numeric, residual numeric
) language sql stable security definer set search_path = public as $$
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
    select raw.branch_id, raw.region_name, raw.is_ho, raw.profit as own_profit,
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
  reg_p as (
    select p.id, p.name, p.branch_id, p.profit_share_percent, p.basis
      from public.partners p cross join cid
     where p.company_id = cid.company_id and p.scope = 'BRANCH'
       and p.is_active and p.branch_id is not null
  ),
  eq_p as (
    select p.id, p.name, p.profit_share_percent
      from public.partners p cross join cid
     where p.company_id = cid.company_id and p.scope = 'COMPANY' and p.is_active
  ),
  -- Per-client statement rows on each basis, so a partner can be read on theirs.
  cs_cash as (select client_id, branch_id, net from public.client_statement_loaded(p_start, p_end, 'cash')),
  cs_rev  as (select client_id, branch_id, net from public.client_statement_loaded(p_start, p_end, 'revenue')),
  -- One row per (regional partner, client): the client's net on that partner's
  -- basis, times that client's own share when one is set.
  per_client as (
    select rp.id as partner_id, rp.branch_id,
           coalesce(o.share_percent, rp.profit_share_percent) as pct,
           case lower(rp.basis)
             when 'cash'    then coalesce(csc.net, 0)
             when 'revenue' then coalesce(csr.net, 0)
             else null
           end as client_net
      from reg_p rp
      left join cs_rev  csr on csr.branch_id = rp.branch_id
      left join cs_cash csc on csc.branch_id = rp.branch_id
                           and csc.client_id = csr.client_id
      left join public.partner_client_shares o
             on o.partner_id = rp.id and o.client_id = csr.client_id
  ),
  -- Partner total. A partner with no basis set keeps the legacy behaviour
  -- (share of the region's adjusted profit), so client_net is null for them.
  partner_take as (
    select rp.id as partner_id, rp.branch_id,
           case
             when rp.basis is null or lower(rp.basis) not in ('cash','revenue')
               then round(pl.profit * rp.profit_share_percent / 100, 2)
             else round(coalesce((select sum(pc.client_net * pc.pct / 100)
                                    from per_client pc
                                   where pc.partner_id = rp.id), 0), 2)
           end as amount
      from reg_p rp join pl on pl.branch_id = rp.branch_id
  ),
  reg_alloc as (
    select pl.branch_id, pl.region_name, pl.own_profit, pl.ho_allocated, pl.profit,
           coalesce((select sum(pt.amount) from partner_take pt where pt.branch_id = pl.branch_id), 0) as taken
      from pl
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
         pt.amount, null::numeric
    from reg_p
    join pl on pl.branch_id = reg_p.branch_id
    join partner_take pt on pt.partner_id = reg_p.id
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
$$;

grant execute on function public.partnership_allocation(date, date, text) to authenticated;
