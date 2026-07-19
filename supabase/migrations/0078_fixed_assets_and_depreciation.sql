-- Asset register & capitalisation (spec section 4.1).
--
-- "stop expensing capital purchases". Today a vehicle bought for cash hits
-- an expense account and vanishes; the balance sheet never shows it and the
-- P&L takes the whole hit in one month. This adds the register, the
-- capitalisation posting, a straight-line depreciation run, and disposal.
--
-- Why a new table rather than extending inventory_items: inventory_items
-- tracks quantity/serial/status for consumable stock and issuable kit, and has
-- no cost at all. Section 4.1 itself treats bulk uniforms as INVENTORY
-- (Dr Inventory / Cr Bank, expensed on issue) — a different lifecycle from a
-- depreciating vehicle. Mixing them would make every inventory screen learn a
-- distinction it does not care about.
--
-- Region: an asset carries its own region and its depreciation posts there
-- (spec §4.1: "region (inherited to that region's P&L for depreciation)").

-- ---------------------------------------------------------------------------
-- 1. Chart of accounts additions
-- ---------------------------------------------------------------------------

-- Accumulated Depreciation is a contra-asset: an asset account whose normal
-- side is credit. It nets against cost rather than living under liabilities.
insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side,
   system_key, system_account, active)
select c.id, v.code, v.name, v.atype::public.account_type,
       v.side::public.account_normal_side, v.key, true, true
  from public.companies c
  cross join (values
    ('1300', 'Fixed Assets - Weapons',            'asset',     'debit',  'fa_weapons'),
    ('1310', 'Fixed Assets - Vehicles',           'asset',     'debit',  'fa_vehicles'),
    ('1320', 'Fixed Assets - Equipment',          'asset',     'debit',  'fa_equipment'),
    ('1330', 'Fixed Assets - Furniture & Fixtures','asset',    'debit',  'fa_furniture'),
    ('1340', 'Fixed Assets - IT Equipment',       'asset',     'debit',  'fa_it'),
    ('1395', 'Accumulated Depreciation',          'asset',     'credit', 'accum_dep'),
    ('4200', 'Gain on Disposal of Assets',        'revenue',   'credit', 'gain_disposal'),
    ('6400', 'Depreciation Expense',              'expense',   'debit',  'dep_expense'),
    ('6800', 'Loss on Disposal of Assets',        'expense',   'debit',  'loss_disposal')
  ) as v(code, name, atype, side, key)
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.system_key = v.key
 );

-- ---------------------------------------------------------------------------
-- 2. Register
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.fixed_asset_category as enum
    ('weapons', 'vehicles', 'equipment', 'furniture', 'it_equipment');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.fixed_asset_status as enum ('active', 'disposed', 'written_off');
exception when duplicate_object then null; end $$;

-- Straight-line only, per spec. An enum (not a bare text) so adding reducing
-- balance later is a migration, not a guessing game about stored strings.
do $$ begin
  create type public.depreciation_method as enum ('straight_line');
exception when duplicate_object then null; end $$;

create table if not exists public.fixed_assets (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies(id) on delete cascade,
  branch_id                uuid references public.branches(id),
  asset_code               text,
  name                     text not null,
  category                 public.fixed_asset_category not null,
  serial_number            text,
  acquisition_date         date not null,
  cost                     numeric(16,2) not null check (cost > 0),
  salvage_value            numeric(16,2) not null default 0 check (salvage_value >= 0),
  depreciation_method      public.depreciation_method not null default 'straight_line',
  useful_life_months       integer not null check (useful_life_months > 0),
  -- Maintained by a trigger off depreciation_entries — never written by hand,
  -- so it cannot drift from the ledger.
  accumulated_depreciation numeric(16,2) not null default 0,
  net_book_value           numeric(16,2)
                             generated always as (cost - accumulated_depreciation) stored,
  status                   public.fixed_asset_status not null default 'active',
  -- How the purchase was settled, for the capitalisation credit.
  payment_mode             text not null default 'Bank',
  bank_account_id          uuid references public.bank_accounts(id),
  disposal_date            date,
  disposal_proceeds        numeric(16,2),
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint salvage_below_cost check (salvage_value < cost)
);

create index if not exists idx_fa_company  on public.fixed_assets(company_id);
create index if not exists idx_fa_branch   on public.fixed_assets(branch_id);
create index if not exists idx_fa_status   on public.fixed_assets(company_id, status);

-- One depreciation charge per asset per month. The unique constraint is what
-- makes the monthly run idempotent — a re-run inserts nothing and therefore
-- posts nothing, so double-charging is impossible rather than merely unlikely.
create table if not exists public.depreciation_entries (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  asset_id     uuid not null references public.fixed_assets(id) on delete cascade,
  branch_id    uuid references public.branches(id),
  period_month date not null,
  amount       numeric(16,2) not null check (amount > 0),
  created_at   timestamptz not null default now(),
  unique (asset_id, period_month)
);

