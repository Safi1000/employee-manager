-- Cash custody as sub-ledgers (spec section 4.2).
--
-- "Every cash location (treasury, custodian, petty float) = a sub-account
-- under the Cash control account. Every custody transfer and bank<->cash
-- movement posts double-entry between sub-accounts. Sum(locations) then equals
-- the control balance by construction — reconciliation is automatic."
--
-- The mechanism that makes it "by construction": the control account stops
-- receiving postings at all. Every posting lands on a LEAF (a location's own
-- account), and the control's balance is defined as the rollup of its
-- children. Sum(children) = control is then a tautology, not a nightly job
-- that can disagree. `cash_control_reconciliation` at the bottom proves it and
-- should always read zero.
--
-- Two facts about the data this had to accommodate:
--
--  * All 11 existing cash_locations are location_type='BANK' mirroring a bank
--    account. They are NOT cash — they hang under the Bank control, not Cash.
--  * There were 398 cash-mode transactions (170 expenses, 204 payslips, 12
--    advances, 12 receipts) and no cash location to own them. Each company
--    gets a default 'Main Cash' TREASURY location, and that history is
--    reclassified onto it.

-- ---------------------------------------------------------------------------
-- 1. Treasury is a real location kind (spec names treasury/custodian/petty).
-- ---------------------------------------------------------------------------

alter table public.cash_locations drop constraint if exists cash_locations_location_type_check;
alter table public.cash_locations add constraint cash_locations_location_type_check
  check (location_type = any (array['BANK', 'TREASURY', 'CUSTODIAN', 'PETTY_CASH']));

-- ---------------------------------------------------------------------------
-- 2. post_journal learns to post to an explicit account, not just a
--    system_key. Sub-accounts are per-location rows with no system_key, so
--    there is no key to look them up by.
-- ---------------------------------------------------------------------------

