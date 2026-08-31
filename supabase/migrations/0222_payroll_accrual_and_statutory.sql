-- 0222 — Phase 1 Part C: payroll accrual, statutory deductions, employer EOBI.
--
-- Implements A5 (two-step accrual), A6 (final_salary = gross expense,
-- net_salary = cash), A7 (advance recovery), §5.1 (EOBI is an EMPLOYEE
-- deduction; the employer share is a separate, previously missing cost) and
-- §5.2 (salary tax withheld is a liability, not company income tax expense).
--
-- The payslip identity, verified on 48/48 sandbox rows and preserved here:
--     net_salary = final_salary - advance - eobi - income_tax
-- so Salaries Payable nets to exactly zero per payslip once accrual,
-- deductions and disbursement have all posted.
--
-- Defects corrected, measured against sandbox before the fix:
--   * EOBI double-counted as employer cost   Rs 15,540.00
--   * Salary tax routed to income_tax expense Rs    651.00
--   * Payroll recognised on a basis that was neither cash nor accrual (40 entries)

-- ---------------------------------------------------------------------------
-- §5.2 — Salary tax withheld is owed to FBR, not company income tax expense.
-- §5.1 — Employer EOBI share, absent from the system entirely.
-- ---------------------------------------------------------------------------

create or replace function public.seed_chart_of_accounts(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side, system_key, system_account, is_control)
  values
    (p_company_id, '2450', 'Salary Tax Payable (FBR)', 'liability', 'credit', 'salary_tax_payable', true, false)
  on conflict (company_id, account_code) do nothing;
end;
$function$;

do $$
declare c record;
begin
  for c in select id from public.companies loop
    perform public.seed_chart_of_accounts(c.id);
  end loop;
end $$;

