-- 0219 — Phase 1 Part B: repair the ledger foundation.
--
-- The ledger (0039–0106) has been a silent no-op in production since 0042:
-- both production companies have zero chart_of_accounts rows, and
-- post_journal() skips lines whose account key cannot be resolved instead of
-- failing. This migration makes the ledger incapable of silently losing a
-- posting, and seeds every account the live triggers actually reference.
--
-- Covers B1–B6 of the Phase 1 brief, plus the A7 advance-account defect
-- (required for reconciliation check 3 to pass).
--
-- Deliberately NOT in this migration (Part C): payroll accrual basis, WHT at
-- payment, sales tax split, AP settlement, profit-share posting, custody float.

-- ---------------------------------------------------------------------------
-- B3a. Control-account flag
-- ---------------------------------------------------------------------------

alter table public.chart_of_accounts
  add column if not exists is_control boolean not null default false;

comment on column public.chart_of_accounts.is_control is
  'Control account: its balance must equal the sum of its sub-ledger. Reconciled by ledger_checks().';

-- ---------------------------------------------------------------------------
-- B3b. Seed the chart of accounts completely and idempotently.
--
-- The old seed returned early when the company had any accounts at all, so
-- accounts added by later migrations never reached existing companies. It is
-- now per-account idempotent and safe to re-run.
--
-- Every system_key referenced anywhere in the codebase is seeded here. Without
-- this, B1's raising post_journal() would turn silent data loss into broken
-- INSERTs on depreciation, reserves, inter-region and bonus flows.
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
    -- Assets
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
    -- Reserves are earmarked cash: fund_reserve() posts Dr reserve / Cr bank.
    (p_company_id, '1500', 'Payroll Reserve',                 'asset',     'debit',  'payroll_reserve',               true, false),
    (p_company_id, '1510', 'Statutory Reserve',               'asset',     'debit',  'statutory_reserve',             true, false),
    (p_company_id, '1520', 'Bonus Reserve',                   'asset',     'debit',  'bonus_reserve',                 true, false),
    (p_company_id, '1530', 'Asset Replacement Reserve',       'asset',     'debit',  'asset_replacement_reserve',     true, false),
    (p_company_id, '1540', 'Emergency Reserve',               'asset',     'debit',  'emergency_reserve',             true, false),
    -- Liabilities
    (p_company_id, '2000', 'Accounts Payable',                'liability', 'credit', 'ap',                            true, true),
    (p_company_id, '2100', 'Salaries Payable',                'liability', 'credit', 'salaries_payable',              true, true),
    (p_company_id, '2200', 'Withholding Tax Payable',         'liability', 'credit', 'wht_payable',                   true, false),
    (p_company_id, '2300', 'EOBI Payable',                    'liability', 'credit', 'eobi_payable',                  true, false),
    (p_company_id, '2400', 'Sales Tax Payable',               'liability', 'credit', 'sales_tax_payable',             true, false),
    (p_company_id, '2500', 'Inter-Region Payable',            'liability', 'credit', 'interregion_payable',           true, false),
    (p_company_id, '2600', 'Bonus Provision',                 'liability', 'credit', 'bonus_provision',               true, false),
    -- Equity
    (p_company_id, '3000', 'Owner''s Equity',                 'equity',    'credit', 'equity',                        true, false),
    (p_company_id, '3100', 'Retained Earnings',               'equity',    'credit', 'retained_earnings',             true, false),
    (p_company_id, '3200', 'Opening Balance Equity',          'equity',    'credit', 'opening_balance_equity',        true, false),
    -- Revenue
    (p_company_id, '4000', 'Security Services Revenue',       'revenue',   'credit', 'revenue_security',              true, false),
    (p_company_id, '4100', 'Guard Deployment Revenue',        'revenue',   'credit', 'revenue_guard',                 true, false),
    (p_company_id, '4200', 'Gain on Asset Disposal',          'revenue',   'credit', 'gain_disposal',                 true, false),
    -- Cost of services
    (p_company_id, '5000', 'Guard Payroll & Salaries',        'expense',   'debit',  'cos_payroll',                   true, false),
    (p_company_id, '5100', 'Guard Statutory (EOBI/IESSI/PESSI)','expense', 'debit',  'cos_statutory',                 true, false),
    (p_company_id, '5200', 'Transportation & Fuel',           'expense',   'debit',  'cos_transport',                 true, false),
    (p_company_id, '5300', 'Equipment & Supplies',            'expense',   'debit',  'cos_equipment',                 true, false),
    (p_company_id, '5900', 'Other Cost of Services',          'expense',   'debit',  'cos_other',                     true, false),
    -- Operating expenses
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

  -- on conflict do nothing leaves pre-existing rows untouched, so stamp the
  -- control flag onto companies seeded before this migration.
  update public.chart_of_accounts
     set is_control = true
   where company_id = p_company_id
     and system_key in ('cash','bank','ar','ap','employee_advances_receivable','salaries_payable')
     and is_control = false;
