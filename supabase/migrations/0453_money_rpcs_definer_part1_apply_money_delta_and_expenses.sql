-- 0453 — Stage B part 1 of the money-movement pass: apply_money_delta and the
-- expense/advance family become SECURITY DEFINER with internal asserts.
--
-- WHY. Stage D gates treasury/cash on accounting.edit. These money RPCs are
-- SECURITY INVOKER today and lean on table RLS for TWO things at once: the
-- permission gate (a single-row UPDATE that RLS blocks affects 0 rows, and the
-- `v_n <> 1` check turns that into the "needs expenses.edit" refusal) AND the
-- tenant scope (company_members hides other companies' rows). Convert to DEFINER
-- and BOTH vanish silently — the UPDATE always finds its row and a SELECT by id
-- can reach any company. So each function must REPLACE the implicit RLS gate with
-- an explicit require_perm and guard EVERY uuid parameter with assert_same_company
-- / assert_branch_in_company (the tenant_guard_gaps() detector recognises only
-- those forms; a where-clause or a comment does not count). This is the mirror of
-- CLAUDE.md's "a set is not safe to convert to INVOKER": an INVOKER→DEFINER
-- conversion drops controls that must be restated in the body.
--
-- KEYS: expense + advance family -> expenses.edit (advances already say so in their
-- own error text). settle_payable_expense -> accounting.edit (DECIDED with Shayan:
-- it is the Accounting mark-paid flow; its user holds accounting.edit, may lack
-- expenses.edit). require_perm is skipped for trusted backend callers (auth.uid()
-- null: cron, service role, migrations) and inside triggers, matching set_shift_
-- split (0450); assert_same_company already passes for those same contexts.
--
-- TENANT COVERAGE: a fetch-by-id param (p_expense_id, p_advance_id) is asserted via
-- `(select company_id from T where id = p_param)` so the param name appears inside
-- the assert call and the row's own company is checked. Reference params (bank,
-- client, vendor, category, cheque, custodian, employee) are asserted null-safe.
-- Branch: assert_branch_in_company (company + detector coverage) and, where a user
-- may be branch-scoped, assert_branch_writable (the 0450 house pattern) for the
-- branch-user match.
--
-- apply_money_delta becomes DEFINER; its bank UPDATE gains `and company_id =
-- p_company` so a cross-company bank id cannot move another tenant's balance once
-- RLS no longer scopes it. Its EXECUTE grant is KEPT here and revoked from
-- authenticated only in Stage B part 3, after every parent that calls it is DEFINER.

