-- Monthly bonus-pool accrual & reserve (spec section 9.3).
--
-- Monthly: YTD operating-profit growth vs the same period last year -> pool %
-- -> accrue conservatively (D3 = 75% of apparent growth): Dr Bonus Expense /
-- Cr Bonus Pool Provision, and move matching cash into the bonus reserve.
-- Year-end true-up to actual. Payout (from §16) is drawn from the reserve.
--
-- Accruing on OPERATING profit (region_operating_profit, which excludes the
-- bonus expense) is what stops the accrual from eating its own base.
--
-- The accrual is region-tagged, so each region's monthly P&L carries its own
-- bonus provision — "keeps monthly regional P&L honest," as the spec puts it.

-- ===========================================================================
-- 1. Chart of accounts.
--    Bonus Expense (P&L), Bonus Pool Provision (liability), and the Bonus
--    Reserve — a restricted-cash asset the money is swept into.
-- ===========================================================================

insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side,
   system_key, system_account, active)
select c.id, v.code, v.name, v.atype::public.account_type,
       v.side::public.account_normal_side, v.key, true, true
  from public.companies c
  cross join (values
    ('6600', 'Bonus Expense',         'expense',   'debit',  'bonus_expense'),
    ('2400', 'Bonus Pool Provision',  'liability', 'credit', 'bonus_provision'),
    ('1160', 'Bonus Reserve (restricted cash)', 'asset', 'debit', 'bonus_reserve')
  ) as v(code, name, atype, side, key)
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.system_key = v.key
 );

-- ===========================================================================
-- 2. Accrual runs, tracked per company/region/year-month so the monthly delta
--    is the difference between the YTD target and what's already accrued.
-- ===========================================================================

create table if not exists public.bonus_accruals (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  branch_id      uuid references public.branches(id),
  scope          public.bonus_pool_scope not null,
  period_month   date not null,
  profit_ytd     numeric(16,2),
  profit_ytd_prior numeric(16,2),
  growth_ytd     numeric(16,2),
  pool_pct       numeric(6,3),
  conservatism_pct numeric(5,2),
  target_accrual numeric(16,2),   -- cumulative YTD provision this run implies
  accrued_delta  numeric(16,2),   -- what this month posts (target - prior YTD)
  created_at     timestamptz not null default now()
);

