-- Regional P&L & Head-Office cost allocation (spec section 6).
--
-- Regional P&L = regional revenue − regional direct costs − APPORTIONED
-- head-office cost. Head-office cost is apportioned monthly by each region's
-- share of AVERAGE DEPLOYED GUARDS (deployed = actually present, not on-books).
-- The basis is stored as a parameter, reviewed annually.
--
-- Mechanism: the apportionment posts a real, region-tagged journal entry that
-- moves cost off head office and onto the regions via a recovery/clearing pair
-- that nets to zero company-wide. Because every posting is region-tagged (§1),
-- region_profit() then reads "after allocation" with no special-casing — which
-- is exactly what the §16 bonus pools consume.

-- ===========================================================================
-- 0. Finance settings — the allocation basis (§6) and the accrual
--    conservatism (D3, used by §9.3 next migration).
-- ===========================================================================

create table if not exists public.finance_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  ho_allocation_basis text not null default 'average_deployed_guards',
  -- D3: accrue the bonus reserve against this % of apparent growth (70–80).
  bonus_accrual_conservatism_pct numeric(5,2) not null default 75.00,
  updated_at timestamptz not null default now()
);

insert into public.finance_settings (company_id)
select id from public.companies on conflict (company_id) do nothing;

alter table public.finance_settings enable row level security;
drop policy if exists "ssa_all" on public.finance_settings;
create policy "ssa_all" on public.finance_settings for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.finance_settings;
create policy "company_members" on public.finance_settings for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ===========================================================================
-- 1. Chart of accounts: the allocation clearing pair.
--    Allocated cost (debit, lands in regions) and its recovery (credit, lands
--    at head office). Both expense-type so they flow through the P&L; net zero
--    company-wide.
-- ===========================================================================

insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side,
   system_key, system_account, active)
select c.id, v.code, v.name, 'expense'::public.account_type,
       v.side::public.account_normal_side, v.key, true, true
  from public.companies c
  cross join (values
    ('6500', 'Allocated Head-Office Cost', 'debit',  'allocated_ho_cost'),
    ('6510', 'Head-Office Cost Recovery',  'credit', 'ho_cost_recovery')
  ) as v(code, name, side, key)
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.system_key = v.key
 );

-- ===========================================================================
-- 2. Average deployed guards for a region in a month (present, not on-books).
-- ===========================================================================

create or replace function public.avg_deployed_guards(
  p_company_id uuid, p_branch_id uuid, p_period date)
returns numeric language sql stable security definer set search_path = public as $$
  select round(
    count(*) filter (where a.status = 'Present')::numeric
    / extract(day from (date_trunc('month', p_period) + interval '1 month - 1 day')), 2)
  from public.attendance_records a
  where a.company_id = p_company_id
    and a.branch_id = p_branch_id
    and a.attendance_date >= date_trunc('month', p_period)::date
    and a.attendance_date < (date_trunc('month', p_period) + interval '1 month')::date;
$$;

-- ===========================================================================
-- 3. Allocation run: one per company/month, reverse-and-repost on re-run.
-- ===========================================================================

create table if not exists public.ho_allocation_runs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  period_month  date not null,
  basis         text not null default 'average_deployed_guards',
  ho_cost       numeric(16,2),
  total_deployed numeric(16,2),
  allocated_total numeric(16,2),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (company_id, period_month)
);

drop trigger if exists trg_aaa_ho_alloc_fill_company on public.ho_allocation_runs;
create trigger trg_aaa_ho_alloc_fill_company
  before insert on public.ho_allocation_runs
  for each row execute function public.fill_company_id();

alter table public.ho_allocation_runs enable row level security;
drop policy if exists "ssa_all" on public.ho_allocation_runs;
create policy "ssa_all" on public.ho_allocation_runs for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.ho_allocation_runs;
create policy "company_members" on public.ho_allocation_runs for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- The head-office overhead to spread for a month: net expense on HO-tagged
-- lines, excluding the clearing pair, income tax, and any bonus accrual (bonus
-- is handled separately and must not be re-apportioned).
create or replace function public.ho_overhead_for_month(p_company_id uuid, p_period date)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(jl.debit - jl.credit), 0)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and jl.branch_id = public.head_office_region(p_company_id)
     and a.account_type = 'expense'
     and a.system_key not in ('allocated_ho_cost', 'ho_cost_recovery', 'income_tax', 'bonus_expense')
     and je.entry_date >= date_trunc('month', p_period)::date
     and je.entry_date < (date_trunc('month', p_period) + interval '1 month')::date;
$$;

