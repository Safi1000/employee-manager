-- 0225 — Head-office cost is apportioned by REVENUE, not guard-days (A10),
--        and an unapportionable pool is surfaced instead of vanishing.
--
-- run_ho_cost_allocation drove the apportionment off avg_deployed_guards. That
-- is wrong in principle, not merely miscounted: a services-only client deploys
-- nobody, so a guard-day driver gives it zero head-office absorption. Sandbox
-- July: Security Services revenue 90,000 against Guard Deployment revenue
-- 2,078,000 — the first of those absorbs nothing under a deployment driver.
--
-- A10: revenue basis -> driver is invoiced amount; cash basis -> driver is cash
-- received. Never guard-days, and never mixed within one report.
--
-- Measured against sandbox data before the change (pool from
-- ho_overhead_for_month, base = revenue of branches that bill):
--
--   July 2026   pool 68,871.00
--     North   1,050,000   deployed wt 50.00%  ->  revenue wt 50.53%
--             34,435.50                       ->  34,800.07   (+364.57)
--     South   1,028,000   deployed wt 50.00%  ->  revenue wt 49.47%
--             34,435.50                       ->  34,070.93   (-364.57)
--
--   August 2026  pool 101,999.87
--     North   2,100,000   deployed 0.00  ->  revenue wt 53.68%
--                  0.00                  ->  54,754.53
--     South   1,812,000   deployed 0.00  ->  revenue wt 46.32%
--                  0.00                  ->  47,245.34
--
-- August is the case that matters. Every region read 0.00 deployed, so
-- `v_total <= 0` fired and the ENTIRE 101,999.87 pool was allocated nowhere and
-- recorded nowhere. Not misallocated — vanished. That is the same root cause as
-- the 110,010 that landed on Delta: an unapportionable pool with no explicit
-- home. Hence the `unallocated` column and the exhaustion assertion below.
--
-- Two structural fixes travel with the driver change:
--   * the `if deployed <= 0 then continue` skip is gone. A region with no
--     revenue allocates zero through the arithmetic, not through a skip, so a
--     dropped region shows up as a remainder rather than disappearing.
--   * head office enters the apportionment base as a RECEIVER whenever it bills
--     directly, while remaining the giver of the pool. Otherwise revenue earned
--     at head office absorbs no overhead — the same failure, relocated.

-- ---------------------------------------------------------------------------
-- 1. The driver.
--
-- Revenue basis reads invoiced amount at SERVICE month (A4), matching
-- journal_on_invoice's own dating. Cash basis reads cash received in the month.
-- ---------------------------------------------------------------------------

create or replace function public.branch_revenue_for_month(
  p_company_id uuid, p_branch_id uuid, p_period date, p_basis text default 'revenue')
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    case when lower(coalesce(p_basis, 'revenue')) = 'cash' then
      (select sum(pay.amount)
         from public.invoice_payments pay
         join public.invoices i on i.id = pay.invoice_id
        where i.company_id = p_company_id
          and i.branch_id = p_branch_id
          and pay.payment_date >= date_trunc('month', p_period)::date
          and pay.payment_date <  (date_trunc('month', p_period) + interval '1 month')::date)
    else
      (select sum(il.amount)
         from public.invoice_lines il
         join public.invoices i on i.id = il.invoice_id
        where i.company_id = p_company_id
          and i.branch_id = p_branch_id
          and coalesce(i.period_start, i.invoice_date) >= date_trunc('month', p_period)::date
          and coalesce(i.period_start, i.invoice_date) <  (date_trunc('month', p_period) + interval '1 month')::date)
    end, 0);
$function$;

comment on function public.branch_revenue_for_month(uuid, uuid, date, text) is
  'A10 head-office apportionment driver. revenue basis = invoiced amount at service month; cash basis = cash received in month. Never guard-days.';

-- ---------------------------------------------------------------------------
-- 2. Unapportioned pool gets a home.
-- ---------------------------------------------------------------------------