-- Expression uniqueness needs an index (a table UNIQUE can't hold coalesce).
create unique index if not exists idx_bonus_accruals_unique
  on public.bonus_accruals (company_id, scope,
                            coalesce(branch_id, '00000000-0000-0000-0000-000000000000'), period_month);

drop trigger if exists trg_aaa_bonus_accruals_fill_company on public.bonus_accruals;
create trigger trg_aaa_bonus_accruals_fill_company
  before insert on public.bonus_accruals
  for each row execute function public.fill_company_id();

alter table public.bonus_accruals enable row level security;
drop policy if exists "ssa_all" on public.bonus_accruals;
create policy "ssa_all" on public.bonus_accruals for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.bonus_accruals;
create policy "company_members" on public.bonus_accruals for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ===========================================================================
-- 3. Operating profit for the YTD window (Jan 1 .. end of the given month).
--    A dated variant of region_operating_profit.
-- ===========================================================================

create or replace function public.region_operating_profit_range(
  p_company_id uuid, p_branch_id uuid, p_start date, p_end date)
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
     and je.entry_date between p_start and p_end
     and (p_branch_id is null or jl.branch_id = p_branch_id)
     and a.account_type in ('revenue', 'expense')
     and a.system_key is distinct from 'bonus_expense';
$$;

-- ===========================================================================
-- 4. The monthly accrual. Runs regional pools (one per regional region) plus
--    the head-office pool, posting the YTD-cumulative delta each time. Sweeps
--    matching cash into the reserve.
-- ===========================================================================

create or replace function public.accrue_bonus_reserve(p_company_id uuid, p_period date)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  s          record;
  fs         record;
  v_month    date := date_trunc('month', p_period)::date;
  v_end      date := (v_month + interval '1 month - 1 day')::date;
  v_year     integer := extract(year from v_month);
  v_cur_start date := make_date(v_year, 1, 1);
  v_prior_start date := make_date(v_year - 1, 1, 1);
  v_prior_end date := (make_date(v_year - 1, extract(month from v_month)::int, 1)
                       + interval '1 month - 1 day')::date;
  rec        record;
  v_ytd      numeric;
  v_ytd_prior numeric;
  v_growth   numeric;
  v_pct      numeric;
  v_target   numeric;
  v_prior_accrued numeric;
  v_delta    numeric;
  v_total_delta numeric := 0;
  v_ho       uuid := public.head_office_region(p_company_id);
  v_accrual_id uuid;
  v_region   uuid;
begin
  select * into s  from public.performance_settings where company_id = p_company_id;
  select * into fs from public.finance_settings     where company_id = p_company_id;

  -- One iteration per pool: each regional region, then head office.
  for rec in
    select 'regional'::public.bonus_pool_scope as scope, b.id as branch_id
      from public.branches b
     where b.company_id = p_company_id and b.kind = 'regional' and b.active
    union all
    select 'head_office'::public.bonus_pool_scope, v_ho
  loop
    if rec.scope = 'regional' then
      v_pct := s.regional_pool_pct;
      v_ytd       := public.region_operating_profit_range(p_company_id, rec.branch_id, v_cur_start, v_end);
      v_ytd_prior := public.region_operating_profit_range(p_company_id, rec.branch_id, v_prior_start, v_prior_end);
    else
      v_pct := s.ho_pool_pct;
      -- Head-office pool is on TOTAL company profit growth.
      v_ytd       := public.region_operating_profit_range(p_company_id, null, v_cur_start, v_end);
      v_ytd_prior := public.region_operating_profit_range(p_company_id, null, v_prior_start, v_prior_end);
    end if;

    v_growth := v_ytd - v_ytd_prior;
    v_target := round(greatest(v_growth, 0) * v_pct / 100.0
                      * coalesce(fs.bonus_accrual_conservatism_pct, 75) / 100.0, 2);

    -- What's already been provisioned this year for this pool.
    select coalesce(max(target_accrual), 0) into v_prior_accrued
      from public.bonus_accruals
     where company_id = p_company_id and scope = rec.scope
       and coalesce(branch_id,'00000000-0000-0000-0000-000000000000')
           = coalesce(rec.branch_id,'00000000-0000-0000-0000-000000000000')
       and period_month < v_month
       and extract(year from period_month) = v_year;

    v_delta := round(v_target - v_prior_accrued, 2);
    v_region := case when rec.scope='regional' then rec.branch_id else v_ho end;

    insert into public.bonus_accruals
      (company_id, branch_id, scope, period_month, profit_ytd, profit_ytd_prior,
       growth_ytd, pool_pct, conservatism_pct, target_accrual, accrued_delta)
    values
      (p_company_id, v_region, rec.scope, v_month, v_ytd, v_ytd_prior, v_growth, v_pct,
       coalesce(fs.bonus_accrual_conservatism_pct,75), v_target, v_delta)
    on conflict (company_id, scope,
                 coalesce(branch_id,'00000000-0000-0000-0000-000000000000'), period_month)
      do update set profit_ytd = excluded.profit_ytd,
                    profit_ytd_prior = excluded.profit_ytd_prior,
                    growth_ytd = excluded.growth_ytd,
                    target_accrual = excluded.target_accrual,
                    accrued_delta = excluded.accrued_delta
      returning id into v_accrual_id;

    -- Idempotent per month+pool: reverse any prior posting for this accrual row
    -- before (re)posting, so a re-run nets to a single live entry rather than
    -- doubling. The stable v_accrual_id is the source key.
    perform public.reverse_journal_for_source(p_company_id, 'bonus_accrual', v_accrual_id, v_end);
    perform public.reverse_journal_for_source(p_company_id, 'bonus_reserve_funding', v_accrual_id, v_end);

    -- Post only a positive delta. A negative delta (profit fell back) is left
    -- to the year-end true-up rather than reversing provisions mid-year.
    if v_delta > 0 then
      -- Accrual: expense in the pool's region, provision (company liability).
      perform public.post_journal(
        p_company_id, v_end,
        'Bonus accrual ' || to_char(v_month,'YYYY-MM') || ' (' || rec.scope || ')',
        'bonus_accrual', v_accrual_id, false,
        jsonb_build_array(
          jsonb_build_object('key','bonus_expense',  'debit', v_delta, 'credit', 0, 'region', v_region),
          jsonb_build_object('key','bonus_provision', 'debit', 0, 'credit', v_delta, 'region', v_region)),
        v_region);

      -- Sweep matching cash into the restricted reserve.
      perform public.post_journal(
        p_company_id, v_end,
        'Bonus reserve funding ' || to_char(v_month,'YYYY-MM'),
        'bonus_reserve_funding', v_accrual_id, false,
        jsonb_build_array(
          jsonb_build_object('key','bonus_reserve','debit', v_delta,'credit',0, 'region', v_region),
          jsonb_build_object('key','bank','debit',0,'credit', v_delta, 'region', v_region)),
        v_region);

      v_total_delta := v_total_delta + v_delta;
    end if;
  end loop;

  return v_total_delta;
end;
$$;

-- ===========================================================================
-- 5. Year-end true-up: bring the provision to the actual approved pool total,
--    posting the difference (either direction).
-- ===========================================================================

create or replace function public.trueup_bonus_provision(p_company_id uuid, p_year integer)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_ho        uuid := public.head_office_region(p_company_id);
  v_provision numeric;
  v_actual    numeric;
  v_diff      numeric;
begin
  -- Current provision balance (credit-normal liability).
  select coalesce(sum(jl.credit - jl.debit), 0) into v_provision
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id and a.system_key = 'bonus_provision';

  -- Actual approved pools for the year.
  select coalesce(sum(pool_amount), 0) into v_actual
    from public.bonus_pools
   where company_id = p_company_id and period_year = p_year
     and status in ('approved', 'paid');

  v_diff := round(v_actual - v_provision, 2);
  if v_diff = 0 then return 0; end if;

  -- Adjust the provision to actual: extra expense if under-provisioned,
  -- release (credit expense) if over-provisioned. Booked at head office.
  perform public.post_journal(
    p_company_id, make_date(p_year, 12, 31),
    'Bonus provision true-up ' || p_year,
    'bonus_trueup', gen_random_uuid(), false,
    case when v_diff > 0 then
      jsonb_build_array(
        jsonb_build_object('key','bonus_expense', 'debit', v_diff, 'credit', 0),
        jsonb_build_object('key','bonus_provision','debit', 0, 'credit', v_diff))
    else
      jsonb_build_array(
        jsonb_build_object('key','bonus_provision','debit', -v_diff, 'credit', 0),
        jsonb_build_object('key','bonus_expense', 'debit', 0, 'credit', -v_diff))
    end,
    v_ho);

  return v_diff;
end;
$$;

-- ===========================================================================
-- 6. Reserve & provision balances, per region.
-- ===========================================================================

create or replace view public.bonus_reserve_balances
  with (security_invoker = true) as
  select je.company_id,
         jl.branch_id,
         b.name as region_name,
         sum(case when a.system_key = 'bonus_reserve'   then jl.debit - jl.credit else 0 end) as reserve_balance,
         sum(case when a.system_key = 'bonus_provision' then jl.credit - jl.debit else 0 end) as provision_balance
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
    left join public.branches b on b.id = jl.branch_id
   where a.system_key in ('bonus_reserve', 'bonus_provision')
   group by je.company_id, jl.branch_id, b.name;
