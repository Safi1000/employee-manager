-- Sprint 5 — Double-entry shadow journal (spec section 6.2).
-- "Behind every user-facing transaction, the system must silently post a
-- journal entry against a Chart of Accounts. Users never see the journal;
-- accountants and auditors can pull a Trial Balance at any time."
--
-- This makes the Trial Balance always balance (debits = credits by
-- construction) and gives auditors a complete, queryable ledger.

-- ---------------------------------------------------------------------------
-- 1. Journal schema
-- ---------------------------------------------------------------------------
create table if not exists public.journal_entries (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  entry_date       date not null,
  description      text,
  source_table     text,         -- e.g. 'invoices', 'expenses', null for manual
  source_id        uuid,         -- FK to the source row; null for manual
  is_reversal      boolean not null default false,
  manual           boolean not null default false,
  posted_by        uuid,
  created_at       timestamptz not null default now()
);

create index if not exists idx_je_company    on public.journal_entries(company_id);
create index if not exists idx_je_date       on public.journal_entries(entry_date);
create index if not exists idx_je_source     on public.journal_entries(source_table, source_id);

create table if not exists public.journal_lines (
  id               uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.journal_entries(id) on delete cascade,
  account_id       uuid not null references public.chart_of_accounts(id) on delete restrict,
  debit            numeric(16,2) not null default 0,
  credit           numeric(16,2) not null default 0,
  constraint positive_amounts check (debit >= 0 and credit >= 0),
  constraint one_side_only check (debit = 0 or credit = 0)
);

create index if not exists idx_jl_entry   on public.journal_lines(journal_entry_id);
create index if not exists idx_jl_account on public.journal_lines(account_id);

-- Auto-fill company_id
drop trigger if exists trg_aaa_je_fill_company on public.journal_entries;
create trigger trg_aaa_je_fill_company
  before insert on public.journal_entries
  for each row execute function public.fill_company_id();

-- RLS
alter table public.journal_entries enable row level security;
drop policy if exists "ssa_all" on public.journal_entries;
create policy "ssa_all" on public.journal_entries for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.journal_entries;
create policy "company_members" on public.journal_entries for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

alter table public.journal_lines enable row level security;
drop policy if exists "ssa_all" on public.journal_lines;
create policy "ssa_all" on public.journal_lines for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "via_entry" on public.journal_lines;
create policy "via_entry" on public.journal_lines for all
  using (exists (
    select 1 from public.journal_entries je
    where je.id = journal_entry_id
      and je.company_id = public.current_company_id()
  ))
  with check (exists (
    select 1 from public.journal_entries je
    where je.id = journal_entry_id
      and je.company_id = public.current_company_id()
  ));

-- ---------------------------------------------------------------------------
-- 2. Helper: resolve a system_key to an account_id for a given company.
--    Returns NULL if not found (trigger should silently skip).
-- ---------------------------------------------------------------------------
create or replace function public.coa_id(p_company_id uuid, p_key text)
returns uuid language sql stable as $$
  select id from public.chart_of_accounts
  where company_id = p_company_id and system_key = p_key
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 3. Helper: post a complete journal entry with N lines. Each line is
--    (system_key, debit, credit). Skips lines where both debit and credit
--    are zero, and skips the entire entry if no valid lines remain.
-- ---------------------------------------------------------------------------
create or replace function public.post_journal(
  p_company_id  uuid,
  p_date        date,
  p_description text,
  p_source_table text,
  p_source_id   uuid,
  p_is_reversal boolean,
  p_lines       jsonb   -- array of { "key": "cash", "debit": 1000, "credit": 0 }
)
returns uuid language plpgsql security definer as $$
declare
  v_entry_id uuid;
  v_line     jsonb;
  v_acct_id  uuid;
  v_debit    numeric;
  v_credit   numeric;
  v_any      boolean := false;
  v_user     uuid;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  v_entry_id := gen_random_uuid();

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_debit  := coalesce((v_line->>'debit')::numeric, 0);
    v_credit := coalesce((v_line->>'credit')::numeric, 0);
    if v_debit = 0 and v_credit = 0 then continue; end if;

    v_acct_id := public.coa_id(p_company_id, v_line->>'key');
    if v_acct_id is null then continue; end if;

    if not v_any then
      insert into public.journal_entries
        (id, company_id, entry_date, description, source_table, source_id, is_reversal, posted_by)
      values
        (v_entry_id, p_company_id, p_date, p_description, p_source_table, p_source_id, p_is_reversal, v_user);
      v_any := true;
    end if;

    insert into public.journal_lines (journal_entry_id, account_id, debit, credit)
    values (v_entry_id, v_acct_id, v_debit, v_credit);
  end loop;

  if v_any then return v_entry_id; end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Helper: reverse all journal entries for a given source row.