end;
$function$;

-- Backfill every company, including the two production companies that have
-- had zero accounts since inception.
do $$
declare c record;
begin
  for c in select id from public.companies loop
    perform public.seed_chart_of_accounts(c.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- B4. Dimensions on journal lines.
--
-- branch_id was the only dimension, which is why no ledger-derived report can
-- produce a client-level or partner-level figure. Amounts stay numeric(16,2) —
-- exact decimal in Postgres, per the brief.
-- ---------------------------------------------------------------------------

alter table public.journal_lines
  add column if not exists client_id   uuid references public.clients(id)   on delete set null,
  add column if not exists employee_id uuid references public.employees(id) on delete set null,
  add column if not exists partner_id  uuid references public.partners(id)  on delete set null,
  add column if not exists contract_id uuid references public.contracts(id) on delete set null,
  add column if not exists cost_center text;

create index if not exists journal_lines_client_idx   on public.journal_lines(client_id)   where client_id   is not null;
create index if not exists journal_lines_employee_idx on public.journal_lines(employee_id) where employee_id is not null;
create index if not exists journal_lines_partner_idx  on public.journal_lines(partner_id)  where partner_id  is not null;
create index if not exists journal_lines_contract_idx on public.journal_lines(contract_id) where contract_id is not null;

-- ---------------------------------------------------------------------------
-- B5. Entry integrity: status, posting period, real reversal link.
-- ---------------------------------------------------------------------------

alter table public.journal_entries
  add column if not exists status              text,
  add column if not exists posting_period      date,
  add column if not exists reversal_of_entry_id uuid references public.journal_entries(id);

-- Backfill before the immutability trigger goes on.
update public.journal_entries
   set status = coalesce(status, 'posted'),
       posting_period = coalesce(posting_period, date_trunc('month', entry_date)::date)
 where status is null or posting_period is null;

-- Reversals were previously linked only by a description substring.
update public.journal_entries rev
   set reversal_of_entry_id = orig.id
  from public.journal_entries orig
 where rev.is_reversal
   and rev.reversal_of_entry_id is null
   and rev.description like '%(reversal of ' || orig.id::text || ')%';

update public.journal_entries orig
   set status = 'reversed'
 where status = 'posted'
   and exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = orig.id);

alter table public.journal_entries
  alter column status set default 'posted',
  alter column status set not null,
  alter column posting_period set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'journal_entries_status_chk') then
    alter table public.journal_entries
      add constraint journal_entries_status_chk check (status in ('draft','posted','reversed'));
  end if;
end $$;

create index if not exists journal_entries_period_idx on public.journal_entries(company_id, posting_period);

-- ---------------------------------------------------------------------------
-- B1 + B2. post_journal() fails loudly, balances, and carries dimensions.
-- ---------------------------------------------------------------------------