create index if not exists idx_dep_company_period
  on public.depreciation_entries(company_id, period_month);

-- ---------------------------------------------------------------------------
-- 3. Plumbing: company_id autofill + RLS, matching every other table here.
-- ---------------------------------------------------------------------------

drop trigger if exists trg_aaa_fa_fill_company on public.fixed_assets;
create trigger trg_aaa_fa_fill_company
  before insert on public.fixed_assets
  for each row execute function public.fill_company_id();

drop trigger if exists trg_aaa_dep_fill_company on public.depreciation_entries;
create trigger trg_aaa_dep_fill_company
  before insert on public.depreciation_entries
  for each row execute function public.fill_company_id();

alter table public.fixed_assets enable row level security;
drop policy if exists "ssa_all" on public.fixed_assets;
create policy "ssa_all" on public.fixed_assets for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.fixed_assets;
create policy "company_members" on public.fixed_assets for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

alter table public.depreciation_entries enable row level security;
drop policy if exists "ssa_all" on public.depreciation_entries;
create policy "ssa_all" on public.depreciation_entries for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.depreciation_entries;
create policy "company_members" on public.depreciation_entries for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 4. Region inheritance (spec §1). An asset has no parent object to inherit
--    from, so an explicit region stands; otherwise it is a head-office asset.
-- ---------------------------------------------------------------------------

create or replace function public.inherit_region_fixed_asset()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(new.branch_id, public.head_office_region(new.company_id));
  return new;
end;
$$;

drop trigger if exists trg_bbb_fixed_assets_region on public.fixed_assets;
create trigger trg_bbb_fixed_assets_region
  before insert or update of company_id on public.fixed_assets
  for each row execute function public.inherit_region_fixed_asset();

-- ---------------------------------------------------------------------------
-- 5. Category → asset account
-- ---------------------------------------------------------------------------

create or replace function public.fa_coa_key(p_category public.fixed_asset_category)
returns text language sql immutable set search_path = public as $$
  select case p_category
    when 'weapons'      then 'fa_weapons'
    when 'vehicles'     then 'fa_vehicles'
    when 'equipment'    then 'fa_equipment'
    when 'furniture'    then 'fa_furniture'
    when 'it_equipment' then 'fa_it'
  end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Capitalisation: Dr Fixed Asset / Cr Bank|Cash|AP.
--    This is the posting that stops capital purchases being expensed.
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_fixed_asset()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_cr_key text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'fixed_assets', old.id, old.acquisition_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.cost is distinct from new.cost
       or old.category is distinct from new.category
       or old.payment_mode is distinct from new.payment_mode
       or old.branch_id is distinct from new.branch_id then
      perform public.reverse_journal_for_source(new.company_id, 'fixed_assets', new.id, old.acquisition_date);
    else
      return new;
    end if;
  end if;

  v_cr_key := case
    when new.payment_mode = 'Cash' then 'cash'
    when new.payment_mode in ('Bank', 'Cheque') then 'bank'
    else 'ap'
  end;

  perform public.post_journal(
    new.company_id, new.acquisition_date,
    'Asset purchase — ' || new.name,
    'fixed_assets', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', public.fa_coa_key(new.category), 'debit', new.cost, 'credit', 0),
      jsonb_build_object('key', v_cr_key,                        'debit', 0,        'credit', new.cost)
    ),
    new.branch_id
  );
  return new;
end;
$$;

drop trigger if exists trg_yyy_fixed_assets_journal on public.fixed_assets;
create trigger trg_yyy_fixed_assets_journal
  after insert or update or delete on public.fixed_assets
  for each row execute function public.journal_on_fixed_asset();

-- ---------------------------------------------------------------------------
-- 7. Keep accumulated_depreciation in step with the depreciation entries.
-- ---------------------------------------------------------------------------

create or replace function public.sync_accumulated_depreciation()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_asset uuid;
begin
  v_asset := coalesce(new.asset_id, old.asset_id);
  update public.fixed_assets fa
     set accumulated_depreciation = coalesce((
           select sum(d.amount) from public.depreciation_entries d
            where d.asset_id = v_asset
         ), 0),
         updated_at = now()
   where fa.id = v_asset;
  return null;
end;
$$;

drop trigger if exists trg_dep_sync_accum on public.depreciation_entries;
create trigger trg_dep_sync_accum
  after insert or update or delete on public.depreciation_entries
  for each row execute function public.sync_accumulated_depreciation();

-- ---------------------------------------------------------------------------
-- 8. Monthly depreciation run: Dr Depreciation Expense / Cr Accumulated Dep,
--    straight-line, batched over all active assets, tagged to each asset's
--    region so it lands in that region's P&L.
--
--    Safe to re-run: the unique (asset_id, period_month) index means a second
--    run inserts nothing and posts nothing. Returns rows charged.
-- ---------------------------------------------------------------------------