create or replace function public.post_journal(
  p_company_id   uuid,
  p_date         date,
  p_description  text,
  p_source_table text,
  p_source_id    uuid,
  p_is_reversal  boolean,
  p_lines        jsonb,  -- [{ "key"|"account_id", "debit", "credit", "region"? }]
  p_region_id    uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_entry_id uuid;
  v_line     jsonb;
  v_acct_id  uuid;
  v_debit    numeric;
  v_credit   numeric;
  v_region   uuid;
  v_any      boolean := false;
  v_user     uuid;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  p_region_id := coalesce(p_region_id, public.head_office_region(p_company_id));

  v_entry_id := gen_random_uuid();

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_debit  := coalesce((v_line->>'debit')::numeric, 0);
    v_credit := coalesce((v_line->>'credit')::numeric, 0);
    if v_debit = 0 and v_credit = 0 then continue; end if;

    -- An explicit account_id wins; otherwise resolve the system_key as before.
    v_acct_id := coalesce(
      nullif(v_line->>'account_id', '')::uuid,
      public.coa_id(p_company_id, v_line->>'key')
    );
    if v_acct_id is null then continue; end if;

    v_region := coalesce(nullif(v_line->>'region', '')::uuid, p_region_id);

    if not v_any then
      insert into public.journal_entries
        (id, company_id, entry_date, description, source_table, source_id, is_reversal, posted_by)
      values
        (v_entry_id, p_company_id, p_date, p_description, p_source_table, p_source_id, p_is_reversal, v_user);
      v_any := true;
    end if;

    insert into public.journal_lines (journal_entry_id, account_id, debit, credit, branch_id)
    values (v_entry_id, v_acct_id, v_debit, v_credit, v_region);
  end loop;

  if v_any then return v_entry_id; end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Each location gets its own account under the right control.
-- ---------------------------------------------------------------------------

alter table public.cash_locations
  add column if not exists coa_account_id uuid references public.chart_of_accounts(id);

-- Shared by the trigger and the backfill so there is exactly one definition of
-- where a location's account hangs and how its code is chosen.
create or replace function public.allocate_cash_location_account(
  p_company_id    uuid,
  p_location_type text,
  p_name          text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_parent      uuid;
  v_parent_code text;
  v_code        text;
  v_seq         integer := 0;
  v_acct        uuid;
begin
  -- A BANK-type location mirrors a bank account, so it belongs under the Bank
  -- control. Only real cash hangs under Cash.
  if p_location_type = 'BANK' then
    select id, account_code into v_parent, v_parent_code
      from public.chart_of_accounts
     where company_id = p_company_id and system_key = 'bank';
  else
    select id, account_code into v_parent, v_parent_code
      from public.chart_of_accounts
     where company_id = p_company_id and system_key = 'cash';
  end if;

  if v_parent is null then
    return null;  -- company has no seeded CoA yet; nothing to hang it off
  end if;

  -- (company_id, account_code) is unique, so probe for a free code rather than
  -- trusting a count() that a deleted row would make collide.
  loop
    v_seq := v_seq + 1;
    v_code := v_parent_code || '.' || lpad(v_seq::text, 2, '0');
    exit when not exists (
      select 1 from public.chart_of_accounts
       where company_id = p_company_id and account_code = v_code
    );
    if v_seq > 500 then
      raise exception 'could not allocate a sub-account code under %', v_parent_code;
    end if;
  end loop;

  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side,
     parent_id, system_account, active, notes)
  values
    (p_company_id, v_code, p_name, 'asset', 'debit',
     v_parent, true, true, 'Cash location sub-ledger')
  returning id into v_acct;

  return v_acct;
end;
$$;

create or replace function public.ensure_cash_location_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.coa_account_id is null then
    new.coa_account_id := public.allocate_cash_location_account(
      new.company_id, new.location_type, new.name);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ccc_cash_location_account on public.cash_locations;
create trigger trg_ccc_cash_location_account
  before insert on public.cash_locations
  for each row execute function public.ensure_cash_location_account();

-- Backfill the 11 locations that already exist.
do $$
declare r record;
begin
  for r in select * from public.cash_locations where coa_account_id is null loop
    update public.cash_locations
       set coa_account_id = public.allocate_cash_location_account(
             r.company_id, r.location_type, r.name)
     where id = r.id;
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- 4. Every company gets a default 'Main Cash' treasury to own the cash that is
--    already flowing. Without it there is nowhere to put 398 existing
--    transactions, and the Cash control would have postings with no location.
-- ---------------------------------------------------------------------------

insert into public.cash_locations
  (company_id, name, location_type, branch_id, opening_balance, is_active)
select c.id, 'Main Cash', 'TREASURY', public.head_office_region(c.id), 0, true
  from public.companies c
 where not exists (
   select 1 from public.cash_locations cl
    where cl.company_id = c.id and cl.location_type <> 'BANK'
 );

create or replace function public.default_cash_location(p_company_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.cash_locations
   where company_id = p_company_id and location_type = 'TREASURY' and is_active
   order by created_at
   limit 1;
$$;

-- Resolve the account a cash posting should hit: the named location's own
-- account, else the company's default treasury, else (no locations at all) the
-- Cash control itself so a posting is never silently dropped.
create or replace function public.cash_account_for(
  p_company_id  uuid,
  p_location_id uuid
)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select cl.coa_account_id from public.cash_locations cl
      where cl.id = p_location_id and cl.company_id = p_company_id),
    (select cl.coa_account_id from public.cash_locations cl
      where cl.id = public.default_cash_location(p_company_id)),
    public.coa_id(p_company_id, 'cash')
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. Cash movements can now say which location they touched.
-- ---------------------------------------------------------------------------

alter table public.expenses
  add column if not exists cash_location_id uuid references public.cash_locations(id);
alter table public.payslips
  add column if not exists cash_location_id uuid references public.cash_locations(id);
alter table public.advances
  add column if not exists cash_location_id uuid references public.cash_locations(id);
alter table public.invoice_payments
  add column if not exists cash_location_id uuid references public.cash_locations(id);
alter table public.cash_deposits
  add column if not exists cash_location_id uuid references public.cash_locations(id);

create index if not exists idx_expenses_cash_loc  on public.expenses(cash_location_id);
create index if not exists idx_payslips_cash_loc  on public.payslips(cash_location_id);
create index if not exists idx_advances_cash_loc  on public.advances(cash_location_id);
create index if not exists idx_ip_cash_loc        on public.invoice_payments(cash_location_id);

-- Existing cash-mode rows belong to the default treasury: that is where the
-- money actually was, since no other cash location existed.
update public.expenses e set cash_location_id = public.default_cash_location(e.company_id)
 where e.payment_mode = 'Cash' and e.cash_location_id is null;
update public.payslips p set cash_location_id = public.default_cash_location(p.company_id)
 where p.payment_mode = 'Cash' and p.cash_location_id is null;
update public.advances a set cash_location_id = public.default_cash_location(a.company_id)
 where a.payment_mode = 'Cash' and a.cash_location_id is null;
update public.invoice_payments ip set cash_location_id = public.default_cash_location(ip.company_id)
 where ip.payment_mode = 'Cash' and ip.cash_location_id is null;
update public.cash_deposits cd set cash_location_id = public.default_cash_location(cd.company_id)
 where cd.cash_location_id is null;

-- ---------------------------------------------------------------------------
-- 6. Route cash postings to the location's account instead of the control.
--    Bodies are otherwise unchanged from 0074/0077; only the cash credit line
--    and the repost condition move.
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_expense()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_exp_key  text;
  v_cr_line  jsonb;
  v_cat_name text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'expenses', old.id, old.expense_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.payment_mode is distinct from new.payment_mode
       or old.category_id is distinct from new.category_id
       or old.branch_id is distinct from new.branch_id
       or old.cash_location_id is distinct from new.cash_location_id then
      perform public.reverse_journal_for_source(new.company_id, 'expenses', new.id, old.expense_date);
    else
      return new;
    end if;
  end if;

  select name into v_cat_name from public.expense_categories where id = new.category_id;
  v_exp_key := public.map_expense_to_coa_key(coalesce(v_cat_name, ''), new.pl_category::text, new.client_id);

  v_cr_line := case
    when new.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.cash_location_id),
      'debit', 0, 'credit', new.amount)
    when new.payment_mode in ('Bank', 'Cheque') then jsonb_build_object(
      'key', 'bank', 'debit', 0, 'credit', new.amount)
    else jsonb_build_object('key', 'ap', 'debit', 0, 'credit', new.amount)
  end;

  perform public.post_journal(
    new.company_id, new.expense_date,
    coalesce(v_cat_name, 'Expense') || coalesce(' — ' || new.description, ''),
    'expenses', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', v_exp_key, 'debit', new.amount, 'credit', 0)
    ) || jsonb_build_array(v_cr_line),
    new.branch_id
  );
  return new;