create or replace function public.post_journal(
  p_company_id uuid, p_date date, p_description text,
  p_source_table text, p_source_id uuid, p_is_reversal boolean,
  p_lines jsonb, p_region_id uuid default null::uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_entry_id uuid;
  v_line     jsonb;
  v_acct_id  uuid;
  v_key      text;
  v_debit    numeric;
  v_credit   numeric;
  v_region   uuid;
  v_any      boolean := false;
  v_user     uuid;
  v_dr_total numeric := 0;
  v_cr_total numeric := 0;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  p_region_id := coalesce(p_region_id, public.head_office_region(p_company_id));
  v_entry_id := gen_random_uuid();

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_debit  := coalesce((v_line->>'debit')::numeric, 0);
    v_credit := coalesce((v_line->>'credit')::numeric, 0);

    -- A zero-value line is a legitimate no-op (e.g. an invoice with no WHT).
    if v_debit = 0 and v_credit = 0 then continue; end if;

    v_key := v_line->>'key';
    v_acct_id := coalesce(
      nullif(v_line->>'account_id', '')::uuid,
      public.coa_id(p_company_id, v_key)
    );

    -- B1: never drop a line silently. This was the defect that made the whole
    -- ledger a no-op in production.
    if v_acct_id is null then
      raise exception
        'post_journal: cannot resolve account for company % (system_key=%, source=%/%). Seed the chart of accounts.',
        p_company_id, coalesce(v_key, '<null>'), p_source_table, p_source_id
        using errcode = '23503';
    end if;

    v_region := coalesce(nullif(v_line->>'region', '')::uuid, p_region_id);

    if not v_any then
      insert into public.journal_entries
        (id, company_id, entry_date, description, source_table, source_id,
         is_reversal, posted_by, status, posting_period)
      values
        (v_entry_id, p_company_id, p_date, p_description, p_source_table, p_source_id,
         p_is_reversal, v_user, 'posted', date_trunc('month', p_date)::date);
      v_any := true;
    end if;

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, branch_id,
       client_id, employee_id, partner_id, contract_id, cost_center)
    values
      (v_entry_id, v_acct_id, v_debit, v_credit, v_region,
       nullif(v_line->>'client_id',   '')::uuid,
       nullif(v_line->>'employee_id', '')::uuid,
       nullif(v_line->>'partner_id',  '')::uuid,
       nullif(v_line->>'contract_id', '')::uuid,
       nullif(v_line->>'cost_center', ''));

    v_dr_total := v_dr_total + v_debit;
    v_cr_total := v_cr_total + v_credit;
  end loop;

  if not v_any then return null; end if;

  -- B2: immediate balance check, so the caller gets a useful error. The
  -- deferred constraint trigger below is the backstop for direct INSERTs.
  if v_dr_total <> v_cr_total then
    raise exception
      'post_journal: entry does not balance (debits % <> credits %) for source %/%',
      v_dr_total, v_cr_total, p_source_table, p_source_id
      using errcode = '23514';
  end if;

  return v_entry_id;
end;
$function$;

-- B2 backstop: no entry may exist unbalanced at commit, however it was written.
create or replace function public.assert_journal_balanced()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry uuid;
  v_n     integer;
  v_dr    numeric;
  v_cr    numeric;
begin
  -- Separate branches, not CASE: plpgsql evaluates every branch of a CASE
  -- expression, and `new` only has one of these fields.
  if tg_table_name = 'journal_entries' then
    v_entry := new.id;
  else
    v_entry := new.journal_entry_id;
  end if;

  -- The entry may have been removed in the same transaction (cascade teardown).
  if not exists (select 1 from public.journal_entries where id = v_entry) then
    return null;
  end if;

  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_n, v_dr, v_cr
    from public.journal_lines where journal_entry_id = v_entry;

  if v_n = 0 then
    raise exception 'journal entry % has no lines', v_entry using errcode = '23514';
  end if;
  if v_dr <> v_cr then
    raise exception 'journal entry % does not balance: debits % <> credits %',
      v_entry, v_dr, v_cr using errcode = '23514';
  end if;
  return null;
end;
$function$;

drop trigger if exists trg_journal_entries_balanced on public.journal_entries;
create constraint trigger trg_journal_entries_balanced
  after insert on public.journal_entries
  deferrable initially deferred
  for each row execute function public.assert_journal_balanced();

