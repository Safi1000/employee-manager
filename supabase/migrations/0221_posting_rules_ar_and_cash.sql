-- 0221 — Phase 1 Part C (first tranche): AR / revenue / tax / cash posting rules.
--
-- Implements locked policy A1 (WHT at payment), A2 (output sales tax is a
-- liability), A4 (revenue at service month), A8 (custody float is an asset
-- transfer) and defect D2 (AP never cleared).
--
-- NOT in this migration — payroll (A5/A6/A7-recovery) and the profit waterfall
-- (A9 ii). Payroll is blocked on a genuine contradiction between A3/A5 and the
-- payslip arithmetic: on all 48 sandbox payslips
--     net_salary = final_salary - advance - eobi - income_tax
-- i.e. EOBI and income tax are EMPLOYEE deductions reducing net pay, whereas
-- A3 describes EOBI as an employer cost charged to the client. Both cannot be
-- true of the single `eobi` column. Raised rather than resolved.

-- ---------------------------------------------------------------------------
-- A1. WHT is captured per receipt — the deduction is only known when the
-- client pays, so it cannot be derived from the invoice.
-- ---------------------------------------------------------------------------

alter table public.invoice_payments
  add column if not exists withholding_amount numeric(14,2) not null default 0;

comment on column public.invoice_payments.withholding_amount is
  'Income tax deducted at source by the client on this receipt. Debited to WHT Receivable (asset); with `amount` it clears the full receivable.';

-- ---------------------------------------------------------------------------
-- A2 + A4. Invoice: AR gross, revenue net of sales tax, sales tax to
-- liability, dated to the SERVICE MONTH.
--
--   Dr  Accounts Receivable     invoice_amount            (gross, incl. sales tax)
--   Cr  Revenue                 invoice_amount - tax_added_total
--   Cr  Sales Tax Payable       tax_added_total
--
-- No WHT leg here — that lands at payment (A1).
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_invoice()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_gross   numeric;
  v_tax     numeric;
  v_revenue numeric;
  v_rev_key text;
  v_date    date;
  v_old_date date;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(
      old.company_id, 'invoices', old.id,
      coalesce(old.period_start, old.invoice_date));
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.invoice_amount is distinct from new.invoice_amount
       or coalesce(old.tax_added_total, 0) is distinct from coalesce(new.tax_added_total, 0)
       or old.period_start is distinct from new.period_start
       or old.invoice_date is distinct from new.invoice_date
       or old.client_id is distinct from new.client_id
       or old.branch_id is distinct from new.branch_id then
      v_old_date := coalesce(old.period_start, old.invoice_date);
      perform public.reverse_journal_for_source(new.company_id, 'invoices', new.id, v_old_date);
    else
      return new;
    end if;
  end if;

  -- A4: revenue belongs to the month the service was delivered.
  v_date    := coalesce(new.period_start, new.invoice_date);
  v_gross   := new.invoice_amount;
  v_tax     := coalesce(new.tax_added_total, 0);
  v_revenue := v_gross - v_tax;

  v_rev_key := 'revenue_security';
  begin
    select case when c.client_type = 'guard_deployment' then 'revenue_guard' else 'revenue_security' end
      into v_rev_key
    from public.clients c where c.id = new.client_id;
  exception when others then null;
  end;

  perform public.post_journal(
    new.company_id, v_date,
    'Invoice ' || coalesce(new.invoice_number, new.id::text),
    'invoices', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ar', 'debit', v_gross, 'credit', 0,
                         'client_id', new.client_id, 'contract_id', new.contract_id),
      jsonb_build_object('key', v_rev_key, 'debit', 0, 'credit', v_revenue,
                         'client_id', new.client_id, 'contract_id', new.contract_id),
      jsonb_build_object('key', 'sales_tax_payable', 'debit', 0, 'credit', v_tax,
                         'client_id', new.client_id)
    ),
    new.branch_id
  );
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- A1. Receipt: the WHT leg lands here.
--
--   Dr  Bank / Custodian Cash   amount
--   Dr  WHT Receivable          withholding_amount
--   Cr  Accounts Receivable     amount + withholding_amount
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_invoice_payment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_dr_line jsonb;
  v_wht     numeric;
  v_client  uuid;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'invoice_payments', old.id, old.payment_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or coalesce(old.withholding_amount, 0) is distinct from coalesce(new.withholding_amount, 0)
       or old.branch_id is distinct from new.branch_id
       or old.cash_location_id is distinct from new.cash_location_id then
      perform public.reverse_journal_for_source(new.company_id, 'invoice_payments', new.id, old.payment_date);
    else
      return new;
    end if;
  end if;

  v_wht := coalesce(new.withholding_amount, 0);
  v_client := coalesce(new.client_id, (select i.client_id from public.invoices i where i.id = new.invoice_id));

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
    jsonb_build_array(v_dr_line)
    || jsonb_build_array(
         jsonb_build_object('key', 'wht_receivable', 'debit', v_wht, 'credit', 0,
                            'client_id', v_client),
         jsonb_build_object('key', 'ar', 'debit', 0, 'credit', new.amount + v_wht,
                            'client_id', v_client)
       ),
    new.branch_id
  );
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- A1. record_invoice_payment: WHT no longer reduces the receivable at invoice
-- time. Outstanding is gross; a receipt clears cash + WHT together.
--
-- p_withholding is the total tax deducted on this receipt; it is apportioned
-- across the invoices the receipt settles, in the same oldest-first order.
-- ---------------------------------------------------------------------------