alter table public.ho_allocation_runs
  add column if not exists unallocated numeric not null default 0;

comment on column public.ho_allocation_runs.unallocated is
  'Head-office cost NOT apportioned this period — non-zero only when no branch billed anything (the A3 division-by-zero case). Must be surfaced, never silently dropped.';

-- ---------------------------------------------------------------------------
-- 3. The allocation.
-- ---------------------------------------------------------------------------

-- The added basis parameter changes the signature, so the two-argument version
-- must go explicitly or it survives as an overload still driving off deployment.
drop function if exists public.run_ho_cost_allocation(uuid, date);

create or replace function public.run_ho_cost_allocation(
  p_company_id uuid, p_period date, p_basis text default 'revenue')
returns numeric
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_month     date := date_trunc('month', p_period)::date;
  v_ho        uuid := public.head_office_region(p_company_id);
  v_basis     text := lower(coalesce(p_basis, 'revenue'));
  v_cost      numeric;
  v_total     numeric := 0;
  r           record;
  v_lines     jsonb := '[]'::jsonb;
  v_alloc     numeric;
  v_alloc_sum numeric := 0;
  v_run       uuid;
  v_top       uuid;
  v_residual  numeric;
begin
  v_cost := public.ho_overhead_for_month(p_company_id, v_month);

  select id into v_run from public.ho_allocation_runs
   where company_id = p_company_id and period_month = v_month;
  if v_run is not null then
    perform public.reverse_journal_for_source(p_company_id, 'ho_allocation', v_run,
      (v_month + interval '1 month - 1 day')::date);
  end if;

  -- Base is every active branch that BILLED, head office included when it bills
  -- direct. Head office is the giver of the pool, but revenue it earns must
  -- still absorb overhead or the defect simply moves.
  select coalesce(sum(public.branch_revenue_for_month(p_company_id, b.id, v_month, v_basis)), 0)
    into v_total
    from public.branches b
   where b.company_id = p_company_id and b.active;

  if v_run is null then
    insert into public.ho_allocation_runs
      (company_id, period_month, basis, ho_cost, total_deployed)
    values (p_company_id, v_month, v_basis, v_cost, v_total) returning id into v_run;
  else
    update public.ho_allocation_runs
       set basis = v_basis, ho_cost = v_cost, total_deployed = v_total, updated_at = now()
     where id = v_run;
  end if;

  -- Nothing to spread, or nobody billed. A zero denominator is the A3 case:
  -- allocate nothing and carry the whole pool as explicitly unallocated so it
  -- is visible rather than absorbed by whoever happens to sort first.
  if v_cost <= 0 or v_total <= 0 then
    update public.ho_allocation_runs
       set allocated_total = 0,
           unallocated = greatest(coalesce(v_cost, 0), 0)
     where id = v_run;
    return 0;
  end if;

  -- Largest biller carries the rounding residual, matching the convention
  -- payslip_client_split uses for the payroll split.
  select b.id into v_top
    from public.branches b
   where b.company_id = p_company_id and b.active
   order by public.branch_revenue_for_month(p_company_id, b.id, v_month, v_basis) desc, b.id
   limit 1;

  for r in
    select b.id,
           public.branch_revenue_for_month(p_company_id, b.id, v_month, v_basis) as revenue
      from public.branches b
     where b.company_id = p_company_id and b.active and b.id <> v_top
  loop
    -- No `continue` on zero: a branch that billed nothing reaches zero through
    -- the proportion itself, and any shortfall surfaces in the assertion below.
    v_alloc := round(v_cost * greatest(coalesce(r.revenue, 0), 0) / v_total, 2);
    if v_alloc <> 0 then
      v_alloc_sum := v_alloc_sum + v_alloc;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'key', 'allocated_ho_cost', 'debit', v_alloc, 'credit', 0, 'region', r.id));
    end if;
  end loop;

  v_residual := v_cost - v_alloc_sum;
  if v_residual <> 0 then
    v_alloc_sum := v_alloc_sum + v_residual;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'key', 'allocated_ho_cost', 'debit', v_residual, 'credit', 0, 'region', v_top));
  end if;

  -- Sum of allocated must equal the pool. If it ever does not, the
  -- apportionment is wrong and posting it would move the error into the ledger.
  if v_alloc_sum <> v_cost then
    raise exception
      'HO allocation does not exhaust the pool: allocated % of % for %',
      v_alloc_sum, v_cost, v_month
      using errcode = '23514';
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'key', 'ho_cost_recovery', 'debit', 0, 'credit', v_alloc_sum, 'region', v_ho));

  perform public.post_journal(
    p_company_id, (v_month + interval '1 month - 1 day')::date,
    'Head-office cost allocation ' || to_char(v_month, 'YYYY-MM'),
    'ho_allocation', v_run, false, v_lines, v_ho);

  update public.ho_allocation_runs
     set allocated_total = v_alloc_sum, unallocated = 0
   where id = v_run;
  return v_alloc_sum;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The same bug in the reporting path.