drop trigger if exists trg_journal_lines_balanced on public.journal_lines;
create constraint trigger trg_journal_lines_balanced
  after insert on public.journal_lines
  deferrable initially deferred
  for each row execute function public.assert_journal_balanced();

-- ---------------------------------------------------------------------------
-- B5. Posted entries are immutable. Corrections are reversing entries.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_journal_immutable()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  -- Server-side maintenance (migrations, SSA teardown) runs without a company
  -- context; trust it there, exactly as enforce_period_lock does.
  if public.current_company_id() is null then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'journal_entries' then
    if tg_op = 'DELETE' then
      raise exception 'Posted journal entries cannot be deleted. Post a reversing entry instead.'
        using errcode = 'P0001';
    end if;
    -- Only the status may move (posted -> reversed).
    if old.status = 'posted' and (
         new.company_id   is distinct from old.company_id
      or new.entry_date   is distinct from old.entry_date
      or new.description  is distinct from old.description
      or new.source_table is distinct from old.source_table
      or new.source_id    is distinct from old.source_id
      or new.is_reversal  is distinct from old.is_reversal
      or new.posting_period is distinct from old.posting_period)
    then
      raise exception 'Posted journal entry % is immutable. Post a reversing entry instead.', old.id
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- journal_lines: no edits or deletes once the parent entry is posted.
  if exists (
    select 1 from public.journal_entries je
     where je.id = coalesce(old.journal_entry_id, new.journal_entry_id)
       and je.status in ('posted', 'reversed'))
  then
    raise exception 'Journal lines of a posted entry are immutable. Post a reversing entry instead.'
      using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$function$;

drop trigger if exists trg_journal_entries_immutable on public.journal_entries;
create trigger trg_journal_entries_immutable
  before update or delete on public.journal_entries
  for each row execute function public.enforce_journal_immutable();

drop trigger if exists trg_journal_lines_immutable on public.journal_lines;
create trigger trg_journal_lines_immutable
  before update or delete on public.journal_lines
  for each row execute function public.enforce_journal_immutable();

-- Reversals now carry a real FK instead of a description substring.
create or replace function public.reverse_journal_for_source(
  p_company_id uuid, p_source_table text, p_source_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_entry  record;
  v_rev_id uuid;
  v_user   uuid;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  for v_entry in
    select je.id, je.description
      from public.journal_entries je
     where je.company_id = p_company_id
       and je.source_table = p_source_table
       and je.source_id = p_source_id
       and je.is_reversal = false
       and je.status = 'posted'
       and not exists (
         select 1 from public.journal_entries rev
          where rev.reversal_of_entry_id = je.id)
  loop
    v_rev_id := gen_random_uuid();

    insert into public.journal_entries
      (id, company_id, entry_date, description, source_table, source_id,
       is_reversal, posted_by, status, posting_period, reversal_of_entry_id)
    values
      (v_rev_id, p_company_id, p_date,
       v_entry.description || ' (reversal)',
       p_source_table, p_source_id, true, v_user,
       'posted', date_trunc('month', p_date)::date, v_entry.id);

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, branch_id,
       client_id, employee_id, partner_id, contract_id, cost_center)
    select v_rev_id, jl.account_id, jl.credit, jl.debit, jl.branch_id,
           jl.client_id, jl.employee_id, jl.partner_id, jl.contract_id, jl.cost_center
      from public.journal_lines jl
     where jl.journal_entry_id = v_entry.id;

    update public.journal_entries set status = 'reversed' where id = v_entry.id;
  end loop;
end;
$function$;

-- ---------------------------------------------------------------------------
-- B6. Period lock on the journal tables themselves.
-- ---------------------------------------------------------------------------

drop trigger if exists trg_journal_entries_period_lock on public.journal_entries;
create trigger trg_journal_entries_period_lock
  before insert or update or delete on public.journal_entries
  for each row execute function public.enforce_period_lock('entry_date');