drop function if exists public.record_invoice_payment(uuid, numeric, date, text, uuid, text);

create function public.record_invoice_payment(
  p_invoice_id uuid, p_amount numeric, p_payment_date date, p_payment_mode text,
  p_bank_account_id uuid, p_notes text, p_withholding numeric default 0)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company        uuid;
  v_client         uuid;
  v_caller_company uuid := public.current_company_id();
  v_total          numeric := 0;
  v_wht_total      numeric := 0;
  v_wht            numeric := coalesce(p_withholding, 0);
  v_first_pay      uuid;
  v_pay_id         uuid;
  v_touched        int := 0;
  v_client_name    text;
  v_desc           text;
  v_wht_share      numeric;
  rec              record;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;
  if p_payment_mode not in ('Cash', 'Bank') then
    raise exception 'Invalid payment mode';
  end if;
  if p_payment_date is null then
    raise exception 'Payment date is required';
  end if;
  if v_wht < 0 then
    raise exception 'Withholding amount cannot be negative';
  end if;

  select company_id, client_id into v_company, v_client
  from public.invoices where id = p_invoice_id;
  if v_company is null then
    raise exception 'Invoice not found';
  end if;
  if v_caller_company is distinct from v_company then
    raise exception 'Not authorised for this company';
  end if;

  if p_payment_mode = 'Bank' then
    if p_bank_account_id is null then
      raise exception 'Select a bank account for Bank payments';
    end if;
    perform 1 from public.bank_accounts where id = p_bank_account_id and company_id = v_company;
    if not found then
      raise exception 'Bank account not found for this company';
    end if;
  end if;

  -- A1: outstanding is GROSS. WHT no longer reduces it here.
  for rec in
    with u as (
      select i.id,
             (i.invoice_amount - i.amount_received) as outstanding,
             row_number() over (order by i.invoice_date, i.invoice_number) as rn,
             count(*) over () as n,
             coalesce(sum(i.invoice_amount - i.amount_received)
                        over (order by i.invoice_date, i.invoice_number
                              rows between unbounded preceding and 1 preceding), 0) as cum_before
      from public.invoices i
      where i.client_id = v_client
        and (i.invoice_amount - i.amount_received) > 0.0001
    )
    select id,
           case when rn = n then (p_amount + v_wht - cum_before)
                else greatest(0, least(outstanding, p_amount + v_wht - cum_before)) end as settle
    from u
    order by rn
  loop
    continue when rec.settle <= 0.0001;
    -- Split each settlement into its cash and WHT components, pro rata.
    v_wht_share := case when (p_amount + v_wht) > 0
                        then round(rec.settle * v_wht / (p_amount + v_wht), 2) else 0 end;

    insert into public.invoice_payments
      (company_id, invoice_id, amount, withholding_amount, payment_date,
       payment_mode, bank_account_id, notes)
    values
      (v_company, rec.id, rec.settle - v_wht_share, v_wht_share, p_payment_date,
       p_payment_mode, p_bank_account_id, nullif(btrim(p_notes), ''))
    returning id into v_pay_id;

    if v_first_pay is null then v_first_pay := v_pay_id; end if;

    -- The receivable is cleared by cash AND withholding together.
    update public.invoices
      set amount_received = amount_received + rec.settle, updated_at = now()
      where id = rec.id;

    v_total     := v_total + (rec.settle - v_wht_share);
    v_wht_total := v_wht_total + v_wht_share;
    v_touched   := v_touched + 1;
  end loop;

  if v_touched = 0 then
    insert into public.invoice_payments
      (company_id, invoice_id, amount, withholding_amount, payment_date,
       payment_mode, bank_account_id, notes)
    values
      (v_company, p_invoice_id, p_amount, v_wht, p_payment_date,
       p_payment_mode, p_bank_account_id, nullif(btrim(p_notes), ''))
    returning id into v_pay_id;
    v_first_pay := v_pay_id;
    update public.invoices
      set amount_received = amount_received + p_amount + v_wht, updated_at = now()
      where id = p_invoice_id;
    v_total     := p_amount;
    v_wht_total := v_wht;
    v_touched   := 1;
  end if;

  if p_payment_mode = 'Bank' then
    update public.bank_accounts set balance = balance + v_total, updated_at = now()
      where id = p_bank_account_id;
  else
    update public.treasury set cash_balance = cash_balance + v_total, updated_at = now()
      where company_id = v_company;
    if not found then
      insert into public.treasury (company_id, cash_balance) values (v_company, v_total);
    end if;
  end if;

  select name into v_client_name from public.clients where id = v_client;
  v_desc := 'Payment received (' || lower(p_payment_mode) || ') · '
            || coalesce(v_client_name, 'Client') || ' · '
            || v_touched || ' invoice' || case when v_touched = 1 then '' else 's' end
            || ' (oldest first)'
            || case when v_wht_total > 0 then ' · WHT ' || v_wht_total else '' end;

  insert into public.bank_transactions
    (company_id, bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
  values
    (v_company, p_bank_account_id, 'receipt', v_total,
     case when p_payment_mode = 'Cash' then v_total else 0 end,
     case when p_payment_mode = 'Bank' then v_total else 0 end,
     v_desc, v_first_pay::text);

  return jsonb_build_object(
    'total_applied', v_total,
    'withholding_applied', v_wht_total,
    'invoices_touched', v_touched);
end;
$function$;

-- ---------------------------------------------------------------------------
-- D2. Accounts Payable is now cleared on settlement.
--
--   Dr  Accounts Payable   amount
--   Cr  Bank / Cash        amount
--
-- journal_on_expense raised the payable at expense_date; nothing ever
-- discharged it, so AP accumulated forever.
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_expense_settlement()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_date   date;
  v_cr     jsonb;
  v_was_paid boolean := coalesce(old.payable_status, '') = 'Paid';
  v_is_paid  boolean := coalesce(new.payable_status, '') = 'Paid';
begin
  if coalesce(new.payment_mode, '') <> 'Payable' then
    return new;
  end if;

  -- Settlement withdrawn: reverse.
  if v_was_paid and not v_is_paid then
    perform public.reverse_journal_for_source(
      old.company_id, 'expense_settlements', old.id,
      coalesce(old.paid_at::date, old.expense_date));
    return new;
  end if;

  if not v_is_paid or v_was_paid then
    return new;
  end if;

  v_date := coalesce(new.paid_at::date, current_date);

  v_cr := case
    when coalesce(new.paid_via, '') = 'Cash' then jsonb_build_object(
      'account_id', public.cash_account_for(new.company_id, new.cash_location_id),
      'debit', 0, 'credit', new.amount)
    else jsonb_build_object('key', 'bank', 'debit', 0, 'credit', new.amount)
  end;

  perform public.post_journal(
    new.company_id, v_date,
    'Payable settled' || coalesce(' — ' || new.description, ''),
    'expense_settlements', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ap', 'debit', new.amount, 'credit', 0,
                         'client_id', new.client_id)
    ) || jsonb_build_array(v_cr),
    new.branch_id
  );
  return new;
