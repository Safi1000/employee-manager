-- Bonus pools, profit-growth based (spec section 16).
--
-- Regional pools = % of the region's year-on-year PROFIT GROWTH. Head-office
-- pool = % of total company profit growth. No growth => no pool, by design.
--
-- Split: each enrolled person's share = salary x rating-weight (Outstanding
-- 1.5 / Exceeds 1.2 / Meets 1.0 / Below 0) / total points in that pool,
-- pro-rated for anyone enrolled or departed part-way through the year. Payout
-- runs through the salaried payroll stream as a bonus reward line (§13).
--
-- DEPENDENCIES not yet built, noted honestly:
--   * §6 HO cost apportionment — regional profit here is computed from the
--     region-TAGGED journal lines (§1), i.e. BEFORE head-office allocation.
--     When §6 lands, region_profit() is the single place to net it out.
--   * §9.3 bonus reserve — the pool is funded from it; that reserve isn't
--     built yet, so payout currently just posts the reward line.

-- ---------------------------------------------------------------------------
-- 1. Region (or whole-company) net profit for a year, straight off the ledger.
--    branch NULL => whole company (used by the head-office pool's "total
--    company profit"). Revenue is credit-normal, expense debit-normal.
-- ---------------------------------------------------------------------------

create or replace function public.region_profit(
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
     and a.account_type in ('revenue', 'expense');
$$;

-- ---------------------------------------------------------------------------
-- 2. Pools & allocations
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.bonus_pool_scope as enum ('regional', 'head_office');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.bonus_pool_status as enum ('draft', 'approved', 'paid', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.bonus_pools (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  period_year    integer not null,
  scope          public.bonus_pool_scope not null,
  branch_id      uuid references public.branches(id),  -- null for head_office scope
  profit_current numeric(16,2),
  profit_prior   numeric(16,2),
  growth         numeric(16,2),
  pool_pct       numeric(6,3),
  pool_amount    numeric(16,2),
  status         public.bonus_pool_status not null default 'draft',
  approved_by    uuid,
  approved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Expression-based uniqueness (a table UNIQUE can't hold coalesce): one pool
-- per company/year/scope/region, treating null branch (head office) as a fixed
-- sentinel so it dedupes too.
create unique index if not exists idx_bonus_pool_unique
  on public.bonus_pools (company_id, period_year, scope,
                         coalesce(branch_id, '00000000-0000-0000-0000-000000000000'));

create table if not exists public.bonus_pool_allocations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  pool_id       uuid not null references public.bonus_pools(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  salary        numeric(16,2),
  rating        public.appraisal_rating,
  rating_weight numeric(4,2),
  proration     numeric(5,4),   -- 0..1 for part-year enrolment / leavers
  points        numeric(16,4),
  share_amount  numeric(16,2),
  paid          boolean not null default false,
  paid_payslip_id uuid references public.payslips(id),
  created_at    timestamptz not null default now(),
  unique (pool_id, employee_id)
);

create index if not exists idx_bpa_pool on public.bonus_pool_allocations(pool_id);

do $$
declare t text;
begin
  foreach t in array array['bonus_pools', 'bonus_pool_allocations'] loop
    execute format('drop trigger if exists trg_aaa_%1$s_fill_company on public.%1$s', t);
    execute format('create trigger trg_aaa_%1$s_fill_company before insert on public.%1$s
                      for each row execute function public.fill_company_id()', t);
    execute format('alter table public.%1$s enable row level security', t);
    execute format('drop policy if exists "ssa_all" on public.%1$s', t);
    execute format('create policy "ssa_all" on public.%1$s for all
                      using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped())', t);
    execute format('drop policy if exists "company_members" on public.%1$s', t);
    execute format('create policy "company_members" on public.%1$s for all
                      using (company_id = public.current_company_id())
                      with check (company_id = public.current_company_id())', t);
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- 3. Fraction of the year an employee participates: from the later of Jan 1 /
--    their enrolment date, to the earlier of Dec 31 / their exit date.
-- ---------------------------------------------------------------------------

create or replace function public.bonus_proration(p_employee_id uuid, p_year integer)
returns numeric language sql stable security definer set search_path = public as $$
  select greatest(0, least(1,
    ( least(coalesce(e.exit_date, make_date(p_year,12,31)), make_date(p_year,12,31))
      - greatest(coalesce(e.performance_enrolled_on, make_date(p_year,1,1)), make_date(p_year,1,1))
      + 1 )::numeric
    / (make_date(p_year,12,31) - make_date(p_year,1,1) + 1)
  ))
  from public.employees e where e.id = p_employee_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. Generate a pool: compute growth, size the pool, and allocate points.
--    Enrolled employees are those whose region matches the pool scope. Leavers
--    are included pro-rata OR forfeited per the D7 setting. Below-rated get a
--    zero weight, so they occupy no points and receive nothing.
-- ---------------------------------------------------------------------------

create or replace function public.generate_bonus_pool(
  p_company_id uuid,
  p_year       integer,
  p_scope      public.bonus_pool_scope,
  p_branch_id  uuid default null   -- required for regional scope
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
    v_cur   := public.region_profit(p_company_id, p_branch_id, p_year);
    v_prior := public.region_profit(p_company_id, p_branch_id, p_year - 1);
  else
    v_scope_branch := v_ho;          -- HO staff live in the head-office region
    v_pct := s.ho_pool_pct;
    v_cur   := public.region_profit(p_company_id, null, p_year);       -- whole company
    v_prior := public.region_profit(p_company_id, null, p_year - 1);
  end if;

  v_growth := v_cur - v_prior;
  v_amount := round(greatest(v_growth, 0) * v_pct / 100.0, 2);   -- no growth => no pool

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

  -- Rebuild allocations from scratch each run (a draft pool is recomputable).
  delete from public.bonus_pool_allocations where pool_id = v_pool;

  -- Pass 1: points, and the total.
  for e in
    select emp.id, emp.base_salary, emp.last_appraisal_rating
      from public.employees emp
     where emp.company_id = p_company_id
       and emp.performance_enrolled
       and emp.category = 'office_staff'
       and emp.branch_id = v_scope_branch
       -- leaver handling: forfeit rule drops anyone not currently active
       and (s.leaver_bonus_rule = 'pro_rata' or emp.lifecycle_state = 'active')
  loop
    v_weight := case e.last_appraisal_rating
      when 'outstanding' then s.weight_rating_outstanding
      when 'exceeds'     then s.weight_rating_exceeds
      when 'meets'       then s.weight_rating_meets
      else s.weight_rating_below   -- below or unrated => 0 by default
    end;
    v_prorate := public.bonus_proration(e.id, p_year);
    v_points  := round(coalesce(e.base_salary,0) * v_weight * v_prorate, 4);
    v_total   := v_total + v_points;

    insert into public.bonus_pool_allocations
      (company_id, pool_id, employee_id, salary, rating, rating_weight, proration, points)
    values (p_company_id, v_pool, e.id, e.base_salary, e.last_appraisal_rating,
            v_weight, v_prorate, v_points);
  end loop;

  -- Pass 2: money follows points.
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

-- ---------------------------------------------------------------------------
-- 5. Approval gate (COO) and payout through the salaried payroll stream.
-- ---------------------------------------------------------------------------

create or replace function public.approve_bonus_pool(p_pool_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(public.is_performance_approver(), false) then
    raise exception 'only a performance approver (COO) may approve a bonus pool'
      using errcode = '42501';
  end if;
  update public.bonus_pools
     set status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now()
   where id = p_pool_id and status = 'draft';
  if not found then
    raise exception 'pool % not found or not in draft', p_pool_id using errcode = '23514';
  end if;
end;
$$;

-- Push one allocation onto a salaried payslip as an Eid/bonus reward line
-- (§13 reward lines then roll it into net pay). The pool must be approved.
create or replace function public.pay_bonus_allocation(p_allocation_id uuid, p_payslip_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a record; v_pool record;
begin
  select * into a from public.bonus_pool_allocations where id = p_allocation_id;
  if not found then
    raise exception 'allocation % not found', p_allocation_id using errcode = '23503';
  end if;
  select * into v_pool from public.bonus_pools where id = a.pool_id;
  if v_pool.status <> 'approved' then
    raise exception 'bonus pool must be approved before payout (currently %)', v_pool.status
      using errcode = '23514';
  end if;
  if a.paid then
    raise exception 'allocation already paid' using errcode = '23505';
  end if;
  if coalesce(a.share_amount, 0) <= 0 then
    return;  -- nothing to pay (e.g. below-rated)
  end if;

  insert into public.payslip_reward_lines (company_id, payslip_id, kind, label, amount)
  values (a.company_id, p_payslip_id, 'bonus',
          'Bonus pool ' || v_pool.period_year || ' (' || v_pool.scope || ')', a.share_amount);

  update public.bonus_pool_allocations set paid = true, paid_payslip_id = p_payslip_id
   where id = p_allocation_id;
end;
$$;
