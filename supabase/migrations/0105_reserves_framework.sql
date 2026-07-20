-- Reserves (spec section 9.2) + depreciation-replacement mirror (§9.4).
--
-- Reserves are separate restricted-cash accounts the system treats as
-- unavailable: payroll (>= one month net payroll — sacred), statutory
-- (EOBI/SS/withheld — other people's money), bonus (§9.3, already built),
-- asset-replacement (§9.4), and an emergency buffer. Each has a target; the
-- balances-vs-target view drives the cash cockpit and danger bands (§9.5).
-- Optional auto-sweep of a % of receipts into the payroll reserve.

-- ===========================================================================
-- 1. Reserve accounts (bonus_reserve 1160 already exists).
-- ===========================================================================

insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side,
   system_key, system_account, active)
select c.id, v.code, v.name, 'asset'::public.account_type, 'debit'::public.account_normal_side,
       v.key, true, true
  from public.companies c
  cross join (values
    ('1161', 'Payroll Reserve (restricted)',          'payroll_reserve'),
    ('1162', 'Statutory Reserve (restricted)',        'statutory_reserve'),
    ('1163', 'Asset Replacement Reserve (restricted)','asset_replacement_reserve'),
    ('1164', 'Emergency Buffer (restricted)',         'emergency_reserve')
  ) as v(code, name, key)
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.system_key = v.key
 );

-- ===========================================================================
-- 2. Reserve policies (targets + optional auto-sweep).
-- ===========================================================================

do $$ begin
  create type public.reserve_type as enum
    ('payroll', 'statutory', 'bonus', 'asset_replacement', 'emergency');
exception when duplicate_object then null; end $$;

create table if not exists public.reserve_policies (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  reserve_type  public.reserve_type not null,
  -- Target as N months of the relevant base (payroll), or a fixed floor.
  target_months numeric(5,2),
  target_fixed  numeric(16,2) not null default 0,
  -- % of each receipt to sweep into this reserve (payroll reserve, typically).
  auto_sweep_pct numeric(5,2) not null default 0,
  active        boolean not null default true,
  unique (company_id, reserve_type)
);

drop trigger if exists trg_aaa_reserve_policies_fill_company on public.reserve_policies;
create trigger trg_aaa_reserve_policies_fill_company
  before insert on public.reserve_policies
  for each row execute function public.fill_company_id();

alter table public.reserve_policies enable row level security;
drop policy if exists "ssa_all" on public.reserve_policies;
create policy "ssa_all" on public.reserve_policies for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.reserve_policies;
create policy "company_members" on public.reserve_policies for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Defaults: payroll >= 1 month; others start at 0 (set as policy dictates).
insert into public.reserve_policies (company_id, reserve_type, target_months)
select c.id, 'payroll', 1
  from public.companies c
 where not exists (select 1 from public.reserve_policies p
                    where p.company_id = c.id and p.reserve_type = 'payroll');
insert into public.reserve_policies (company_id, reserve_type)
select c.id, t.rt::public.reserve_type
  from public.companies c
  cross join (values ('statutory'),('bonus'),('asset_replacement'),('emergency')) as t(rt)
 where not exists (select 1 from public.reserve_policies p
                    where p.company_id = c.id and p.reserve_type = t.rt::public.reserve_type);

-- reserve_type -> account system_key
create or replace function public.reserve_account_key(p_type public.reserve_type)
returns text language sql immutable set search_path = public as $$
  select case p_type
    when 'payroll' then 'payroll_reserve'
    when 'statutory' then 'statutory_reserve'
    when 'bonus' then 'bonus_reserve'
    when 'asset_replacement' then 'asset_replacement_reserve'
    when 'emergency' then 'emergency_reserve'
  end;
$$;

-- ===========================================================================
-- 3. Targets, computed from live data.
-- ===========================================================================