end;
$function$;

drop trigger if exists trg_yyy_expense_settlement_journal on public.expenses;
create trigger trg_yyy_expense_settlement_journal
  after update on public.expenses
  for each row execute function public.journal_on_expense_settlement();

-- ---------------------------------------------------------------------------
-- A8. Custody float is an asset transfer, never an expense.
--
--   Dr  Custodian Cash   amount
--   Cr  Bank             amount
--
-- record_bank_to_custodian wrote no journal line at all, which is why custody
-- float was invisible to the ledger.
-- ---------------------------------------------------------------------------

create or replace function public.record_bank_to_custodian(
  p_bank_account_id uuid, p_custodian_location_id uuid, p_amount numeric,
  p_date date, p_notes text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company uuid;
  v_bal     numeric;
  v_acct    uuid;
  v_branch  uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount_must_be_positive';
  end if;

  select balance, company_id into v_bal, v_company
    from public.bank_accounts where id = p_bank_account_id;
  if v_company is null then raise exception 'bank_not_found'; end if;
  if p_amount > v_bal then raise exception 'insufficient_bank_balance'; end if;

  update public.bank_accounts
     set balance = balance - p_amount, updated_at = now()
   where id = p_bank_account_id;

  update public.treasury
     set cash_balance = cash_balance + p_amount, updated_at = now()
   where company_id = v_company;
  if not found then
    insert into public.treasury (company_id, cash_balance) values (v_company, p_amount);
  end if;

  insert into public.bank_transactions
    (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
  values
    (p_bank_account_id, 'withdraw_to_cash', p_amount, p_amount, -p_amount,
     coalesce(nullif(btrim(p_notes), ''), 'Cash withdrawn to custodian'),
     p_custodian_location_id);

  -- A8: the ledger leg that was missing entirely.
  select coa_account_id, branch_id into v_acct, v_branch
    from public.cash_locations where id = p_custodian_location_id;
  if v_acct is null then
    v_acct := public.cash_account_for(v_company, p_custodian_location_id);
  end if;

  perform public.post_journal(
    v_company, coalesce(p_date, current_date),
    coalesce(nullif(btrim(p_notes), ''), 'Cash withdrawn to custodian'),
    'custody_float', p_custodian_location_id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_acct,  'debit', p_amount, 'credit', 0),
      jsonb_build_object('key',        'bank',  'debit', 0,        'credit', p_amount)
    ),
    v_branch);