-- ── apply_money_delta: the leaf mover ──────────────────────────────────────────
create or replace function public.apply_money_delta(
  p_company uuid, p_mode text, p_bank_account_id uuid, p_delta numeric,
  p_kind text, p_description text, p_reference_id text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_n int;
begin
  if p_company is null then
    raise exception 'A money movement needs a company. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  -- DEFINER now: RLS no longer scopes this. Assert the company and the account.
  perform public.assert_same_company(p_company);
  if p_bank_account_id is not null then
    perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id));
  end if;
  if p_delta is null or p_delta = 0 then
    return;
  end if;

  if p_mode = 'Cash' then
    update public.treasury
       set cash_balance = cash_balance + p_delta, updated_at = now()
     where company_id = p_company;
    get diagnostics v_n = row_count;

    if v_n = 0 then
      if exists (select 1 from public.treasury t where t.company_id = p_company) then
        raise exception
          'The cash balance could not be updated. Nothing has been recorded.'
          using errcode = '42501';
      end if;
      insert into public.treasury (company_id, cash_balance) values (p_company, p_delta);
    elsif v_n > 1 then
      raise exception
        'There are % treasury rows for this company, so the cash balance is ambiguous. Nothing has been recorded.', v_n
        using errcode = 'P0001';
    end if;

  elsif p_mode = 'Bank' then
    if p_bank_account_id is null then
      raise exception 'A bank movement needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
    end if;

    -- company-scoped: a bank id from another tenant finds no row and is refused,
    -- rather than silently moving that tenant's balance under DEFINER.
    update public.bank_accounts
       set balance = balance + p_delta, updated_at = now()
     where id = p_bank_account_id and company_id = p_company;
    get diagnostics v_n = row_count;

    if v_n <> 1 then
      raise exception
        'That bank account does not exist, or belongs to another company. Nothing has been recorded.'
        using errcode = 'P0001';
    end if;

  else
    return;   -- Cheque and Payable move no balance and log nothing.
  end if;

  insert into public.bank_transactions
    (company_id, bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
  values (
    p_company,
    case when p_mode = 'Bank' then p_bank_account_id end,
    p_kind, abs(p_delta),
    case when p_mode = 'Cash' then p_delta else 0 end,
    case when p_mode = 'Bank' then p_delta else 0 end,
    p_description, p_reference_id);
end;
$function$;

-- ── record_expense ─────────────────────────────────────────────────────────────
create or replace function public.record_expense(
  p_category_id uuid, p_amount numeric, p_expense_date date, p_payment_mode text,
  p_client_id uuid default null, p_branch_id uuid default null, p_vendor_id uuid default null,
  p_description text default null, p_custodian_location_id uuid default null,
  p_bank_account_id uuid default null, p_cheque_id uuid default null, p_due_date date default null,
  p_notes text default null, p_expense_by uuid default null, p_coverage_start date default null,
  p_coverage_end date default null, p_service_start date default null, p_service_end date default null,
  p_pl_category text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_id      uuid;
  v_company uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('expenses.edit'); end if;
  perform public.assert_branch_in_company(p_branch_id);
  perform public.assert_branch_writable(p_branch_id);
  if p_category_id          is not null then perform public.assert_same_company((select company_id from public.expense_categories where id = p_category_id)); end if;
  if p_client_id            is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;
  if p_vendor_id            is not null then perform public.assert_same_company((select company_id from public.vendors where id = p_vendor_id)); end if;
  if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;
  if p_bank_account_id      is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  if p_cheque_id            is not null then perform public.assert_same_company((select company_id from public.cheques where id = p_cheque_id)); end if;
  if p_expense_by           is not null then perform public.assert_same_company((select company_id from public.employees where id = p_expense_by)); end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'An expense needs an amount greater than zero.' using errcode = 'P0001';
  end if;
  if p_payment_mode is null then
    raise exception 'An expense needs a payment mode.' using errcode = 'P0001';
  end if;
  if p_payment_mode = 'Bank' and p_bank_account_id is null then
    raise exception 'A bank-paid expense needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  insert into public.expenses (
    category_id, pl_category, client_id, branch_id, vendor_id, description,
    amount, expense_date, payment_mode, custodian_location_id, bank_account_id,
    cheque_id, due_date, payable_status, notes, expense_by,
    coverage_start, coverage_end, service_start, service_end)
  values (
    p_category_id,
    coalesce(
      p_pl_category,
      case when p_client_id is not null then 'cost_of_services' else 'operating_expense' end
    )::public.expense_pl_category,
    p_client_id, p_branch_id, p_vendor_id, p_description,
    p_amount, p_expense_date, p_payment_mode, p_custodian_location_id,
    p_bank_account_id, p_cheque_id, p_due_date,
    case when p_payment_mode = 'Payable' then 'Pending' end,
    p_notes, p_expense_by,
    p_coverage_start, p_coverage_end, p_service_start, p_service_end)
  returning id, company_id into v_id, v_company;

  if v_company is null then
    raise exception 'The expense was written with no company. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  perform public.apply_money_delta(
    v_company, p_payment_mode, p_bank_account_id, -p_amount,
    'expense', public.describe_expense(p_category_id, p_client_id, p_description), v_id::text);

  return v_id;
end;
$function$;