-- ---------------------------------------------------------------------------
-- A7 (partial). Employee advances must not debit the CLIENT receivable
-- control account. Without this, reconciliation check 3 can never pass.
--
-- The recovery leg (Dr Salaries Payable / Cr Employee Advances Receivable)
-- belongs to Part C and is NOT implemented here.
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_advance()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_cr_line jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'advances', old.id, old.advance_date);
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.branch_id is distinct from new.branch_id
       or old.cash_location_id is distinct from new.cash_location_id then
      perform public.reverse_journal_for_source(new.company_id, 'advances', new.id, old.advance_date);
    else
      return new;
    end if;
  end if;

  v_cr_line := case
    when new.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.cash_location_id),
      'debit', 0, 'credit', new.amount)
    else jsonb_build_object('key', 'bank', 'debit', 0, 'credit', new.amount)
  end;

  perform public.post_journal(
    new.company_id, new.advance_date,
    'Employee advance',
    'advances', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'employee_advances_receivable',
                         'debit', new.amount, 'credit', 0,
                         'employee_id', new.employee_id,
                         'client_id', new.client_id)
    ) || jsonb_build_array(v_cr_line),
    new.branch_id
  );
  return new;
end;
$function$;

-- Reclassify advances already sitting in client AR. This is a correcting
-- journal entry, not a rewrite of history.
do $$
declare
  c        record;
  v_amount numeric;
begin
  for c in select distinct company_id from public.advances loop
    -- Re-runnable: never post the correction twice.
    continue when exists (
      select 1 from public.journal_entries
       where company_id = c.company_id and source_table = 'ledger_correction_0219');

    select coalesce(sum(jl.debit - jl.credit), 0) into v_amount
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = c.company_id
       and je.source_table = 'advances'
       and a.system_key = 'ar';

    if v_amount <> 0 then
      perform public.post_journal(
        c.company_id, current_date,
        'Reclassify employee advances out of client AR (migration 0219)',
        'ledger_correction_0219', gen_random_uuid(), false,
        jsonb_build_array(
          jsonb_build_object('key', 'employee_advances_receivable', 'debit', v_amount, 'credit', 0),
          jsonb_build_object('key', 'ar',                           'debit', 0, 'credit', v_amount)
        ));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- E4 (checks 1–3). Reconciliation harness, runnable per company.
--
--   select * from public.ledger_checks('<company_id>');
--
-- Returns one row per check. `passed = false` on any row is a hard failure.
-- Remaining E4 checks land with the Part C postings they depend on.
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
  ar_gl as (
    select coalesce(sum(jl.debit - jl.credit), 0) bal
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id and a.system_key = 'ar'
  ),
  ar_sub as (
    select coalesce((select sum(i.invoice_amount) from public.invoices i
                      where i.company_id = p_company_id
                        and coalesce(i.status, '') <> 'Written-Off'), 0)
         - coalesce((select sum(p.amount) from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),
  adv_gl as (
    select coalesce(sum(jl.debit - jl.credit), 0) bal
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id and a.system_key = 'employee_advances_receivable'
  ),
  adv_sub as (
    select coalesce((select sum(a.amount) from public.advances a
                      where a.company_id = p_company_id), 0) bal
  )
  select 'trial_balance_debits_equal_credits'::text,
         tb.dr, tb.cr, tb.dr - tb.cr, tb.dr = tb.cr from tb
  union all
  select 'no_one_sided_entries', 0, onesided.n, onesided.n, onesided.n = 0 from onesided
  union all
  select 'ar_control_equals_open_invoices',
         ar_sub.bal, ar_gl.bal, ar_gl.bal - ar_sub.bal, ar_gl.bal = ar_sub.bal
    from ar_gl cross join ar_sub
  union all
  select 'employee_advances_control_not_in_client_ar',
         adv_sub.bal, adv_gl.bal, adv_gl.bal - adv_sub.bal, adv_gl.bal = adv_sub.bal
    from adv_gl cross join adv_sub;
$function$;

revoke all on function public.ledger_checks(uuid) from public;
grant execute on function public.ledger_checks(uuid) to authenticated;