create or replace function public.run_ho_cost_allocation(p_company_id uuid, p_period date)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_month   date := date_trunc('month', p_period)::date;
  v_ho      uuid := public.head_office_region(p_company_id);
  v_cost    numeric;
  v_total   numeric := 0;
  r         record;
  v_lines   jsonb := '[]'::jsonb;
  v_alloc   numeric;
  v_alloc_sum numeric := 0;
  v_run     uuid;
begin
  v_cost := public.ho_overhead_for_month(p_company_id, v_month);

  -- Reverse a prior run for this month before recomputing.
  select id into v_run from public.ho_allocation_runs
   where company_id = p_company_id and period_month = v_month;
  if v_run is not null then
    perform public.reverse_journal_for_source(p_company_id, 'ho_allocation', v_run,
      (v_month + interval '1 month - 1 day')::date);
  end if;

  -- Total deployed across REGIONAL regions (head office is the giver, not a
  -- receiver).
  select coalesce(sum(public.avg_deployed_guards(p_company_id, b.id, v_month)), 0)
    into v_total
    from public.branches b
   where b.company_id = p_company_id and b.kind = 'regional' and b.active;

  if v_run is null then
    insert into public.ho_allocation_runs (company_id, period_month, ho_cost, total_deployed)
    values (p_company_id, v_month, v_cost, v_total) returning id into v_run;
  else
    update public.ho_allocation_runs
       set ho_cost = v_cost, total_deployed = v_total, updated_at = now()
     where id = v_run;
  end if;

  -- Nothing to spread.
  if v_cost <= 0 or v_total <= 0 then
    update public.ho_allocation_runs set allocated_total = 0 where id = v_run;
    return 0;
  end if;

  -- Build a debit line per region by its deployed share; the credit is the sum
  -- of the debits, so rounding can never unbalance the entry.
  for r in
    select b.id, public.avg_deployed_guards(p_company_id, b.id, v_month) as deployed
      from public.branches b
     where b.company_id = p_company_id and b.kind = 'regional' and b.active
  loop
    if coalesce(r.deployed, 0) <= 0 then continue; end if;
    v_alloc := round(v_cost * r.deployed / v_total, 2);
    if v_alloc <= 0 then continue; end if;
    v_alloc_sum := v_alloc_sum + v_alloc;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'key', 'allocated_ho_cost', 'debit', v_alloc, 'credit', 0, 'region', r.id));
  end loop;

  if v_alloc_sum <= 0 then
    update public.ho_allocation_runs set allocated_total = 0 where id = v_run;
    return 0;
  end if;

  -- Recovery credit at head office for the total allocated.
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'key', 'ho_cost_recovery', 'debit', 0, 'credit', v_alloc_sum, 'region', v_ho));

  perform public.post_journal(
    p_company_id, (v_month + interval '1 month - 1 day')::date,
    'Head-office cost allocation ' || to_char(v_month, 'YYYY-MM'),
    'ho_allocation', v_run, false, v_lines, v_ho);

  update public.ho_allocation_runs set allocated_total = v_alloc_sum where id = v_run;
  return v_alloc_sum;
end;
$$;

-- ===========================================================================
-- 4. Operating profit = revenue − expenses EXCLUDING the bonus accrual.
--    This is the base the §16 pools and §9.3 accrual strike on: after HO
--    allocation (the clearing pair is included) but before bonus, so a bonus
--    accrual can't shrink the very pool it funds.
-- ===========================================================================

create or replace function public.region_operating_profit(
  p_company_id uuid, p_branch_id uuid, p_year integer)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(
           case a.account_type
             when 'revenue' then jl.credit - jl.debit
             when 'expense' then -(jl.debit - jl.credit)
             else 0
           end), 0)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and extract(year from je.entry_date) = p_year
     and (p_branch_id is null or jl.branch_id = p_branch_id)
     and a.account_type in ('revenue', 'expense')
     and a.system_key is distinct from 'bonus_expense';
$$;