-- Restore the full seed (the narrow version above was only a delivery vehicle
-- for the new account; keep one canonical definition).
create or replace function public.seed_chart_of_accounts(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side, system_key, system_account, is_control)
  values
    (p_company_id, '1000', 'Cash in Hand',                    'asset',     'debit',  'cash',                          true, true),
    (p_company_id, '1010', 'Bank Accounts',                   'asset',     'debit',  'bank',                          true, true),
    (p_company_id, '1100', 'Accounts Receivable',             'asset',     'debit',  'ar',                            true, true),
    (p_company_id, '1110', 'Employee Advances Receivable',    'asset',     'debit',  'employee_advances_receivable',  true, true),
    (p_company_id, '1150', 'Withholding Tax Receivable',      'asset',     'debit',  'wht_receivable',                true, false),
    (p_company_id, '1200', 'Inventory — Weapons',             'asset',     'debit',  'inventory_weapons',             true, false),
    (p_company_id, '1210', 'Inventory — Uniforms',            'asset',     'debit',  'inventory_uniforms',            true, false),
    (p_company_id, '1300', 'Inter-Region Receivable',         'asset',     'debit',  'interregion_receivable',        true, false),
    (p_company_id, '1400', 'Fixed Assets — Weapons',          'asset',     'debit',  'fa_weapons',                    true, false),
    (p_company_id, '1410', 'Fixed Assets — Vehicles',         'asset',     'debit',  'fa_vehicles',                   true, false),
    (p_company_id, '1420', 'Fixed Assets — Equipment',        'asset',     'debit',  'fa_equipment',                  true, false),
    (p_company_id, '1430', 'Fixed Assets — Furniture',        'asset',     'debit',  'fa_furniture',                  true, false),
    (p_company_id, '1440', 'Fixed Assets — IT Equipment',     'asset',     'debit',  'fa_it',                         true, false),
    (p_company_id, '1490', 'Accumulated Depreciation',        'asset',     'credit', 'accum_dep',                     true, false),
    (p_company_id, '1500', 'Payroll Reserve',                 'asset',     'debit',  'payroll_reserve',               true, false),
    (p_company_id, '1510', 'Statutory Reserve',               'asset',     'debit',  'statutory_reserve',             true, false),
    (p_company_id, '1520', 'Bonus Reserve',                   'asset',     'debit',  'bonus_reserve',                 true, false),
    (p_company_id, '1530', 'Asset Replacement Reserve',       'asset',     'debit',  'asset_replacement_reserve',     true, false),
    (p_company_id, '1540', 'Emergency Reserve',               'asset',     'debit',  'emergency_reserve',             true, false),
    (p_company_id, '2000', 'Accounts Payable',                'liability', 'credit', 'ap',                            true, true),
    (p_company_id, '2100', 'Salaries Payable',                'liability', 'credit', 'salaries_payable',              true, true),
    (p_company_id, '2200', 'Withholding Tax Payable',         'liability', 'credit', 'wht_payable',                   true, false),
    (p_company_id, '2300', 'EOBI Payable',                    'liability', 'credit', 'eobi_payable',                  true, true),
    (p_company_id, '2400', 'Sales Tax Payable',               'liability', 'credit', 'sales_tax_payable',             true, false),
    (p_company_id, '2450', 'Salary Tax Payable (FBR)',        'liability', 'credit', 'salary_tax_payable',            true, false),
    (p_company_id, '2500', 'Inter-Region Payable',            'liability', 'credit', 'interregion_payable',           true, false),
    (p_company_id, '2600', 'Bonus Provision',                 'liability', 'credit', 'bonus_provision',               true, false),
    (p_company_id, '3000', 'Owner''s Equity',                 'equity',    'credit', 'equity',                        true, false),
    (p_company_id, '3100', 'Retained Earnings',               'equity',    'credit', 'retained_earnings',             true, false),
    (p_company_id, '3200', 'Opening Balance Equity',          'equity',    'credit', 'opening_balance_equity',        true, false),
    (p_company_id, '4000', 'Security Services Revenue',       'revenue',   'credit', 'revenue_security',              true, false),
    (p_company_id, '4100', 'Guard Deployment Revenue',        'revenue',   'credit', 'revenue_guard',                 true, false),
    (p_company_id, '4200', 'Gain on Asset Disposal',          'revenue',   'credit', 'gain_disposal',                 true, false),
    (p_company_id, '5000', 'Guard Payroll & Salaries',        'expense',   'debit',  'cos_payroll',                   true, false),
    (p_company_id, '5100', 'Guard Statutory (EOBI/IESSI/PESSI)','expense', 'debit',  'cos_statutory',                 true, false),
    (p_company_id, '5200', 'Transportation & Fuel',           'expense',   'debit',  'cos_transport',                 true, false),
    (p_company_id, '5300', 'Equipment & Supplies',            'expense',   'debit',  'cos_equipment',                 true, false),
    (p_company_id, '5900', 'Other Cost of Services',          'expense',   'debit',  'cos_other',                     true, false),
    (p_company_id, '6000', 'Office Salaries',                 'expense',   'debit',  'opex_office_payroll',           true, false),
    (p_company_id, '6100', 'Utilities & Rent (HQ)',           'expense',   'debit',  'opex_utilities',                true, false),
    (p_company_id, '6200', 'Insurance',                       'expense',   'debit',  'opex_insurance',                true, false),
    (p_company_id, '6300', 'Licences (company-level)',        'expense',   'debit',  'opex_licences',                 true, false),
    (p_company_id, '6400', 'Regional Partner Remuneration',   'expense',   'debit',  'regional_partner_remuneration', true, false),
    (p_company_id, '6500', 'Depreciation Expense',            'expense',   'debit',  'dep_expense',                   true, false),
    (p_company_id, '6600', 'Bonus Expense',                   'expense',   'debit',  'bonus_expense',                 true, false),
    (p_company_id, '6700', 'Loss on Asset Disposal',          'expense',   'debit',  'loss_disposal',                 true, false),
    (p_company_id, '6800', 'Allocated Head Office Cost',      'expense',   'debit',  'allocated_ho_cost',             true, false),
    (p_company_id, '6850', 'Head Office Cost Recovery',       'expense',   'credit', 'ho_cost_recovery',              true, false),
    (p_company_id, '6900', 'Other Operating Expenses',        'expense',   'debit',  'opex_other',                    true, false),
    (p_company_id, '7000', 'Income Tax',                      'expense',   'debit',  'income_tax',                    true, false)
  on conflict (company_id, account_code) do nothing;

  update public.chart_of_accounts
     set is_control = true
   where company_id = p_company_id
     and system_key in ('cash','bank','ar','ap','employee_advances_receivable',
                        'salaries_payable','eobi_payable')
     and is_control = false;