--    Posts mirror entries (debits↔credits). Idempotent: skips if the source
--    has already been reversed and no new forward entry exists.
-- ---------------------------------------------------------------------------
create or replace function public.reverse_journal_for_source(
  p_company_id   uuid,
  p_source_table text,
  p_source_id    uuid,
  p_date         date
)
returns void language plpgsql security definer as $$
declare
  v_entry record;
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
      -- Only reverse entries that haven't already been reversed.
      and not exists (
        select 1 from public.journal_entries rev
        where rev.company_id = p_company_id
          and rev.source_table = p_source_table
          and rev.source_id = p_source_id
          and rev.is_reversal = true
          and rev.description like '%(reversal of ' || je.id::text || ')%'
      )
  loop
    v_rev_id := gen_random_uuid();
    insert into public.journal_entries
      (id, company_id, entry_date, description, source_table, source_id, is_reversal, posted_by)
    values
      (v_rev_id, p_company_id, p_date,
       v_entry.description || ' (reversal of ' || v_entry.id || ')',
       p_source_table, p_source_id, true, v_user);

    insert into public.journal_lines (journal_entry_id, account_id, debit, credit)
    select v_rev_id, jl.account_id, jl.credit, jl.debit  -- swap debit↔credit
    from public.journal_lines jl
    where jl.journal_entry_id = v_entry.id;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Trigger: INVOICES