end;
$$;

create or replace function public.journal_on_payslip()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_payroll_key text;
  v_cr_line     jsonb;
  v_emp_cat     text;
  v_lines       jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'payslips', old.id, old.period_month);
    return old;
  end if;

  if tg_op = 'INSERT' and not new.disbursed then return new; end if;
  if tg_op = 'UPDATE' then
    if old.disbursed = true and new.disbursed = true
       and old.final_salary is not distinct from new.final_salary
       and old.branch_id is not distinct from new.branch_id
       and old.cash_location_id is not distinct from new.cash_location_id then
      return new;
    end if;
    if old.disbursed = true then
      perform public.reverse_journal_for_source(new.company_id, 'payslips', new.id, old.period_month);
    end if;
    if not new.disbursed then return new; end if;
  end if;

  select category into v_emp_cat from public.employees where id = new.employee_id;
  v_payroll_key := case when v_emp_cat = 'office_staff' then 'opex_office_payroll' else 'cos_payroll' end;

  v_cr_line := case
    when new.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.cash_location_id),
      'debit', 0, 'credit', new.final_salary)
    else jsonb_build_object('key', 'bank', 'debit', 0, 'credit', new.final_salary)
  end;

  v_lines := jsonb_build_array(
    jsonb_build_object('key', v_payroll_key, 'debit', new.final_salary, 'credit', 0)
  ) || jsonb_build_array(v_cr_line);

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
    v_lines,
    new.branch_id
  );
  return new;
end;
$$;

create or replace function public.journal_on_advance()
returns trigger language plpgsql security definer set search_path = public as $$
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
      jsonb_build_object('key', 'ar', 'debit', new.amount, 'credit', 0)
    ) || jsonb_build_array(v_cr_line),
    new.branch_id
  );
  return new;
end;
$$;