-- Repoint the §16 bonus pool onto operating profit (after allocation, before
-- bonus). Body identical to 0092 except the two profit calls.
create or replace function public.generate_bonus_pool(
  p_company_id uuid,
  p_year       integer,
  p_scope      public.bonus_pool_scope,
  p_branch_id  uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s          record;
  v_ho       uuid := public.head_office_region(p_company_id);
  v_scope_branch uuid;
  v_cur      numeric;
  v_prior    numeric;
  v_growth   numeric;
  v_pct      numeric;
  v_amount   numeric;
  v_pool     uuid;
  e          record;
  v_weight   numeric;
  v_prorate  numeric;
  v_points   numeric;
  v_total    numeric := 0;
begin
  select * into s from public.performance_settings where company_id = p_company_id;

  if p_scope = 'regional' then
    if p_branch_id is null then
      raise exception 'regional pool requires a branch' using errcode = '23514';
    end if;
    v_scope_branch := p_branch_id;
    v_pct := s.regional_pool_pct;
    v_cur   := public.region_operating_profit(p_company_id, p_branch_id, p_year);
    v_prior := public.region_operating_profit(p_company_id, p_branch_id, p_year - 1);
  else
    v_scope_branch := v_ho;
    v_pct := s.ho_pool_pct;
    v_cur   := public.region_operating_profit(p_company_id, null, p_year);
    v_prior := public.region_operating_profit(p_company_id, null, p_year - 1);
  end if;

  v_growth := v_cur - v_prior;
  v_amount := round(greatest(v_growth, 0) * v_pct / 100.0, 2);

  insert into public.bonus_pools
    (company_id, period_year, scope, branch_id, profit_current, profit_prior,
     growth, pool_pct, pool_amount)
  values
    (p_company_id, p_year, p_scope, case when p_scope='regional' then p_branch_id else null end,
     v_cur, v_prior, v_growth, v_pct, v_amount)
  on conflict (company_id, period_year, scope,
               coalesce(branch_id, '00000000-0000-0000-0000-000000000000'))
    do update set profit_current = excluded.profit_current,
                  profit_prior = excluded.profit_prior,
                  growth = excluded.growth,
                  pool_pct = excluded.pool_pct,
                  pool_amount = excluded.pool_amount,
                  updated_at = now()
  returning id into v_pool;

  delete from public.bonus_pool_allocations where pool_id = v_pool;

  for e in
    select emp.id, emp.base_salary, emp.last_appraisal_rating
      from public.employees emp
     where emp.company_id = p_company_id
       and emp.performance_enrolled
       and emp.category = 'office_staff'
       and emp.branch_id = v_scope_branch
       and (s.leaver_bonus_rule = 'pro_rata' or emp.lifecycle_state = 'active')
  loop
    v_weight := case e.last_appraisal_rating
      when 'outstanding' then s.weight_rating_outstanding
      when 'exceeds'     then s.weight_rating_exceeds
      when 'meets'       then s.weight_rating_meets
      else s.weight_rating_below
    end;
    v_prorate := public.bonus_proration(e.id, p_year);
    v_points  := round(coalesce(e.base_salary,0) * v_weight * v_prorate, 4);
    v_total   := v_total + v_points;

    insert into public.bonus_pool_allocations
      (company_id, pool_id, employee_id, salary, rating, rating_weight, proration, points)
    values (p_company_id, v_pool, e.id, e.base_salary, e.last_appraisal_rating,
            v_weight, v_prorate, v_points);
  end loop;

  if v_total > 0 and v_amount > 0 then
    update public.bonus_pool_allocations
       set share_amount = round(v_amount * points / v_total, 2)
     where pool_id = v_pool;
  else
    update public.bonus_pool_allocations set share_amount = 0 where pool_id = v_pool;
  end if;

  return v_pool;
end;
$$;

-- ===========================================================================
-- 5. Regional P&L, monthly, straight off the ledger — the consolidating view.
-- ===========================================================================

create or replace view public.regional_pnl_monthly
  with (security_invoker = true) as
  select je.company_id,
         jl.branch_id,
         b.name  as region_name,
         b.kind  as region_kind,
         date_trunc('month', je.entry_date)::date as period_month,
         sum(case a.account_type when 'revenue' then jl.credit - jl.debit else 0 end) as revenue,
         sum(case when a.account_type = 'expense'
                   and a.system_key not in ('allocated_ho_cost','ho_cost_recovery')
                  then jl.debit - jl.credit else 0 end) as direct_cost,
         sum(case when a.system_key = 'allocated_ho_cost' then jl.debit - jl.credit else 0 end) as allocated_ho_cost,
         sum(case when a.system_key = 'ho_cost_recovery'  then jl.debit - jl.credit else 0 end) as ho_cost_recovery,
         sum(case a.account_type
               when 'revenue' then jl.credit - jl.debit
               when 'expense' then -(jl.debit - jl.credit)
               else 0 end) as net_profit
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
    left join public.branches b on b.id = jl.branch_id
   where a.account_type in ('revenue', 'expense')
   group by je.company_id, jl.branch_id, b.name, b.kind, date_trunc('month', je.entry_date);