--
-- partnership_allocation apportions HO by revenue already — but its guard is
-- `when ho.rev_base <= 0 then 0`, while head office still gives away -profit.
-- The pool therefore leaves head office and arrives nowhere: identical failure
-- mode, different surface. Head office now retains an unapportionable pool, and
-- a new UNALLOCATED_HO row makes it visible in the report.
-- ---------------------------------------------------------------------------

-- p_basis keeps its existing 'revenue' default — CREATE OR REPLACE cannot drop
-- a parameter default, and changing it would silently change every caller.
create or replace function public.partnership_allocation(
  p_start date, p_end date, p_basis text default 'revenue')
returns table(row_kind text, branch_id uuid, region_name text, partner_id uuid,
              partner_name text, share_pct numeric, own_profit numeric,
              ho_allocated numeric, base_amount numeric, amount numeric,
              residual numeric)
language sql
stable
security definer
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
    select raw.branch_id, raw.region_name, raw.is_ho, raw.profit as own_profit,
           case
             -- Nobody billed: the pool cannot be apportioned, so head office
             -- keeps it rather than giving it to no one.
             when ho.rev_base <= 0 then 0
             when raw.is_ho then -raw.profit
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
       and (p.start_month is null or p.start_month <= p_end)
  ),
  eq_p as (
    select p.id, p.name, p.profit_share_percent
      from public.partners p cross join cid
     where p.company_id = cid.company_id and p.scope = 'COMPANY' and p.is_active
       and (p.start_month is null or p.start_month <= p_end)
  ),
  cs_cash as (select client_id, branch_id, net from public.client_statement_loaded(p_start, p_end, 'cash')),
  cs_rev  as (select client_id, branch_id, net from public.client_statement_loaded(p_start, p_end, 'revenue')),
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
      left join lateral (
        select s.share_percent
          from public.partner_client_shares s
         where s.partner_id = rp.id and s.client_id = csr.client_id
           and s.effective_month <= p_start
         order by s.effective_month desc
         limit 1
      ) o on true
  ),
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
  -- Head-office cost that could not be apportioned because nothing was billed.
  -- Surfaced rather than silently retained.
  select 'UNALLOCATED_HO'::text, null::uuid, null::text, null::uuid, null::text,
         null::numeric, null::numeric, null::numeric,
         ho.ho_profit, ho.ho_profit, null::numeric
    from ho where ho.rev_base <= 0 and ho.ho_profit <> 0
  union all
  select 'UNALLOCATED'::text, null::uuid, null::text, null::uuid, null::text,
         100 - coalesce((select sum(profit_share_percent) from eq_p), 0),
         null::numeric, null::numeric, pool.residual,
         pool.residual - coalesce((select sum(round(pool.residual * profit_share_percent / 100, 2)) from eq_p), 0),
         null::numeric
    from pool;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Repost invoice revenue to its service month (A4).
