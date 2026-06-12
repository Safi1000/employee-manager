-- Fix: company creation by an SSA fails with
--   "new row violates row-level security policy for table chart_of_accounts"
--
-- Root cause: the Chart of Accounts seed (Sprint 4a, migration 0039) runs from
-- an AFTER INSERT trigger on companies but was NOT declared SECURITY DEFINER,
-- unlike the other two company seeds (seed_company_defaults in 0002 and
-- seed_head_office in 0017). It therefore executes under the caller's RLS
-- context. The ssa_all policy on chart_of_accounts only permits the write when
-- is_ssa_unscoped() is true (view_as_company IS NULL); whenever the SSA has a
-- lingering "view as company" scope set, the seed INSERT is rejected and the
-- whole company-creation transaction rolls back.
--
-- System seeding must not depend on the caller's tenant scope. Re-declare both
-- the seed function and its trigger wrapper as SECURITY DEFINER so they bypass
-- RLS, consistent with the other company seed functions. Bodies are otherwise
-- unchanged.

create or replace function public.seed_chart_of_accounts(p_company_id uuid)
returns void language plpgsql security definer set search_path = public as $$
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

create or replace function public.auto_seed_coa_on_company_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_chart_of_accounts(new.id);
  return new;
end;
$$;

-- Backfill: seed any existing companies that ended up without a CoA (e.g.
-- created via a path that previously failed and was worked around).
do $$
declare
  c record;
begin
  for c in
    select id from public.companies co
    where not exists (
      select 1 from public.chart_of_accounts coa where coa.company_id = co.id
    )
  loop
    perform public.seed_chart_of_accounts(c.id);
  end loop;
end$$;