end;
$function$;

-- ---------------------------------------------------------------------------
-- A8 (second half). A cleared CASH cheque handed to a custodian is the same
-- asset transfer, and today bypasses custody entirely into treasury.
--
-- Implemented as a separate trigger rather than by editing cheque_apply_balance
-- so the existing balance/lifecycle logic is untouched.
--
-- Payment cheques deliberately post NOTHING here: the linked expense / advance
-- / payslip already credits bank through its own trigger, and posting the
-- cheque too would double-count the outflow.
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_cheque()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_acct   uuid;
  v_branch uuid;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'cheques', old.id, old.cheque_date);
    return old;
  end if;

  -- Only outgoing CASH cheques move money the rest of the system does not post.
  if new.direction <> 'outgoing' or new.cheque_type <> 'cash' then
    return new;
  end if;

  -- Clearance withdrawn or bounced: reverse.
  if old.status = 'cleared' and new.status <> 'cleared' then
    perform public.reverse_journal_for_source(new.company_id, 'cheques', new.id, old.cheque_date);
    return new;
  end if;

  if new.status <> 'cleared' or old.status = 'cleared' then
    return new;
  end if;

  select coa_account_id, branch_id into v_acct, v_branch
    from public.cash_locations where id = new.custodian_location_id;
  if v_acct is null then
    v_acct := public.cash_account_for(new.company_id, new.custodian_location_id);
  end if;

  perform public.post_journal(
    new.company_id, new.cheque_date,
    'Cash cheque #' || coalesce(new.cheque_number, '') || ' cleared to custodian',
    'cheques', new.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_acct, 'debit', new.amount, 'credit', 0),
      jsonb_build_object('key',       'bank',  'debit', 0,          'credit', new.amount)
    ),
    coalesce(v_branch, new.branch_id));
  return new;
end;
$function$;

drop trigger if exists trg_yyy_cheques_journal on public.cheques;
create trigger trg_yyy_cheques_journal
  after update or delete on public.cheques
  for each row execute function public.journal_on_cheque();
