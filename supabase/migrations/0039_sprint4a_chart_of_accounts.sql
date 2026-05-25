-- Sprint 4 — Part A: Chart of Accounts + Trial Balance foundation.
-- Spec section 8.1–8.3. Builds an editable CoA that's user-visible. The Trial
-- Balance and General Ledger derive balances from existing transactions
-- (invoices, payments, expenses, payslips, bank_transactions) without
-- requiring a full double-entry shadow journal yet — that's a separate
-- Sprint 5 item.

-- ---------------------------------------------------------------------------
-- 1. Account types and normal sides
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'account_type') then
    create type account_type as enum ('asset', 'liability', 'equity', 'revenue', 'expense');
  end if;
  if not exists (select 1 from pg_type where typname = 'account_normal_side') then
    create type account_normal_side as enum ('debit', 'credit');
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 2. Chart of Accounts table
-- account_code is per-company unique. system_account = true rows are seeded
-- defaults that drive the auto-derived Trial Balance and cannot be deleted
-- (renaming and re-coding is still allowed).
-- ---------------------------------------------------------------------------
create table if not exists public.chart_of_accounts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  account_code      text not null,
  account_name      text not null,
  account_type      account_type not null,
  normal_side       account_normal_side not null,
  parent_id         uuid references public.chart_of_accounts(id) on delete set null,
  -- system_key identifies the account that the derived TB maps a given
  -- transaction type to (e.g. 'cash', 'bank', 'ar', 'revenue_security',
  -- 'expense_payroll'). Nullable for user-added custom accounts.
  system_key        text,
  system_account    boolean not null default false,
  active            boolean not null default true,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, account_code)
);

create index if not exists idx_coa_company on public.chart_of_accounts(company_id);
create index if not exists idx_coa_type on public.chart_of_accounts(account_type);
create index if not exists idx_coa_system_key on public.chart_of_accounts(company_id, system_key);

drop trigger if exists trg_aaa_coa_fill_company on public.chart_of_accounts;
create trigger trg_aaa_coa_fill_company
  before insert on public.chart_of_accounts
  for each row execute function public.fill_company_id();

drop trigger if exists trg_coa_updated_at on public.chart_of_accounts;
create trigger trg_coa_updated_at
  before update on public.chart_of_accounts
  for each row execute function public.touch_updated_at();

alter table public.chart_of_accounts enable row level security;
drop policy if exists "ssa_all" on public.chart_of_accounts;
create policy "ssa_all" on public.chart_of_accounts for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.chart_of_accounts;
create policy "company_members" on public.chart_of_accounts for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 3. Seed function: populate a company's CoA with the standard
-- security-services account structure, idempotent.
-- ---------------------------------------------------------------------------
create or replace function public.seed_chart_of_accounts(p_company_id uuid)
returns void language plpgsql as $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.chart_of_accounts where company_id = p_company_id;
  if v_count > 0 then
    return;
  end if;

  insert into public.chart_of_accounts (company_id, account_code, account_name, account_type, normal_side, system_key, system_account)
  values
    -- Assets (1xxx)
    (p_company_id, '1000', 'Cash in Hand',           'asset',     'debit',  'cash',                true),
    (p_company_id, '1010', 'Bank Accounts',          'asset',     'debit',  'bank',                true),
    (p_company_id, '1100', 'Accounts Receivable',    'asset',     'debit',  'ar',                  true),
    (p_company_id, '1200', 'Inventory — Weapons',    'asset',     'debit',  'inventory_weapons',   true),
    (p_company_id, '1210', 'Inventory — Uniforms',   'asset',     'debit',  'inventory_uniforms',  true),
    -- Liabilities (2xxx)
    (p_company_id, '2000', 'Accounts Payable',       'liability', 'credit', 'ap',                  true),
    (p_company_id, '2100', 'Salaries Payable',       'liability', 'credit', 'salaries_payable',    true),
    (p_company_id, '2200', 'Withholding Tax Payable','liability', 'credit', 'wht_payable',         true),
    (p_company_id, '2300', 'EOBI Payable',           'liability', 'credit', 'eobi_payable',        true),
    -- Equity (3xxx)
    (p_company_id, '3000', 'Owner''s Equity',         'equity',    'credit', 'equity',              true),
    (p_company_id, '3100', 'Retained Earnings',      'equity',    'credit', 'retained_earnings',   true),
    -- Revenue (4xxx)
    (p_company_id, '4000', 'Security Services Revenue','revenue', 'credit', 'revenue_security',    true),
    (p_company_id, '4100', 'Guard Deployment Revenue','revenue',  'credit', 'revenue_guard',       true),
    -- Cost of Services (5xxx)
    (p_company_id, '5000', 'Guard Payroll & Salaries','expense', 'debit',  'cos_payroll',          true),
    (p_company_id, '5100', 'Guard Statutory (EOBI/IESSI/PESSI)','expense','debit','cos_statutory', true),
    (p_company_id, '5200', 'Transportation & Fuel',  'expense',   'debit',  'cos_transport',       true),
    (p_company_id, '5300', 'Equipment & Supplies',   'expense',   'debit',  'cos_equipment',       true),
    (p_company_id, '5900', 'Other Cost of Services', 'expense',   'debit',  'cos_other',           true),
    -- Operating Expenses (6xxx)
    (p_company_id, '6000', 'Office Salaries',        'expense',   'debit',  'opex_office_payroll', true),
    (p_company_id, '6100', 'Utilities & Rent (HQ)',  'expense',   'debit',  'opex_utilities',      true),
    (p_company_id, '6200', 'Insurance',              'expense',   'debit',  'opex_insurance',      true),
    (p_company_id, '6300', 'Licences (company-level)','expense', 'debit',  'opex_licences',       true),
    (p_company_id, '6900', 'Other Operating Expenses','expense', 'debit',  'opex_other',          true),
    -- Below the line
    (p_company_id, '7000', 'Income Tax',             'expense',   'debit',  'income_tax',          true)
  on conflict (company_id, account_code) do nothing;
end;
$$;

-- Seed all existing companies right now.
do $$
declare
  c record;
begin
  for c in select id from public.companies loop
    perform public.seed_chart_of_accounts(c.id);
  end loop;
end$$;

-- Auto-seed for any new company created from now on.
create or replace function public.auto_seed_coa_on_company_insert()
returns trigger language plpgsql as $$
begin
  perform public.seed_chart_of_accounts(new.id);
  return new;
end;
$$;

drop trigger if exists trg_companies_seed_coa on public.companies;
create trigger trg_companies_seed_coa
  after insert on public.companies
  for each row execute function public.auto_seed_coa_on_company_insert();