-- ── amend_expense ──────────────────────────────────────────────────────────────
create or replace function public.amend_expense(
  p_expense_id uuid, p_category_id uuid, p_amount numeric, p_expense_date date, p_payment_mode text,
  p_client_id uuid default null, p_branch_id uuid default null, p_vendor_id uuid default null,
  p_description text default null, p_custodian_location_id uuid default null, p_bank_account_id uuid default null,
  p_cheque_id uuid default null, p_due_date date default null, p_notes text default null,
  p_expense_by uuid default null, p_coverage_start date default null, p_coverage_end date default null,
  p_service_start date default null, p_service_end date default null, p_receipt_path text default null,
  p_drive_file_id text default null, p_drive_view_url text default null, p_receipt_file_name text default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_n       int;
  v_company uuid;
  v_prev    record;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('expenses.edit'); end if;
  perform public.assert_same_company((select company_id from public.expenses where id = p_expense_id));
  perform public.assert_branch_in_company(p_branch_id);
  perform public.assert_branch_writable(p_branch_id);
  if p_category_id          is not null then perform public.assert_same_company((select company_id from public.expense_categories where id = p_category_id)); end if;
  if p_client_id            is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;
  if p_vendor_id            is not null then perform public.assert_same_company((select company_id from public.vendors where id = p_vendor_id)); end if;
  if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;
  if p_bank_account_id      is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  if p_cheque_id            is not null then perform public.assert_same_company((select company_id from public.cheques where id = p_cheque_id)); end if;
  if p_expense_by           is not null then perform public.assert_same_company((select company_id from public.employees where id = p_expense_by)); end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'An expense needs an amount greater than zero.' using errcode = 'P0001';
  end if;
  if p_payment_mode = 'Bank' and p_bank_account_id is null then
    raise exception 'A bank-paid expense needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  select company_id, payment_mode, payable_status, paid_via, paid_bank_account_id, paid_at
    into v_prev from public.expenses where id = p_expense_id;
  if v_prev.company_id is null then
    raise exception
      'That expense does not exist, or you cannot see it. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;
  v_company := v_prev.company_id;

  perform public.expense_reverse_money(p_expense_id, 'Reverse expense (edit)');

  update public.expenses set
    category_id = p_category_id,
    pl_category = (case when p_client_id is not null then 'cost_of_services'
                        else 'operating_expense' end)::public.expense_pl_category,
    client_id = p_client_id,
    branch_id = p_branch_id,
    vendor_id = p_vendor_id,
    description = p_description,
    amount = p_amount,
    expense_date = p_expense_date,
    payment_mode = p_payment_mode,
    custodian_location_id = p_custodian_location_id,
    bank_account_id = case
      when p_payment_mode = 'Bank' then p_bank_account_id
      when p_payment_mode = 'Cheque' then (select c.bank_account_id from public.cheques c where c.id = p_cheque_id)
      else null end,
    cheque_id = case when p_payment_mode = 'Cheque' then p_cheque_id else null end,
    due_date = case when p_payment_mode = 'Payable' then p_due_date else null end,
    payable_status = case
      when p_payment_mode <> 'Payable' then null
      when v_prev.payment_mode = 'Payable' then coalesce(v_prev.payable_status, 'Pending')
      else 'Pending' end,
    paid_via = case when p_payment_mode = 'Payable' then v_prev.paid_via else null end,
    paid_bank_account_id = case when p_payment_mode = 'Payable' then v_prev.paid_bank_account_id else null end,
    paid_at = case when p_payment_mode = 'Payable' then v_prev.paid_at else null end,
    coverage_start = p_coverage_start,
    coverage_end = p_coverage_end,
    service_start = p_service_start,
    service_end = p_service_end,
    notes = p_notes,
    expense_by = p_expense_by,
    receipt_path = p_receipt_path,
    drive_file_id = p_drive_file_id,
    drive_view_url = p_drive_view_url,
    receipt_file_name = p_receipt_file_name,
    updated_at = now()
  where id = p_expense_id;
  get diagnostics v_n = row_count;

  if v_n <> 1 then
    raise exception
      'Editing an expense needs the expenses.edit permission. Nothing has been recorded.'
      using errcode = '42501';
  end if;

  if p_payment_mode <> 'Payable' then
    perform public.apply_money_delta(
      v_company, p_payment_mode, p_bank_account_id, -p_amount,
      'expense', public.describe_expense(p_category_id, p_client_id, p_description),
      p_expense_id::text);
  end if;
end;
$function$;

-- ── expense_reverse_money ──────────────────────────────────────────────────────
create or replace function public.expense_reverse_money(p_expense_id uuid, p_label text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare e record;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('expenses.edit'); end if;
  perform public.assert_same_company((select company_id from public.expenses where id = p_expense_id));
  select id, company_id, amount, payment_mode, bank_account_id,
         payable_status, paid_via, paid_bank_account_id,
         category_id, client_id, description
    into e
    from public.expenses where id = p_expense_id;

  if e.id is null then
    raise exception
      'That expense does not exist, or you cannot see it. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;

  if e.payment_mode = 'Payable' then
    if e.payable_status = 'Paid' then
      perform public.apply_money_delta(
        e.company_id, e.paid_via, e.paid_bank_account_id, e.amount,
        'expense', p_label || ' · ' || public.describe_expense(e.category_id, e.client_id, e.description),
        e.id::text);
    end if;
  else
    perform public.apply_money_delta(
      e.company_id, e.payment_mode, e.bank_account_id, e.amount,
      'expense', p_label || ' · ' || public.describe_expense(e.category_id, e.client_id, e.description),
      e.id::text);
  end if;
end;
$function$;

-- ── settle_payable_expense (accounting.edit — DECIDED) ─────────────────────────
create or replace function public.settle_payable_expense(
  p_expense_id uuid, p_paid_via text, p_paid_bank_account_id uuid default null,
  p_custodian_location_id uuid default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_n int; e record;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  perform public.assert_same_company((select company_id from public.expenses where id = p_expense_id));
  if p_paid_bank_account_id  is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_paid_bank_account_id)); end if;
  if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;

  if p_paid_via not in ('Cash', 'Bank') then
    raise exception 'A payable is settled in Cash or Bank, not %.', p_paid_via using errcode = 'P0001';
  end if;
  if p_paid_via = 'Bank' and p_paid_bank_account_id is null then
    raise exception 'Settling a payable by bank needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  select id, company_id, amount, payment_mode, payable_status, vendor_id
    into e from public.expenses where id = p_expense_id;
  if e.id is null then
    raise exception 'That payable does not exist, or you cannot see it. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if e.payment_mode <> 'Payable' then
    raise exception 'That expense is not a payable, so there is nothing to settle.' using errcode = '23514';
  end if;
  if e.payable_status = 'Paid' then
    raise exception 'That payable is already settled. Nothing has been recorded.' using errcode = '23514';
  end if;

  update public.expenses set
    payable_status = 'Paid',
    paid_via = p_paid_via,
    paid_bank_account_id = case when p_paid_via = 'Bank' then p_paid_bank_account_id else null end,
    custodian_location_id = case when p_paid_via = 'Cash' then p_custodian_location_id else null end,
    paid_at = now(),
    updated_at = now()
  where id = p_expense_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception
      'Settling a payable needs the accounting.edit permission. Nothing has been recorded.'
      using errcode = '42501';
  end if;

  perform public.apply_money_delta(
    e.company_id, p_paid_via, p_paid_bank_account_id, -e.amount,
    'expense',
    'Payable settled (' || lower(p_paid_via) || ') · '
      || coalesce((select v.name from public.vendors v where v.id = e.vendor_id), 'vendor'),
    e.id::text);
end;
$function$;

-- ── record_advance ─────────────────────────────────────────────────────────────
create or replace function public.record_advance(
  p_employee_id uuid, p_amount numeric, p_advance_date date, p_payment_mode text,
  p_client_id uuid default null, p_bank_account_id uuid default null, p_cheque_id uuid default null,
  p_custodian_location_id uuid default null, p_notes text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_id uuid; v_company uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('expenses.edit'); end if;
  if p_employee_id          is not null then perform public.assert_same_company((select company_id from public.employees where id = p_employee_id)); end if;
  if p_client_id            is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;
  if p_bank_account_id      is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  if p_cheque_id            is not null then perform public.assert_same_company((select company_id from public.cheques where id = p_cheque_id)); end if;
  if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'An advance needs an amount greater than zero.' using errcode = 'P0001';
  end if;
  if p_payment_mode = 'Bank' and p_bank_account_id is null then
    raise exception 'A bank advance needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  insert into public.advances
    (employee_id, client_id, amount, advance_date, payment_mode,
     bank_account_id, cheque_id, custodian_location_id, notes)
  values
    (p_employee_id, p_client_id, p_amount, p_advance_date, p_payment_mode,
     case
       when p_payment_mode = 'Bank' then p_bank_account_id
       when p_payment_mode = 'Cheque' then (select c.bank_account_id from public.cheques c where c.id = p_cheque_id)
       else null end,
     case when p_payment_mode = 'Cheque' then p_cheque_id else null end,
     p_custodian_location_id, p_notes)
  returning id, company_id into v_id, v_company;

  if v_company is null then
    raise exception 'The advance was written with no company. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  perform public.apply_money_delta(
    v_company, p_payment_mode, p_bank_account_id, -p_amount,
    'advance', public.describe_advance(p_employee_id, p_client_id), v_id::text);

  return v_id;
end;
$function$;

-- ── amend_advance ──────────────────────────────────────────────────────────────
create or replace function public.amend_advance(
  p_advance_id uuid, p_employee_id uuid, p_amount numeric, p_advance_date date, p_payment_mode text,
  p_client_id uuid default null, p_bank_account_id uuid default null, p_cheque_id uuid default null,
  p_custodian_location_id uuid default null, p_notes text default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_n int; v_company uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('expenses.edit'); end if;
  perform public.assert_same_company((select company_id from public.advances where id = p_advance_id));
  if p_employee_id          is not null then perform public.assert_same_company((select company_id from public.employees where id = p_employee_id)); end if;
  if p_client_id            is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;
  if p_bank_account_id      is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  if p_cheque_id            is not null then perform public.assert_same_company((select company_id from public.cheques where id = p_cheque_id)); end if;
  if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'An advance needs an amount greater than zero.' using errcode = 'P0001';
  end if;
  if p_payment_mode = 'Bank' and p_bank_account_id is null then
    raise exception 'A bank advance needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  select company_id into v_company from public.advances where id = p_advance_id;
  if v_company is null then
    raise exception
      'That advance does not exist, or you cannot see it. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;

  perform public.advance_reverse_money(p_advance_id, 'Reverse advance (edit)');

  update public.advances set
    employee_id = p_employee_id,
    client_id = p_client_id,
    amount = p_amount,
    advance_date = p_advance_date,
    payment_mode = p_payment_mode,
    bank_account_id = case
      when p_payment_mode = 'Bank' then p_bank_account_id
      when p_payment_mode = 'Cheque' then (select c.bank_account_id from public.cheques c where c.id = p_cheque_id)
      else null end,
    cheque_id = case when p_payment_mode = 'Cheque' then p_cheque_id else null end,
    custodian_location_id = p_custodian_location_id,
    notes = p_notes,
    updated_at = now()
  where id = p_advance_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception
      'Editing an advance needs the expenses.edit permission. Nothing has been recorded.'
      using errcode = '42501';
  end if;

  perform public.apply_money_delta(
    v_company, p_payment_mode, p_bank_account_id, -p_amount,
    'advance', public.describe_advance(p_employee_id, p_client_id), p_advance_id::text);
end;
$function$;

-- ── advance_reverse_money ──────────────────────────────────────────────────────
create or replace function public.advance_reverse_money(p_advance_id uuid, p_label text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare a record;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('expenses.edit'); end if;
  perform public.assert_same_company((select company_id from public.advances where id = p_advance_id));
  select id, company_id, amount, payment_mode, bank_account_id, employee_id, client_id
    into a from public.advances where id = p_advance_id;
  if a.id is null then
    raise exception
      'That advance does not exist, or you cannot see it. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;

  perform public.apply_money_delta(
    a.company_id, a.payment_mode, a.bank_account_id, a.amount,
    'advance', p_label || ' · ' || public.describe_advance(a.employee_id, a.client_id),
    a.id::text);
end;
$function$;

-- ── verification ───────────────────────────────────────────────────────────────
do $mig$
declare v_bad text;
begin
  select string_agg(proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('apply_money_delta','record_expense','amend_expense','expense_reverse_money',
     'settle_payable_expense','record_advance','amend_advance','advance_reverse_money')
    and not p.prosecdef;
  if v_bad is not null then
    raise exception '0453 FAILED: these should be SECURITY DEFINER but are not: %', v_bad;
  end if;
end $mig$;

-- Converting to DEFINER can open a tenant gap; assert the detector is clean.
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0453 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