-- Average monthly net payroll over the last 3 disbursed months.
create or replace function public.avg_monthly_net_payroll(p_company_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(round(sum(net_salary) / 3.0, 2), 0)
    from public.payslips
   where company_id = p_company_id and disbursed
     and period_month >= (date_trunc('month', current_date) - interval '3 months')::date;
$$;

create or replace function public.reserve_target(p_company_id uuid, p_type public.reserve_type)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare p record; v_bal numeric;
begin
  select * into p from public.reserve_policies
   where company_id = p_company_id and reserve_type = p_type;

  if p_type = 'payroll' then
    return round(public.avg_monthly_net_payroll(p_company_id) * coalesce(p.target_months, 1), 2);
  elsif p_type = 'statutory' then
    -- Outstanding statutory liabilities (what we hold for others).
    select coalesce(sum(jl.credit - jl.debit), 0) into v_bal
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id
       and a.system_key in ('eobi_payable', 'wht_payable');
    return greatest(v_bal, coalesce(p.target_fixed, 0));
  elsif p_type = 'bonus' then
    -- Bonus provision balance (§9.3).
    select coalesce(sum(jl.credit - jl.debit), 0) into v_bal
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id and a.system_key = 'bonus_provision';
    return v_bal;
  elsif p_type = 'asset_replacement' then
    -- Accumulated depreciation to date (money you'll need to replace assets).
    select coalesce(sum(jl.credit - jl.debit), 0) into v_bal
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id and a.system_key = 'accum_dep';
    return v_bal;
  else
    return coalesce(p.target_fixed, 0);  -- emergency
  end if;
end;
$$;

-- ===========================================================================
-- 4. Fund a reserve (Dr reserve / Cr bank), region-tagged to head office.
-- ===========================================================================

create or replace function public.fund_reserve(
  p_company_id uuid, p_type public.reserve_type, p_amount numeric, p_date date default current_date)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_ho uuid := public.head_office_region(p_company_id); v_entry uuid;
begin
  if p_amount is null or p_amount = 0 then return null; end if;
  v_entry := public.post_journal(
    p_company_id, p_date,
    'Reserve funding (' || p_type || ')',
    'reserve_funding', gen_random_uuid(), false,
    jsonb_build_array(
      jsonb_build_object('key', public.reserve_account_key(p_type), 'debit', p_amount, 'credit', 0),
      jsonb_build_object('key', 'bank', 'debit', 0, 'credit', p_amount)),
    v_ho);
  return v_entry;
end;
$$;

-- §9.4: mirror a month's depreciation into the asset-replacement reserve.
create or replace function public.mirror_depreciation_to_reserve(p_company_id uuid, p_period date)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_month date := date_trunc('month', p_period)::date; v_amount numeric;
begin
  select coalesce(sum(amount), 0) into v_amount
    from public.depreciation_entries
   where company_id = p_company_id and period_month = v_month;
  if v_amount <= 0 then return 0; end if;
  perform public.fund_reserve(p_company_id, 'asset_replacement', v_amount,
                              (v_month + interval '1 month - 1 day')::date);
  return v_amount;
end;
$$;

-- Sweep a % of a receipt into the payroll reserve (spec §9.2 optional).
create or replace function public.sweep_receipt_to_reserve(p_company_id uuid, p_receipt_amount numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare p record; v_sweep numeric;
begin
  select * into p from public.reserve_policies
   where company_id = p_company_id and reserve_type = 'payroll';
  if p.auto_sweep_pct is null or p.auto_sweep_pct = 0 then return 0; end if;
  v_sweep := round(coalesce(p_receipt_amount,0) * p.auto_sweep_pct / 100.0, 2);
  if v_sweep <= 0 then return 0; end if;
  perform public.fund_reserve(p_company_id, 'payroll', v_sweep);
  return v_sweep;
end;
$$;

-- ===========================================================================
-- 5. Balances vs targets — the reserves panel + cash-cockpit input.
-- ===========================================================================

create or replace view public.reserve_status
  with (security_invoker = true) as
  select c.id as company_id,
         rt.reserve_type,
         coalesce((
           select sum(jl.debit - jl.credit)
             from public.journal_lines jl
             join public.journal_entries je on je.id = jl.journal_entry_id
             join public.chart_of_accounts a on a.id = jl.account_id
            where je.company_id = c.id
              and a.system_key = public.reserve_account_key(rt.reserve_type)), 0) as balance,
         public.reserve_target(c.id, rt.reserve_type) as target,
         public.reserve_target(c.id, rt.reserve_type)
           - coalesce((
           select sum(jl.debit - jl.credit)
             from public.journal_lines jl
             join public.journal_entries je on je.id = jl.journal_entry_id
             join public.chart_of_accounts a on a.id = jl.account_id
            where je.company_id = c.id
              and a.system_key = public.reserve_account_key(rt.reserve_type)), 0) as shortfall
    from public.companies c
    cross join (select unnest(enum_range(null::public.reserve_type)) as reserve_type) rt;