end;
$function$;

-- §5.1 item 2 — the employer contribution, previously recorded nowhere.
-- Deliberately NOT back-posted (per your instruction): historical periods stay
-- understated and are flagged rather than silently restated.
alter table public.payslips
  add column if not exists eobi_employer numeric(14,2) not null default 0;

comment on column public.payslips.eobi_employer is
  'Employer EOBI/SESSI/PESSI contribution — a cost of services direct to the client, NOT deducted from the guard. payslips.eobi is the separate employee 1% deduction. Zero on all rows before migration 0222; those periods are understated.';

-- ---------------------------------------------------------------------------
-- A5 / A6 / A7 / §5.1 / §5.2 — the payroll posting rules.
--
-- ACCRUAL (month end, regardless of disbursement), dated period_month:
--   Dr  Payroll Expense (COS or Opex by category)  = final_salary   (GROSS)
--   Dr  Cost of Services — Statutory               = eobi_employer  (employer share)
--     Cr  Salaries Payable                         = final_salary
--     Cr  EOBI Payable                             = eobi_employer
--   Dr  Salaries Payable = advance     Cr Employee Advances Receivable
--   Dr  Salaries Payable = eobi        Cr EOBI Payable          (employee 1%)
--   Dr  Salaries Payable = income_tax  Cr Salary Tax Payable    (FBR)
--
-- DISBURSEMENT, dated disbursed_at (cheque: clearance date):
--   Dr  Salaries Payable  = net_salary
--     Cr  Bank / Custodian Cash = net_salary
--
-- Salaries Payable therefore nets to zero per payslip.
-- The old rule's extra `Dr cos_statutory = eobi` is GONE — that was the
-- Rs 15,540 double count.
-- ---------------------------------------------------------------------------