create or replace function public.run_depreciation(
  p_company_id uuid,
  p_period     date
)
returns integer language plpgsql security definer set search_path = public as $$
declare
  r          record;
  v_month    date := date_trunc('month', p_period)::date;
  v_monthly  numeric;
  v_remain   numeric;
  v_amount   numeric;
  v_entry_id uuid;
  v_count    integer := 0;
begin
  for r in
    select fa.* from public.fixed_assets fa
     where fa.company_id = p_company_id
       and fa.status = 'active'
       -- Depreciation starts in the month of acquisition, and never runs for
       -- a month before the asset existed.
       and date_trunc('month', fa.acquisition_date)::date <= v_month
  loop
    -- Reset at the top, not after a successful post: every `continue` below
    -- would otherwise have to remember to clear it, and one that forgot would
    -- silently re-post the previous asset's charge.
    v_entry_id := null;

    v_monthly := round((r.cost - r.salvage_value) / r.useful_life_months, 2);
    -- Never depreciate past salvage value, and let the final month absorb the
    -- rounding remainder rather than leaving a few paisa on the books forever.
    v_remain  := (r.cost - r.salvage_value) - r.accumulated_depreciation;
    v_amount  := least(v_monthly, v_remain);

    if v_amount is null or v_amount <= 0 then
      continue;
    end if;

    insert into public.depreciation_entries
      (company_id, asset_id, branch_id, period_month, amount)
    values (r.company_id, r.id, r.branch_id, v_month, v_amount)
    on conflict (asset_id, period_month) do nothing
    returning id into v_entry_id;

    if v_entry_id is null then
      continue;  -- already charged for this month
    end if;

    perform public.post_journal(
      r.company_id, (v_month + interval '1 month - 1 day')::date,
      'Depreciation — ' || r.name || ' — ' || to_char(v_month, 'YYYY-MM'),
      'depreciation_entries', v_entry_id, false,
      jsonb_build_array(
        jsonb_build_object('key', 'dep_expense', 'debit', v_amount, 'credit', 0),
        jsonb_build_object('key', 'accum_dep',   'debit', 0,        'credit', v_amount)
      ),
      r.branch_id
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Disposal: remove cost & accumulated depreciation, gain/loss to P&L.
--
--    Dr Accumulated Depreciation  (everything charged to date)
--    Dr Cash/Bank                 (proceeds, if any)
--    Cr Fixed Asset               (original cost — off the books)
--    ...and the plug is the gain (Cr) or loss (Dr) versus net book value.
-- ---------------------------------------------------------------------------

create or replace function public.dispose_fixed_asset(
  p_asset_id      uuid,
  p_disposal_date date,
  p_proceeds      numeric default 0,
  p_payment_mode  text default 'Bank'
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  r        record;
  v_nbv    numeric;
  v_gain   numeric;
  v_dr_key text;
  v_lines  jsonb;
begin
  select * into r from public.fixed_assets where id = p_asset_id;
  if not found then
    raise exception 'fixed asset % not found', p_asset_id using errcode = '23503';
  end if;
  if r.status <> 'active' then
    raise exception 'fixed asset % is already %', p_asset_id, r.status using errcode = '23514';
  end if;

  v_nbv  := r.cost - r.accumulated_depreciation;
  v_gain := coalesce(p_proceeds, 0) - v_nbv;

  v_dr_key := case
    when p_payment_mode = 'Cash' then 'cash'
    when p_payment_mode in ('Bank', 'Cheque') then 'bank'
    else 'ar'
  end;

  v_lines := jsonb_build_array(
    jsonb_build_object('key', 'accum_dep', 'debit', r.accumulated_depreciation, 'credit', 0),
    jsonb_build_object('key', v_dr_key,    'debit', coalesce(p_proceeds, 0),    'credit', 0),
    jsonb_build_object('key', public.fa_coa_key(r.category), 'debit', 0, 'credit', r.cost)
  );

  if v_gain > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('key', 'gain_disposal', 'debit', 0, 'credit', v_gain));
  elsif v_gain < 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('key', 'loss_disposal', 'debit', -v_gain, 'credit', 0));
  end if;

  perform public.post_journal(
    r.company_id, p_disposal_date,
    'Asset disposal — ' || r.name,
    'fixed_assets_disposal', r.id, false,
    v_lines,
    r.branch_id
  );

  update public.fixed_assets
     set status = 'disposed',
         disposal_date = p_disposal_date,
         disposal_proceeds = coalesce(p_proceeds, 0),
         updated_at = now()
   where id = p_asset_id;

  return p_asset_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Register view with the region name attached, for the assets screen.
-- ---------------------------------------------------------------------------

create or replace view public.fixed_assets_register
  with (security_invoker = true) as
  select fa.*,
         b.name as region_name,
         b.code as region_code,
         case when fa.useful_life_months > 0
              then round((fa.cost - fa.salvage_value) / fa.useful_life_months, 2)
         end as monthly_depreciation
    from public.fixed_assets fa
    left join public.branches b on b.id = fa.branch_id;