--    INSERT: DR Accounts Receivable (net of WHT), CR Revenue, CR WHT Payable
--    DELETE: reverse
--    UPDATE of amount/wht: reverse old + post new
-- ---------------------------------------------------------------------------
create or replace function public.journal_on_invoice()
returns trigger language plpgsql security definer as $$
declare
  v_amt    numeric;
  v_wht    numeric;
  v_net    numeric;
  v_rev_key text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'invoices', old.id, old.invoice_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.invoice_amount is distinct from new.invoice_amount
       or coalesce(old.withholding_tax, 0) is distinct from coalesce(new.withholding_tax, 0) then
      perform public.reverse_journal_for_source(new.company_id, 'invoices', new.id, old.invoice_date);
    else
      return new;
    end if;
  end if;

  -- INSERT or UPDATE-with-amount-change: post fresh entry.
  v_amt := new.invoice_amount;
  v_wht := coalesce(new.withholding_tax, 0);
  v_net := v_amt - v_wht;
  -- Determine revenue account from client_type (need a join).
  v_rev_key := 'revenue_security';
  begin
    select case when c.client_type = 'guard_deployment' then 'revenue_guard' else 'revenue_security' end
      into v_rev_key
    from public.clients c where c.id = new.client_id;
  exception when others then null;
  end;

  perform public.post_journal(
    new.company_id, new.invoice_date,
    'Invoice ' || coalesce(new.invoice_number, new.id::text),
    'invoices', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ar',       'debit', v_net, 'credit', 0),
      jsonb_build_object('key', v_rev_key,  'debit', 0,     'credit', v_net),
      jsonb_build_object('key', 'wht_payable', 'debit', 0,  'credit', v_wht)
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_yyy_invoices_journal on public.invoices;
create trigger trg_yyy_invoices_journal
  after insert or update or delete on public.invoices
  for each row execute function public.journal_on_invoice();

-- ---------------------------------------------------------------------------
-- 6. Trigger: INVOICE_PAYMENTS
--    INSERT: DR Cash/Bank, CR Accounts Receivable
--    DELETE: reverse
-- ---------------------------------------------------------------------------
create or replace function public.journal_on_invoice_payment()
returns trigger language plpgsql security definer as $$
declare
  v_dest text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'invoice_payments', old.id, old.payment_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount then
      perform public.reverse_journal_for_source(new.company_id, 'invoice_payments', new.id, old.payment_date);
    else
      return new;
    end if;
  end if;

  v_dest := case when new.payment_mode = 'Cash' then 'cash' else 'bank' end;

  perform public.post_journal(
    new.company_id, new.payment_date,
    'Payment received',
    'invoice_payments', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', v_dest, 'debit', new.amount, 'credit', 0),
      jsonb_build_object('key', 'ar',   'debit', 0,          'credit', new.amount)
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_yyy_payments_journal on public.invoice_payments;
create trigger trg_yyy_payments_journal
  after insert or update or delete on public.invoice_payments
  for each row execute function public.journal_on_invoice_payment();

-- ---------------------------------------------------------------------------
-- 7. Trigger: EXPENSES
--    INSERT: DR Expense account (mapped by category + pl_category),
--            CR Cash/Bank/AP (by payment_mode)
--    DELETE: reverse
--    UPDATE of amount: reverse old + post new
-- ---------------------------------------------------------------------------
create or replace function public.map_expense_to_coa_key(
  p_cat_name text,
  p_pl_cat   text,
  p_client_id uuid
)
returns text language sql stable as $$
  select case
    when p_cat_name = 'Equipment & Supplies' then 'cos_equipment'
    when p_cat_name = 'Transportation & Fuel' then 'cos_transport'
    when p_cat_name in ('EOBI', 'IESSI', 'PESSI') then 'cos_statutory'
    when p_cat_name = 'Utilities & Rent' then 'opex_utilities'
    when p_cat_name = 'Insurance' then 'opex_insurance'
    when p_cat_name = 'Licenses' then 'opex_licences'
    when p_cat_name = 'Taxes' then 'income_tax'
    when p_pl_cat = 'cost_of_services' or p_client_id is not null then 'cos_other'
    else 'opex_other'
  end;
$$;

create or replace function public.journal_on_expense()
returns trigger language plpgsql security definer as $$
declare
  v_exp_key  text;
  v_cr_key   text;
  v_cat_name text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'expenses', old.id, old.expense_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.payment_mode is distinct from new.payment_mode
       or old.category_id is distinct from new.category_id then
      perform public.reverse_journal_for_source(new.company_id, 'expenses', new.id, old.expense_date);
    else
      return new;
    end if;
  end if;

  -- Look up category name.
  select name into v_cat_name from public.expense_categories where id = new.category_id;
  v_exp_key := public.map_expense_to_coa_key(coalesce(v_cat_name, ''), new.pl_category::text, new.client_id);

  v_cr_key := case
    when new.payment_mode = 'Cash' then 'cash'
    when new.payment_mode in ('Bank', 'Cheque') then 'bank'
    else 'ap'
  end;

  perform public.post_journal(
    new.company_id, new.expense_date,
    coalesce(v_cat_name, 'Expense') || coalesce(' — ' || new.description, ''),
    'expenses', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', v_exp_key, 'debit', new.amount, 'credit', 0),
      jsonb_build_object('key', v_cr_key,  'debit', 0,          'credit', new.amount)
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_yyy_expenses_journal on public.expenses;
create trigger trg_yyy_expenses_journal
  after insert or update or delete on public.expenses
  for each row execute function public.journal_on_expense();

-- ---------------------------------------------------------------------------
-- 8. Trigger: PAYSLIPS (fires when disbursed changes to true)
--    DR Guard/Office Payroll, CR Cash/Bank
--    + separate EOBI line if eobi > 0
-- ---------------------------------------------------------------------------
create or replace function public.journal_on_payslip()
returns trigger language plpgsql security definer as $$
declare
  v_payroll_key text;
  v_cr_key      text;
  v_emp_cat     text;
  v_lines       jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'payslips', old.id, old.period_month);
    return old;
  end if;

  -- Only journal when disbursed flips to true.
  if tg_op = 'INSERT' and not new.disbursed then return new; end if;
  if tg_op = 'UPDATE' then
    if old.disbursed = true and new.disbursed = true and old.final_salary is not distinct from new.final_salary then
      return new;
    end if;
    if old.disbursed = true then
      perform public.reverse_journal_for_source(new.company_id, 'payslips', new.id, old.period_month);
    end if;
    if not new.disbursed then return new; end if;
  end if;

  -- Determine employee category for COS vs OpEx split.
  select category into v_emp_cat from public.employees where id = new.employee_id;
  v_payroll_key := case when v_emp_cat = 'office_staff' then 'opex_office_payroll' else 'cos_payroll' end;
  v_cr_key := case when new.payment_mode = 'Cash' then 'cash' else 'bank' end;

  v_lines := jsonb_build_array(
    jsonb_build_object('key', v_payroll_key, 'debit', new.final_salary, 'credit', 0),
    jsonb_build_object('key', v_cr_key,      'debit', 0,                'credit', new.final_salary)
  );

  if coalesce(new.eobi, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('key', 'cos_statutory', 'debit', new.eobi, 'credit', 0),
      jsonb_build_object('key', 'eobi_payable',  'debit', 0,        'credit', new.eobi)
    );
  end if;

  perform public.post_journal(
    new.company_id, new.period_month,
    'Payroll — ' || left(new.period_month::text, 7),
    'payslips', new.id, false,
    v_lines
  );
  return new;
end;
$$;

drop trigger if exists trg_yyy_payslips_journal on public.payslips;
create trigger trg_yyy_payslips_journal
  after insert or update or delete on public.payslips
  for each row execute function public.journal_on_payslip();

-- ---------------------------------------------------------------------------
-- 9. Trigger: ADVANCES
--    INSERT: DR Advances (asset/receivable), CR Cash/Bank
--    DELETE: reverse
-- ---------------------------------------------------------------------------
create or replace function public.journal_on_advance()
returns trigger language plpgsql security definer as $$
declare
  v_cr_key text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'advances', old.id, old.advance_date);
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount then
      perform public.reverse_journal_for_source(new.company_id, 'advances', new.id, old.advance_date);
    else
      return new;
    end if;
  end if;

  v_cr_key := case when new.payment_mode = 'Cash' then 'cash' else 'bank' end;

  -- Advances are a short-term receivable (asset) from the employee. We'll
  -- post to a generic "ar" or ideally a separate "advances_receivable" account.
  -- Since the seeded CoA doesn't have one, use "ar" for now.
  perform public.post_journal(
    new.company_id, new.advance_date,
    'Employee advance',
    'advances', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ar',     'debit', new.amount, 'credit', 0),
      jsonb_build_object('key', v_cr_key, 'debit', 0,          'credit', new.amount)
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_yyy_advances_journal on public.advances;
create trigger trg_yyy_advances_journal
  after insert or update or delete on public.advances
  for each row execute function public.journal_on_advance();

-- ---------------------------------------------------------------------------
-- 10. Backfill: post journal entries for all existing transactions.
-- Run once at migration time so the TB is populated from day one.
-- ---------------------------------------------------------------------------

-- Invoices
do $$
declare
  r record;
  v_rev text;
  v_net numeric;
  v_wht numeric;
begin
  for r in select i.*, c.client_type from public.invoices i
           left join public.clients c on c.id = i.client_id
           order by i.invoice_date
  loop
    v_wht := coalesce(r.withholding_tax, 0);
    v_net := r.invoice_amount - v_wht;
    v_rev := case when r.client_type = 'guard_deployment' then 'revenue_guard' else 'revenue_security' end;
    perform public.post_journal(
      r.company_id, r.invoice_date,
      'Invoice ' || coalesce(r.invoice_number, r.id::text),
      'invoices', r.id, false,
      jsonb_build_array(
        jsonb_build_object('key', 'ar', 'debit', v_net, 'credit', 0),
        jsonb_build_object('key', v_rev, 'debit', 0, 'credit', v_net),
        jsonb_build_object('key', 'wht_payable', 'debit', 0, 'credit', v_wht)
      )
    );
  end loop;
end$$;

-- Invoice payments
do $$
declare r record; v_dest text;
begin
  for r in select * from public.invoice_payments order by payment_date loop
    v_dest := case when r.payment_mode = 'Cash' then 'cash' else 'bank' end;
    perform public.post_journal(
      r.company_id, r.payment_date, 'Payment received',
      'invoice_payments', r.id, false,
      jsonb_build_array(
        jsonb_build_object('key', v_dest, 'debit', r.amount, 'credit', 0),
        jsonb_build_object('key', 'ar', 'debit', 0, 'credit', r.amount)
      )
    );
  end loop;
end$$;

-- Expenses
do $$
declare r record; v_cat text; v_exp text; v_cr text;
begin
  for r in select e.*, ec.name as cat_name from public.expenses e
           left join public.expense_categories ec on ec.id = e.category_id
           order by e.expense_date loop
    v_exp := public.map_expense_to_coa_key(coalesce(r.cat_name, ''), r.pl_category::text, r.client_id);
    v_cr := case when r.payment_mode = 'Cash' then 'cash'
                 when r.payment_mode in ('Bank', 'Cheque') then 'bank'
                 else 'ap' end;
    perform public.post_journal(
      r.company_id, r.expense_date,
      coalesce(r.cat_name, 'Expense') || coalesce(' — ' || r.description, ''),
      'expenses', r.id, false,
      jsonb_build_array(
        jsonb_build_object('key', v_exp, 'debit', r.amount, 'credit', 0),
        jsonb_build_object('key', v_cr, 'debit', 0, 'credit', r.amount)
      )
    );
  end loop;
end$$;

-- Payslips (disbursed only)
do $$
declare r record; v_pay text; v_cr text; v_lines jsonb; v_emp_cat text;
begin
  for r in select * from public.payslips where disbursed = true order by period_month loop
    select category into v_emp_cat from public.employees where id = r.employee_id;
    v_pay := case when v_emp_cat = 'office_staff' then 'opex_office_payroll' else 'cos_payroll' end;
    v_cr := case when r.payment_mode = 'Cash' then 'cash' else 'bank' end;
    v_lines := jsonb_build_array(
      jsonb_build_object('key', v_pay, 'debit', r.final_salary, 'credit', 0),
      jsonb_build_object('key', v_cr, 'debit', 0, 'credit', r.final_salary)
    );
    if coalesce(r.eobi, 0) > 0 then
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('key', 'cos_statutory', 'debit', r.eobi, 'credit', 0),
        jsonb_build_object('key', 'eobi_payable', 'debit', 0, 'credit', r.eobi)
      );
    end if;
    perform public.post_journal(
      r.company_id, r.period_month,
      'Payroll — ' || left(r.period_month::text, 7),
      'payslips', r.id, false, v_lines
    );
  end loop;
end$$;

-- Advances
do $$
declare r record; v_cr text;
begin
  for r in select * from public.advances order by advance_date loop
    v_cr := case when r.payment_mode = 'Cash' then 'cash' else 'bank' end;
    perform public.post_journal(
      r.company_id, r.advance_date, 'Employee advance',
      'advances', r.id, false,
      jsonb_build_array(
        jsonb_build_object('key', 'ar', 'debit', r.amount, 'credit', 0),
        jsonb_build_object('key', v_cr, 'debit', 0, 'credit', r.amount)
      )
    );
  end loop;
end$$;