create or replace function public.post_payslip_accrual(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  ps        record;
  v_cat     text;
  v_client  uuid;
  v_key     text;
  v_lines   jsonb;
  v_dim     jsonb;
begin
  select * into ps from public.payslips where id = p_id;
  if not found then return; end if;

  select e.category, e.client_id into v_cat, v_client
    from public.employees e where e.id = ps.employee_id;

  v_key := case when v_cat = 'office_staff' then 'opex_office_payroll' else 'cos_payroll' end;
  v_dim := jsonb_build_object('employee_id', ps.employee_id, 'client_id', v_client);

  v_lines := jsonb_build_array(
    v_dim || jsonb_build_object('key', v_key, 'debit', ps.final_salary, 'credit', 0),
    v_dim || jsonb_build_object('key', 'salaries_payable', 'debit', 0, 'credit', ps.final_salary)
  );

  -- Employer statutory share: a direct cost of the guard's client (A3).
  if coalesce(ps.eobi_employer, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      v_dim || jsonb_build_object('key', 'cos_statutory', 'debit', ps.eobi_employer, 'credit', 0),
      v_dim || jsonb_build_object('key', 'eobi_payable',  'debit', 0, 'credit', ps.eobi_employer));
  end if;

  -- A7: advance recovery clears the receivable; expense is untouched.
  if coalesce(ps.advance, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      v_dim || jsonb_build_object('key', 'salaries_payable', 'debit', ps.advance, 'credit', 0),
      v_dim || jsonb_build_object('key', 'employee_advances_receivable', 'debit', 0, 'credit', ps.advance));
  end if;

  -- §5.1: employee EOBI deduction (already inside final_salary).
  if coalesce(ps.eobi, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      v_dim || jsonb_build_object('key', 'salaries_payable', 'debit', ps.eobi, 'credit', 0),
      v_dim || jsonb_build_object('key', 'eobi_payable',     'debit', 0, 'credit', ps.eobi));
  end if;

  -- §5.2: salary tax withheld for FBR.
  if coalesce(ps.income_tax, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      v_dim || jsonb_build_object('key', 'salaries_payable',   'debit', ps.income_tax, 'credit', 0),
      v_dim || jsonb_build_object('key', 'salary_tax_payable', 'debit', 0, 'credit', ps.income_tax));
  end if;

  perform public.post_journal(
    ps.company_id, ps.period_month,
    'Payroll accrual — ' || left(ps.period_month::text, 7),
    'payslips', ps.id, false, v_lines, ps.branch_id);
end;
$function$;

create or replace function public.post_payslip_disbursement(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  ps       record;
  v_client uuid;
  v_date   date;
  v_cr     jsonb;
  v_dim    jsonb;
begin
  select * into ps from public.payslips where id = p_id;
  if not found or not ps.disbursed or coalesce(ps.net_salary, 0) = 0 then return; end if;

  select e.client_id into v_client from public.employees e where e.id = ps.employee_id;
  v_dim := jsonb_build_object('employee_id', ps.employee_id, 'client_id', v_client);

  -- Cash basis: cheque payments land when the cheque clears.
  v_date := case
    when ps.payment_mode = 'Cheque'
      then coalesce((select ch.cleared_at::date from public.cheques ch
                      where ch.id = ps.cheque_id and ch.status = 'cleared'),
                    ps.disbursed_at::date, ps.period_month)
    else coalesce(ps.disbursed_at::date, ps.period_month)
  end;

  v_cr := case
    when ps.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(ps.company_id, ps.cash_location_id),
      'debit', 0, 'credit', ps.net_salary)
    else jsonb_build_object('key', 'bank', 'debit', 0, 'credit', ps.net_salary)
  end;

  perform public.post_journal(
    ps.company_id, v_date,
    'Payroll disbursed — ' || left(ps.period_month::text, 7),
    'payslips_disbursement', ps.id, false,
    jsonb_build_array(
      v_dim || jsonb_build_object('key', 'salaries_payable', 'debit', ps.net_salary, 'credit', 0)
    ) || jsonb_build_array(v_dim || v_cr),
    ps.branch_id);
end;
$function$;

create or replace function public.journal_on_payslip()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'payslips', old.id, old.period_month);
    perform public.reverse_journal_for_source(old.company_id, 'payslips_disbursement', old.id,
              coalesce(old.disbursed_at::date, old.period_month));
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform public.post_payslip_accrual(new.id);
    if new.disbursed then perform public.post_payslip_disbursement(new.id); end if;
    return new;
  end if;

  -- Accrual re-posts only when an accrual input actually moved.
  if old.final_salary  is distinct from new.final_salary
     or old.advance    is distinct from new.advance
     or old.eobi       is distinct from new.eobi
     or old.income_tax is distinct from new.income_tax
     or coalesce(old.eobi_employer, 0) is distinct from coalesce(new.eobi_employer, 0)
     or old.period_month is distinct from new.period_month
     or old.employee_id  is distinct from new.employee_id
     or old.branch_id    is distinct from new.branch_id then
    perform public.reverse_journal_for_source(new.company_id, 'payslips', new.id, old.period_month);
    perform public.post_payslip_accrual(new.id);
  end if;

  -- Disbursement leg.
  if old.disbursed and not new.disbursed then
    perform public.reverse_journal_for_source(new.company_id, 'payslips_disbursement', new.id,
              coalesce(old.disbursed_at::date, old.period_month));
  elsif new.disbursed and (
          not old.disbursed
       or old.net_salary       is distinct from new.net_salary
       or old.payment_mode     is distinct from new.payment_mode
       or old.cash_location_id is distinct from new.cash_location_id
       or old.disbursed_at     is distinct from new.disbursed_at) then
    perform public.reverse_journal_for_source(new.company_id, 'payslips_disbursement', new.id,
              coalesce(old.disbursed_at::date, old.period_month));
    perform public.post_payslip_disbursement(new.id);
  end if;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Repost every existing payslip onto the new rules. The old entries carried