--
-- All seven sandbox invoices carry a June or July period_start, yet every
-- posted revenue line sits in posting_period 2026-08. Diagnosis: those entries
-- were created 2026-08-28 19:23-19:24, roughly fourteen hours BEFORE 0221
-- applied (20260829092850), so they carry the pre-0221 invoice_date dating.
-- period_start is populated on all seven (0 nulls), so the coalesce is not
-- falling through and there is no data defect in `invoices` — the trigger is
-- already correct and the rows are simply stale. Reposting is sufficient.
--
-- This matters to the driver: read at service month, July apportions against
-- 2,078,000 of regional revenue; left as-is, July has none and August has two
-- months of it.
-- ---------------------------------------------------------------------------

-- The posting body becomes callable so a repost does not depend on faking an
-- UPDATE that satisfies the trigger's change detection. Same pattern as 0222's
-- post_payslip_accrual.
create or replace function public.post_invoice_journal(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  inv       record;
  v_gross   numeric;
  v_tax     numeric;
  v_revenue numeric;
  v_rev_key text;
  v_date    date;
begin
  select * into inv from public.invoices where id = p_invoice_id;
  if not found then return; end if;

  v_date    := coalesce(inv.period_start, inv.invoice_date);   -- A4: service month
  v_gross   := inv.invoice_amount;
  v_tax     := coalesce(inv.tax_added_total, 0);
  v_revenue := v_gross - v_tax;

  v_rev_key := 'revenue_security';
  begin
    select case when c.client_type = 'guard_deployment' then 'revenue_guard' else 'revenue_security' end
      into v_rev_key
      from public.clients c where c.id = inv.client_id;
  exception when others then null;
  end;

  perform public.post_journal(
    inv.company_id, v_date,
    'Invoice ' || coalesce(inv.invoice_number, inv.id::text),
    'invoices', inv.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ar', 'debit', v_gross, 'credit', 0,
                         'client_id', inv.client_id, 'contract_id', inv.contract_id),
      jsonb_build_object('key', v_rev_key, 'debit', 0, 'credit', v_revenue,
                         'client_id', inv.client_id, 'contract_id', inv.contract_id),
      jsonb_build_object('key', 'sales_tax_payable', 'debit', 0, 'credit', v_tax,
                         'client_id', inv.client_id)
    ),
    inv.branch_id
  );
end;
$function$;

create or replace function public.journal_on_invoice()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_old_date date;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(
      old.company_id, 'invoices', old.id,
      coalesce(old.period_start, old.invoice_date));
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.invoice_amount is distinct from new.invoice_amount
       or coalesce(old.tax_added_total, 0) is distinct from coalesce(new.tax_added_total, 0)
       or old.period_start is distinct from new.period_start
       or old.invoice_date is distinct from new.invoice_date
       or old.client_id is distinct from new.client_id
       or old.branch_id is distinct from new.branch_id then
      v_old_date := coalesce(old.period_start, old.invoice_date);
      perform public.reverse_journal_for_source(new.company_id, 'invoices', new.id, v_old_date);
    else
      return new;
    end if;
  end if;

  perform public.post_invoice_journal(new.id);
  return new;
end;
$function$;

do $$
declare
  i record;
  v_n int := 0;
begin
  perform set_config('app.ledger_maintenance', 'on', true);

  for i in
    select inv.id, inv.company_id, je.posting_period,
           date_trunc('month', coalesce(inv.period_start, inv.invoice_date))::date as service_month
      from public.invoices inv
      join public.journal_entries je
        on je.source_table = 'invoices' and je.source_id = inv.id
       and je.is_reversal = false and je.status = 'posted'
     where je.posting_period
           <> date_trunc('month', coalesce(inv.period_start, inv.invoice_date))::date
  loop
    perform public.reverse_journal_for_source(
      i.company_id, 'invoices', i.id, i.posting_period);
    perform public.post_invoice_journal(i.id);
    v_n := v_n + 1;
  end loop;

  perform set_config('app.ledger_maintenance', '', true);
  raise notice '0225 reposted % invoice entries to their service month', v_n;
end $$;