create or replace function public.journal_on_invoice_payment()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_dr_line jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'invoice_payments', old.id, old.payment_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.branch_id is distinct from new.branch_id
       or old.cash_location_id is distinct from new.cash_location_id then
      perform public.reverse_journal_for_source(new.company_id, 'invoice_payments', new.id, old.payment_date);
    else
      return new;
    end if;
  end if;

  v_dr_line := case
    when new.payment_mode = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.cash_location_id),
      'debit', new.amount, 'credit', 0)
    else jsonb_build_object('key', 'bank', 'debit', new.amount, 'credit', 0)
  end;

  perform public.post_journal(
    new.company_id, new.payment_date,
    'Payment received',
    'invoice_payments', new.id, false,
    jsonb_build_array(v_dr_line) || jsonb_build_array(
      jsonb_build_object('key', 'ar', 'debit', 0, 'credit', new.amount)
    ),
    new.branch_id
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Reclassify the cash history onto the default treasury.
--
-- This moves lines from the Cash control to a CHILD of that same control. The
-- rollup total is identical before and after — no balance moves, no P&L
-- changes, no restatement. It is a re-filing of where within the cash tree a
-- posting sits, which is exactly what has to be true for the control to
-- become a pure rollup.
-- ---------------------------------------------------------------------------

update public.journal_lines jl
   set account_id = cl.coa_account_id
  from public.journal_entries je
       join public.cash_locations cl
         on cl.id = public.default_cash_location(je.company_id)
 where je.id = jl.journal_entry_id
   and jl.account_id = public.coa_id(je.company_id, 'cash')
   and cl.coa_account_id is not null;

-- ---------------------------------------------------------------------------
-- 8. Custody transfers post between sub-accounts.
--
-- Each line carries its OWN location's region rather than one region for the
-- whole entry: moving cash from Lahore's float to head office is one event
-- touching two regions, and the per-line region tag from 0074 is what lets
-- that be recorded honestly instead of being forced to pick a side.
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_custody_transfer()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_from record;
  v_to   record;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'custody_transfers', old.id, old.date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.from_location_id is distinct from new.from_location_id
       or old.to_location_id is distinct from new.to_location_id then
      perform public.reverse_journal_for_source(new.company_id, 'custody_transfers', new.id, old.date);
    else
      return new;
    end if;
  end if;

  select coa_account_id, branch_id into v_from
    from public.cash_locations where id = new.from_location_id;
  select coa_account_id, branch_id into v_to
    from public.cash_locations where id = new.to_location_id;

  perform public.post_journal(
    new.company_id, new.date,
    'Custody transfer',
    'custody_transfers', new.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_to.coa_account_id,   'debit', new.amount, 'credit', 0,
                         'region', v_to.branch_id),
      jsonb_build_object('account_id', v_from.coa_account_id, 'debit', 0, 'credit', new.amount,
                         'region', v_from.branch_id)
    ),
    coalesce(v_from.branch_id, v_to.branch_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_yyy_custody_transfers_journal on public.custody_transfers;
create trigger trg_yyy_custody_transfers_journal
  after insert or update or delete on public.custody_transfers
  for each row execute function public.journal_on_custody_transfer();

-- ---------------------------------------------------------------------------
-- 9. Cash deposits (cash -> bank) post between sub-account and bank.
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_cash_deposit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_from record;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'cash_deposits', old.id, old.deposit_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.cash_location_id is distinct from new.cash_location_id then
      perform public.reverse_journal_for_source(new.company_id, 'cash_deposits', new.id, old.deposit_date);
    else
      return new;
    end if;
  end if;

  select coa_account_id, branch_id into v_from
    from public.cash_locations where id = new.cash_location_id;

  perform public.post_journal(
    new.company_id, new.deposit_date,
    'Cash deposited to bank',
    'cash_deposits', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'bank', 'debit', new.amount, 'credit', 0),
      jsonb_build_object('account_id',
                         coalesce(v_from.coa_account_id,
                                  public.cash_account_for(new.company_id, new.cash_location_id)),
                         'debit', 0, 'credit', new.amount)
    ),
    v_from.branch_id
  );
  return new;
end;
$$;

drop trigger if exists trg_yyy_cash_deposits_journal on public.cash_deposits;
create trigger trg_yyy_cash_deposits_journal
  after insert or update or delete on public.cash_deposits
  for each row execute function public.journal_on_cash_deposit();

-- ---------------------------------------------------------------------------
-- 10. Balances per location, and the proof that the control reconciles.
-- ---------------------------------------------------------------------------

create or replace view public.cash_location_balances
  with (security_invoker = true) as
  select cl.id            as cash_location_id,
         cl.company_id,
         cl.name,
         cl.location_type,
         cl.branch_id,
         b.name           as region_name,
         cl.coa_account_id,
         cl.opening_balance
           + coalesce(sum(jl.debit - jl.credit), 0) as balance
    from public.cash_locations cl
    left join public.branches b on b.id = cl.branch_id
    left join public.journal_lines jl on jl.account_id = cl.coa_account_id
   group by cl.id, cl.company_id, cl.name, cl.location_type, cl.branch_id,
            b.name, cl.coa_account_id, cl.opening_balance;

-- Sum(locations) vs the Cash control tree. `difference` must always be zero:
-- if it ever isn't, something posted straight to the control and bypassed a
-- location, which is the exact failure this section exists to make impossible.
create or replace view public.cash_control_reconciliation
  with (security_invoker = true) as
  with control as (
    select a.company_id, a.id as control_id
      from public.chart_of_accounts a
     where a.system_key = 'cash'
  ),
  direct_on_control as (
    select c.company_id, coalesce(sum(jl.debit - jl.credit), 0) as posted_direct
      from control c
      left join public.journal_lines jl on jl.account_id = c.control_id
     group by c.company_id
  ),
  children as (
    select c.company_id, coalesce(sum(jl.debit - jl.credit), 0) as posted_children
      from control c
      join public.chart_of_accounts ch on ch.parent_id = c.control_id
      left join public.journal_lines jl on jl.account_id = ch.id
     group by c.company_id
  )
  select d.company_id,
         d.posted_direct,
         coalesce(ch.posted_children, 0) as posted_children,
         d.posted_direct as difference
    from direct_on_control d
    left join children ch on ch.company_id = d.company_id;