-- the EOBI double count and a basis that was neither cash nor accrual, so they
-- are reversed (not deleted — the audit trail stays) and re-posted.
-- ---------------------------------------------------------------------------

do $$
declare p record;
begin
  for p in select id, company_id, period_month, disbursed_at from public.payslips loop
    perform public.reverse_journal_for_source(p.company_id, 'payslips', p.id, p.period_month);
    perform public.reverse_journal_for_source(p.company_id, 'payslips_disbursement', p.id,
              coalesce(p.disbursed_at::date, p.period_month));
    perform public.post_payslip_accrual(p.id);
    perform public.post_payslip_disbursement(p.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Reconciliation: Salaries Payable must net to zero once a payslip has both
-- accrued and disbursed, and Employee Advances control must equal outstanding
-- advances net of payroll recovery.
-- ---------------------------------------------------------------------------

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric, difference numeric, passed boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with tb as (
    select coalesce(sum(jl.debit), 0) dr, coalesce(sum(jl.credit), 0) cr
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
     where je.company_id = p_company_id
  ),
  onesided as (
    select count(*)::numeric n
      from public.journal_entries je
      join lateral (
        select coalesce(sum(debit), 0) dr, coalesce(sum(credit), 0) cr
          from public.journal_lines where journal_entry_id = je.id
      ) x on true
     where je.company_id = p_company_id and x.dr <> x.cr
  ),
  bal as (
    select a.system_key, coalesce(sum(jl.debit - jl.credit), 0) net
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id
     group by a.system_key
  ),
  ar_sub as (
    select coalesce((select sum(i.invoice_amount) from public.invoices i
                      where i.company_id = p_company_id
                        and coalesce(i.status, '') <> 'Written-Off'), 0)
         - coalesce((select sum(p.amount + coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),
  adv_sub as (
    select coalesce((select sum(a.amount) from public.advances a
                      where a.company_id = p_company_id), 0)
         - coalesce((select sum(ps.advance) from public.payslips ps
                      where ps.company_id = p_company_id), 0) bal
  ),
  wht_sub as (
    select coalesce((select sum(coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),
  -- Salaries Payable = Σ(final − advance − eobi − income_tax) over all payslips
  --                  − Σ net_salary over disbursed ones.
  -- By the payslip identity that reduces to the net pay still owed, i.e. the
  -- net_salary of everything not yet disbursed.
  payroll_owed as (
    select coalesce(sum(ps.net_salary) filter (where not ps.disbursed), 0) owed
      from public.payslips ps where ps.company_id = p_company_id
  )
  select 'trial_balance_debits_equal_credits'::text, tb.dr, tb.cr, tb.dr - tb.cr, tb.dr = tb.cr from tb
  union all
  select 'no_one_sided_entries', 0, onesided.n, onesided.n, onesided.n = 0 from onesided
  union all
  select 'ar_control_equals_open_invoices', ar_sub.bal,
         coalesce((select net from bal where system_key = 'ar'), 0),
         coalesce((select net from bal where system_key = 'ar'), 0) - ar_sub.bal,
         coalesce((select net from bal where system_key = 'ar'), 0) = ar_sub.bal
    from ar_sub
  union all
  select 'employee_advances_control_not_in_client_ar', adv_sub.bal,
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0),
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0) - adv_sub.bal,
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0) = adv_sub.bal
    from adv_sub
  union all
  select 'wht_receivable_equals_deductions_less_cprs', wht_sub.bal,
         coalesce((select net from bal where system_key = 'wht_receivable'), 0),
         coalesce((select net from bal where system_key = 'wht_receivable'), 0) - wht_sub.bal,
         coalesce((select net from bal where system_key = 'wht_receivable'), 0) = wht_sub.bal
    from wht_sub
  union all
  select 'salaries_payable_equals_undisbursed_net_pay', payroll_owed.owed,
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0),
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0) - payroll_owed.owed,
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0) = payroll_owed.owed
    from payroll_owed;
$function$;

revoke all on function public.ledger_checks(uuid) from public;
grant execute on function public.ledger_checks(uuid) to authenticated;
