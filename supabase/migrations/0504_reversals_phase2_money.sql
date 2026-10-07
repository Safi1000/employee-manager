-- 0504 — Reversals, phase 2: every other money action.
--
-- Two shapes, chosen per action and never mixed:
--
--   UNDO   the action already has a tested undo that moves the ledger and the
--          balance together. Call it. (expense, payable settlement, advance,
--          vendor payment, partner entry, open payroll adjustment.) The row it
--          removes is kept in reversals.before.
--   COUNTER the action is a movement between two of our own places (bank to
--          bank, bank to custodian, custodian to custodian, custodian to bank).
--          Record the same movement the other way through the function that
--          records it, so the balance, the bank log and the journal all come
--          from the code that already does them. Nothing is deleted.
--
-- And three that are neither: a cheque clearance (status back to pending — the
-- cheque trigger already undoes clearance), a write-off and a manual journal
-- (one journal entry each, reversed by reverse_journal_entry from 0502), and a
-- settled pay-now adjustment (its settlement entry and money, then its accrual).
--
-- A source in a CLOSED month whose undo deletes a row is refused by the period
-- lock; each such reversal names the month as a blocker instead.

-- ===========================================================================
-- EXPENSE
-- ===========================================================================
create or replace function public.reverse_expense(p_expense_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare x record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.expenses where id = p_expense_id));
  perform public.reversal_check('expense', p_expense_id, p_reason, p_preview);
  select * into x from public.expenses where id = p_expense_id for update;
  if x.id is null then raise exception 'That expense no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Expense PKR ' || to_char(x.amount, 'FM999,999,999') || ' · '
          || coalesce((select name from public.expense_categories where id = x.category_id), 'Expense')
          || coalesce(' · ' || nullif(btrim(x.description), ''), '');

  if public.is_period_closed(x.company_id, x.expense_date) then
    v_b := array_append(v_b, ('Its month (' || to_char(x.expense_date, 'Mon YYYY') || ') is closed. Reopen it in Period Close, then reverse.')::text);
  end if;
  if exists (select 1 from public.payable_payments pp where pp.expense_id = x.id) then
    v_b := array_append(v_b, 'It was paid through a vendor payment. Reverse that vendor payment first.'::text);
  end if;
  if x.cheque_id is not null and exists (select 1 from public.cheques c where c.id = x.cheque_id and c.status = 'cleared') then
    v_b := array_append(v_b, 'It was paid by a cheque that has cleared. Reverse the cheque clearance first.'::text);
  end if;

  if x.payment_mode in ('Cash', 'Bank') then
    v_e := array_append(v_e, ('PKR ' || to_char(x.amount, 'FM999,999,999') || ' goes back to ' || lower(x.payment_mode) || '.')::text);
  elsif x.payment_mode = 'Payable' and x.payable_status = 'Paid' then
    v_e := array_append(v_e, ('The settled PKR ' || to_char(x.amount, 'FM999,999,999') || ' goes back to ' || lower(coalesce(x.paid_via, 'its account')) || '.')::text);
  else
    v_e := array_append(v_e, 'No balance moves (it was never paid out).'::text);
  end if;
  v_e := array_append(v_e, 'The expense and its journal entry are reversed; the record is kept in the reversal.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('expense', p_expense_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.delete_expense(p_expense_id);
  v_rid := public.reversal_finish(x.company_id, 'expense', x.id, v_title, 'error', p_reason, to_jsonb(x), v_e);
  return public.reversal_result('expense', p_expense_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- PAYABLE SETTLEMENT (a payable marked paid directly, not via a vendor payment)
-- ===========================================================================
create or replace function public.reverse_payable_settlement(p_expense_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare x record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.expenses where id = p_expense_id));
  perform public.reversal_check('payable_settlement', p_expense_id, p_reason, p_preview,
    (select coalesce(paid_at, updated_at) from public.expenses where id = p_expense_id));
  select * into x from public.expenses where id = p_expense_id for update;
  if x.id is null then raise exception 'That payable no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Payable settled PKR ' || to_char(x.amount, 'FM999,999,999') || coalesce(' · ' || nullif(btrim(x.description), ''), '');

  if x.payment_mode <> 'Payable' or x.payable_status <> 'Paid' then
    v_b := array_append(v_b, 'This is not a settled payable.'::text);
  end if;
  if exists (select 1 from public.payable_payments pp where pp.expense_id = x.id) then
    v_b := array_append(v_b, 'It was settled by a vendor payment. Reverse the vendor payment instead.'::text);
  end if;
  v_e := array_append(v_e, ('PKR ' || to_char(x.amount, 'FM999,999,999') || ' goes back to ' || lower(coalesce(x.paid_via, 'its account')) || '.')::text);
  v_e := array_append(v_e, 'The payable is Pending again and still owed to the vendor.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('payable_settlement', p_expense_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.revert_payable_expense(p_expense_id);
  v_rid := public.reversal_finish(x.company_id, 'payable_settlement', x.id, v_title, 'error', p_reason, to_jsonb(x), v_e);
  return public.reversal_result('payable_settlement', p_expense_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- ADVANCE (a real advance — the payroll carry-forward rows are payroll's)
-- ===========================================================================
create or replace function public.reverse_advance(p_advance_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare x record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_name text;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.advances where id = p_advance_id));
  perform public.reversal_check('advance', p_advance_id, p_reason, p_preview);
  select * into x from public.advances where id = p_advance_id for update;
  if x.id is null then raise exception 'That advance no longer exists.' using errcode = 'P0001'; end if;
  select full_name into v_name from public.employees where id = x.employee_id;
  v_title := 'Advance PKR ' || to_char(x.amount, 'FM999,999,999') || ' · '
          || coalesce(public.employee_display_code(x.employee_id) || ' ', '') || coalesce(v_name, '');

  if x.payment_mode = 'Carry-forward' then
    v_b := array_append(v_b, 'This is a payroll overpayment carry-forward. Reverse the salary disbursement that created it.'::text);
  end if;
  if public.is_period_closed(x.company_id, x.advance_date) then
    v_b := array_append(v_b, ('Its month (' || to_char(x.advance_date, 'Mon YYYY') || ') is closed. Reopen it in Period Close, then reverse.')::text);
  end if;
  -- Recovered already: a disbursed payslip from the month before the advance on
  -- (0500 lets an advance reach the previous, undisbursed month) deducted one.
  if exists (select 1 from public.payslips p
              where p.employee_id = x.employee_id and p.disbursed and coalesce(p.advance, 0) > 0
                and p.period_month >= (date_trunc('month', x.advance_date) - interval '1 month')::date) then
    v_b := array_append(v_b, 'A disbursed payslip has already deducted advances from him since this one. Reverse that disbursement first.'::text);
  end if;
  if x.cheque_id is not null and exists (select 1 from public.cheques c where c.id = x.cheque_id and c.status = 'cleared') then
    v_b := array_append(v_b, 'It was paid by a cheque that has cleared. Reverse the cheque clearance first.'::text);
  end if;

  if x.payment_mode in ('Cash', 'Bank') then
    v_e := array_append(v_e, ('PKR ' || to_char(x.amount, 'FM999,999,999') || ' goes back to ' || lower(x.payment_mode) || '.')::text);
  end if;
  v_e := array_append(v_e, 'He no longer owes it; nothing will be deducted for it.'::text);
  v_e := array_append(v_e, 'The advance and its journal entry are reversed; the record is kept in the reversal.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('advance', p_advance_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.delete_advance(p_advance_id);
  v_rid := public.reversal_finish(x.company_id, 'advance', x.id, v_title, 'error', p_reason, to_jsonb(x), v_e);
  return public.reversal_result('advance', p_advance_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- VENDOR PAYMENT
-- ===========================================================================
create or replace function public.reverse_vendor_payment(p_vendor_payment_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare x record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_cnt int;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.vendor_payments where id = p_vendor_payment_id));
  perform public.reversal_check('vendor_payment', p_vendor_payment_id, p_reason, p_preview);
  select * into x from public.vendor_payments where id = p_vendor_payment_id for update;
  if x.id is null then raise exception 'That vendor payment no longer exists.' using errcode = 'P0001'; end if;
  select count(*) into v_cnt from public.payable_payments where vendor_payment_id = x.id;
  v_title := 'Vendor payment PKR ' || to_char(x.amount, 'FM999,999,999') || ' · '
          || coalesce((select name from public.vendors where id = x.vendor_id), 'Vendor');

  v_e := array_append(v_e, ('PKR ' || to_char(x.amount, 'FM999,999,999') || ' goes back to ' || lower(x.paid_via) || '.')::text);
  v_e := array_append(v_e, (v_cnt || ' bill(s) it settled are Pending and owed to the vendor again.')::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('vendor_payment', p_vendor_payment_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.revert_vendor_payment(p_vendor_payment_id);
  v_rid := public.reversal_finish(x.company_id, 'vendor_payment', x.id, v_title, 'error', p_reason, to_jsonb(x), v_e);
  return public.reversal_result('vendor_payment', p_vendor_payment_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- BANK TRANSFER — source is the transfer pair id
-- ===========================================================================
create or replace function public.reverse_bank_transfer(p_pair_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare v_from record; v_to record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_co uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select max(company_id::text)::uuid from public.bank_transactions where transfer_pair_id = p_pair_id));
  perform public.reversal_check('bank_transfer', p_pair_id, p_reason, p_preview);
  select * into v_from from public.bank_transactions where transfer_pair_id = p_pair_id and account_delta < 0 limit 1;
  select * into v_to   from public.bank_transactions where transfer_pair_id = p_pair_id and account_delta > 0 limit 1;
  if v_from.id is null or v_to.id is null then raise exception 'That transfer no longer exists.' using errcode = 'P0001'; end if;
  v_co := v_from.company_id;
  v_title := 'Transfer PKR ' || to_char(v_from.amount, 'FM999,999,999') || ' · ' || coalesce(v_from.description, '');

  v_e := array_append(v_e, ('PKR ' || to_char(v_from.amount, 'FM999,999,999') || ' is transferred back from '
         || (select bank_name from public.bank_accounts where id = v_to.bank_account_id) || ' to '
         || (select bank_name from public.bank_accounts where id = v_from.bank_account_id) || ', dated today.')::text);
  v_e := array_append(v_e, 'The original transfer stays in the history; the reversal is its mirror image.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('bank_transfer', p_pair_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.record_bank_transfer(v_to.bank_account_id, v_from.bank_account_id, v_from.amount, current_date,
                                      'Reversal: ' || btrim(p_reason));
  v_rid := public.reversal_finish(v_co, 'bank_transfer', p_pair_id, v_title, 'error', p_reason,
                                  jsonb_build_object('from', to_jsonb(v_from), 'to', to_jsonb(v_to)), v_e);
  return public.reversal_result('bank_transfer', p_pair_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- BANK -> CUSTODIAN (cash withdrawn to an office-staff member)
-- ===========================================================================
create or replace function public.reverse_bank_to_custodian(p_transaction_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare t record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_loc uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.bank_transactions where id = p_transaction_id));
  perform public.reversal_check('bank_to_custodian', p_transaction_id, p_reason, p_preview);
  select * into t from public.bank_transactions where id = p_transaction_id;
  if t.id is null or t.kind <> 'withdraw_to_cash' then raise exception 'That is not a cash withdrawal.' using errcode = 'P0001'; end if;
  v_loc := nullif(t.reference_id, '')::uuid;
  v_title := 'Cash withdrawn PKR ' || to_char(t.amount, 'FM999,999,999') || ' to '
          || coalesce((select name from public.cash_locations where id = v_loc), 'custodian');

  if v_loc is null then
    v_b := array_append(v_b, 'This withdrawal names no custodian, so it cannot be mirrored.'::text);
  end if;
  v_e := array_append(v_e, ('PKR ' || to_char(t.amount, 'FM999,999,999') || ' is deposited back from the custodian into '
         || coalesce((select bank_name from public.bank_accounts where id = t.bank_account_id), 'the bank') || ', dated today (a deposit slip is issued for it).')::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('bank_to_custodian', p_transaction_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.record_cash_deposit(t.bank_account_id, t.amount, current_date, 'Reversal of cash withdrawal: ' || btrim(p_reason), v_loc);
  v_rid := public.reversal_finish(t.company_id, 'bank_to_custodian', t.id, v_title, 'error', p_reason, to_jsonb(t), v_e);
  return public.reversal_result('bank_to_custodian', p_transaction_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- CUSTODY TRANSFER (custodian -> custodian)
-- ===========================================================================
create or replace function public.reverse_custody_transfer(p_transfer_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare t record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.custody_transfers where id = p_transfer_id));
  perform public.reversal_check('custody_transfer', p_transfer_id, p_reason, p_preview);
  select * into t from public.custody_transfers where id = p_transfer_id;
  if t.id is null then raise exception 'That custody transfer no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Custody transfer PKR ' || to_char(t.amount, 'FM999,999,999') || ' · '
          || coalesce((select name from public.cash_locations where id = t.from_location_id), '?') || ' → '
          || coalesce((select name from public.cash_locations where id = t.to_location_id), '?');
  v_e := array_append(v_e, ('PKR ' || to_char(t.amount, 'FM999,999,999') || ' is transferred back the other way, dated today.')::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('custody_transfer', p_transfer_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.record_custody_transfer(t.to_location_id, t.from_location_id, t.amount, current_date, 'Reversal: ' || btrim(p_reason));
  v_rid := public.reversal_finish(t.company_id, 'custody_transfer', t.id, v_title, 'error', p_reason, to_jsonb(t), v_e);
  return public.reversal_result('custody_transfer', p_transfer_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- CASH DEPOSIT (custodian -> bank)
-- ===========================================================================
create or replace function public.reverse_cash_deposit(p_deposit_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare t record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_bal numeric;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.cash_deposits where id = p_deposit_id));
  perform public.reversal_check('cash_deposit', p_deposit_id, p_reason, p_preview);
  select * into t from public.cash_deposits where id = p_deposit_id;
  if t.id is null then raise exception 'That deposit no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Cash deposit slip #' || t.slip_number || ' · PKR ' || to_char(t.amount, 'FM999,999,999');
  select balance into v_bal from public.bank_accounts where id = t.bank_account_id;

  if t.cash_location_id is null then
    v_b := array_append(v_b, 'This deposit names no custodian, so the cash has nowhere to go back to.'::text);
  end if;
  if coalesce(v_bal, 0) < t.amount then
    v_b := array_append(v_b, ('The bank holds only PKR ' || to_char(coalesce(v_bal, 0), 'FM999,999,999') || ' now, less than the deposit.')::text);
  end if;
  v_e := array_append(v_e, ('PKR ' || to_char(t.amount, 'FM999,999,999') || ' is withdrawn back to '
         || coalesce((select name from public.cash_locations where id = t.cash_location_id), 'the custodian') || ', dated today.')::text);
  v_e := array_append(v_e, 'The deposit slip stays in the history; the reversal is its mirror image.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('cash_deposit', p_deposit_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.record_bank_to_custodian(t.bank_account_id, t.cash_location_id, t.amount, current_date,
                                          'Reversal of deposit slip #' || t.slip_number || ': ' || btrim(p_reason));
  v_rid := public.reversal_finish(t.company_id, 'cash_deposit', t.id, v_title, 'error', p_reason, to_jsonb(t), v_e);
  return public.reversal_result('cash_deposit', p_deposit_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- CHEQUE CLEARANCE (cleared -> pending; the cheque trigger undoes the money)
-- ===========================================================================
create or replace function public.reverse_cheque_clearance(p_cheque_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare c record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.cheques where id = p_cheque_id));
  perform public.reversal_check('cheque_clearance', p_cheque_id, p_reason, p_preview,
    (select coalesce(cleared_at, updated_at) from public.cheques where id = p_cheque_id));
  select * into c from public.cheques where id = p_cheque_id for update;
  if c.id is null then raise exception 'That cheque no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Cheque #' || c.cheque_number || ' cleared · PKR ' || to_char(c.amount, 'FM999,999,999');

  if c.status <> 'cleared' then
    v_b := array_append(v_b, ('This cheque is ' || c.status || ', not cleared.')::text);
  end if;
  if c.direction = 'incoming' and exists (
       select 1 from public.invoice_payments ip
        where ip.cheque_id = c.id and public.is_period_closed(ip.company_id, ip.payment_date)) then
    v_b := array_append(v_b, 'The receipt this cheque created is in a closed month. Reopen it in Period Close, then reverse.'::text);
  end if;

  if c.direction = 'incoming' then
    v_e := array_append(v_e, ('PKR ' || to_char(c.amount, 'FM999,999,999') || ' comes back out of the bank; the cheque is pending again.')::text);
    if c.invoice_id is not null or c.client_id is not null then
      v_e := array_append(v_e, 'The client receipt the clearance created is removed and the invoice is owed again.'::text);
    end if;
  elsif c.cheque_type = 'cash' then
    v_e := array_append(v_e, ('PKR ' || to_char(c.amount, 'FM999,999,999') || ' comes back out of cash in hand; the cheque is pending again.')::text);
  else
    v_e := array_append(v_e, 'The payment cheque is pending again (it reserved the bank when issued, so no balance moves).'::text);
  end if;

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('cheque_clearance', p_cheque_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.set_cheque_status(p_cheque_id, 'pending', null);
  v_rid := public.reversal_finish(c.company_id, 'cheque_clearance', c.id, v_title, 'error', p_reason, to_jsonb(c), v_e);
  return public.reversal_result('cheque_clearance', p_cheque_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- RECEIVABLE WRITE-OFF — the write-off entry only, never the invoice's revenue
-- ===========================================================================
create or replace function public.reverse_write_off(p_invoice_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare i record; v_entry uuid; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id));
  perform public.reversal_check('write_off', p_invoice_id, p_reason, p_preview,
    (select updated_at from public.invoices where id = p_invoice_id));
  select * into i from public.invoices where id = p_invoice_id for update;
  if i.id is null then raise exception 'That invoice no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Write-off · invoice ' || i.invoice_number;

  select je.id into v_entry from public.journal_entries je
   where je.source_table = 'invoices' and je.source_id = i.id and not je.is_reversal
     and je.description like 'Bad debt write-off:%'
     and not exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = je.id)
   order by je.created_at desc limit 1;

  if i.status <> 'Written-Off' then
    v_b := array_append(v_b, 'This invoice is not written off.'::text);
  end if;
  if v_entry is null then
    v_b := array_append(v_b, 'No write-off journal entry stands against it.'::text);
  end if;
  v_e := array_append(v_e, ('Invoice ' || i.invoice_number || ' is owed again: PKR '
         || to_char(coalesce(i.invoice_amount, 0) - coalesce(i.amount_received, 0), 'FM999,999,999') || ' back on receivables.')::text);
  v_e := array_append(v_e, 'The bad-debt entry is reversed. The sale itself is untouched.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('write_off', p_invoice_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.reverse_journal_entry(v_entry, 'write-off reversed');
  update public.invoices
     set status = case when coalesce(amount_received, 0) <= 0 then 'Unpaid' else 'Partly-Paid' end,
         notes = coalesce(notes, '') || ' [write-off reversed ' || current_date || ': ' || btrim(p_reason) || ']',
         updated_at = now()
   where id = i.id;
  v_rid := public.reversal_finish(i.company_id, 'write_off', i.id, v_title, 'error', p_reason, to_jsonb(i), v_e);
  return public.reversal_result('write_off', p_invoice_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- PARTNER ENTRY (drawing / contribution)
-- ===========================================================================
create or replace function public.reverse_partner_entry(p_entry_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare x record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.partner_account_entries where id = p_entry_id));
  perform public.reversal_check('partner_entry', p_entry_id, p_reason, p_preview);
  select * into x from public.partner_account_entries where id = p_entry_id for update;
  if x.id is null then raise exception 'That partner entry no longer exists.' using errcode = 'P0001'; end if;
  v_title := initcap(lower(x.type)) || ' PKR ' || to_char(x.amount, 'FM999,999,999') || ' · '
          || coalesce((select name from public.partners where id = x.partner_id), 'Partner');
  if coalesce(x.is_locked, false) then
    v_b := array_append(v_b, 'This entry is locked (part of a posted partnership run). Reverse the run instead.'::text);
  end if;
  v_e := array_append(v_e, 'The entry and its journal are reversed; any bank movement it made is put back.'::text);
  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('partner_entry', p_entry_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.delete_partner_entry(p_entry_id);
  v_rid := public.reversal_finish(x.company_id, 'partner_entry', x.id, v_title, 'error', p_reason, to_jsonb(x), v_e);
  return public.reversal_result('partner_entry', p_entry_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- PAYROLL ADJUSTMENT (open, or settled pay-now)
-- ===========================================================================
-- A settled pay-now adjustment does not store where its money went, but its
-- money moved in the same transaction as settled_at was stamped, so the
-- bank_transactions row carries the same now(). That row is the account.
create or replace function public.reverse_payroll_adjustment(p_adjustment_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare a record; t record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_name text;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.payroll_adjustments where id = p_adjustment_id));
  perform public.reversal_check('payroll_adjustment', p_adjustment_id, p_reason, p_preview);
  select * into a from public.payroll_adjustments where id = p_adjustment_id for update;
  if a.id is null then raise exception 'That adjustment no longer exists.' using errcode = 'P0001'; end if;
  select full_name into v_name from public.employees where id = a.employee_id;
  v_title := 'Adjustment PKR ' || to_char(a.amount, 'FM999,999,999') || ' · ' || coalesce(v_name, '')
          || ' · ' || to_char(a.original_period_month, 'Mon YYYY');

  select * into t from public.bank_transactions bt
   where bt.company_id = a.company_id and bt.kind = 'payroll' and bt.created_at = a.settled_at
     and bt.description like 'Payroll adjustment %' limit 1;

  if a.status = 'cancelled' then
    v_b := array_append(v_b, 'This adjustment is already cancelled.'::text);
  elsif a.status = 'settled' and a.settlement = 'carry_forward' then
    v_b := array_append(v_b, 'It was settled on a payslip. Reverse that salary disbursement first; the adjustment reopens with it.'::text);
  elsif a.status = 'settled' and t.id is null then
    v_b := array_append(v_b, 'Its settlement payment cannot be found in the bank history, so it cannot be put back safely.'::text);
  end if;

  if a.status = 'settled' then
    v_e := array_append(v_e, 'Its settlement payment is put back and the settlement entry reversed.'::text);
  end if;
  v_e := array_append(v_e, 'The adjustment is cancelled and its accrual reversed — as if it had never been raised.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('payroll_adjustment', p_adjustment_id, v_title, v_b, v_e, p_preview);
  end if;

  if a.status = 'settled' then
    perform public.reverse_journal_for_source(a.company_id, 'payroll_adjustment_settlement', a.id, current_date);
    perform public.apply_money_delta(
      a.company_id, case when t.bank_account_id is not null then 'Bank' else 'Cash' end, t.bank_account_id,
      -(coalesce(t.account_delta, 0) + coalesce(t.cash_delta, 0)), 'payroll',
      'Reversal · ' || coalesce(t.description, 'payroll adjustment'), t.reference_id);
    perform public.reverse_journal_for_source(a.company_id, 'payroll_adjustments', a.id, current_date);
    update public.payroll_adjustments
       set status = 'cancelled', cancelled_reason = 'Reversed: ' || btrim(p_reason)
     where id = a.id;
  else
    perform public.cancel_payroll_adjustment(a.id, 'Reversed: ' || btrim(p_reason));
  end if;

  v_rid := public.reversal_finish(a.company_id, 'payroll_adjustment', a.id, v_title, 'error', p_reason, to_jsonb(a), v_e);
  return public.reversal_result('payroll_adjustment', p_adjustment_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- MANUAL JOURNAL ENTRY
-- ===========================================================================
create or replace function public.reverse_manual_journal(p_entry_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare j record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_amt numeric;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.journal_entries where id = p_entry_id));
  perform public.reversal_check('manual_journal', p_entry_id, p_reason, p_preview);
  select * into j from public.journal_entries where id = p_entry_id;
  if j.id is null then raise exception 'That journal entry no longer exists.' using errcode = 'P0001'; end if;
  select coalesce(sum(debit), 0) into v_amt from public.journal_lines where journal_entry_id = j.id;
  v_title := 'Manual journal · ' || j.description || ' · PKR ' || to_char(v_amt, 'FM999,999,999');
  if not coalesce(j.manual, false) then
    v_b := array_append(v_b, 'This is not a manual entry. Reverse the action that posted it.'::text);
  end if;
  if j.is_reversal or exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = j.id) then
    v_b := array_append(v_b, 'This entry is a reversal or has already been reversed.'::text);
  end if;
  v_e := array_append(v_e, 'An equal and opposite entry is posted (in its month if open, otherwise today).'::text);
  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('manual_journal', p_entry_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.require_perm('accounting.edit');
  perform public.reverse_journal_entry(j.id, btrim(p_reason));
  v_rid := public.reversal_finish(j.company_id, 'manual_journal', j.id, v_title, 'error', p_reason, to_jsonb(j), v_e);
  return public.reversal_result('manual_journal', p_entry_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- INVOICE (issued in error, nothing received against it)
-- ===========================================================================
create or replace function public.reverse_invoice(p_invoice_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare i record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_before jsonb;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id));
  perform public.reversal_check('invoice', p_invoice_id, p_reason, p_preview);
  select * into i from public.invoices where id = p_invoice_id for update;
  if i.id is null then raise exception 'That invoice no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Invoice ' || i.invoice_number || ' · PKR ' || to_char(coalesce(i.total_due, i.invoice_amount), 'FM999,999,999') || ' · '
          || coalesce((select name from public.clients where id = i.client_id), 'Client');

  if coalesce(i.amount_received, 0) > 0 or exists (select 1 from public.invoice_payments ip where ip.invoice_id = i.id) then
    v_b := array_append(v_b, 'Payments are recorded against it. Reverse those payments first.'::text);
  end if;
  if i.status = 'Written-Off' then
    v_b := array_append(v_b, 'It is written off. Reverse the write-off first.'::text);
  end if;
  if exists (select 1 from public.invoices s where s.supplements_invoice_id = i.id) then
    v_b := array_append(v_b, 'A supplementary invoice adjusts it. Reverse that one first.'::text);
  end if;
  if public.is_period_closed(i.company_id, coalesce(i.period_start, i.invoice_date)) then
    v_b := array_append(v_b, ('Its month (' || to_char(coalesce(i.period_start, i.invoice_date), 'Mon YYYY') || ') is closed. Reopen it in Period Close, then reverse.')::text);
  end if;
  v_e := array_append(v_e, 'The invoice is withdrawn: its revenue, tax and receivable entries are reversed.'::text);
  v_e := array_append(v_e, 'The contract can be invoiced again for this period. The document (lines, taxes) is kept in the reversal.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('invoice', p_invoice_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.require_perm('invoices.edit');
  v_before := jsonb_build_object(
    'invoice', to_jsonb(i),
    'lines', coalesce((select jsonb_agg(to_jsonb(l)) from public.invoice_lines l where l.invoice_id = i.id), '[]'::jsonb),
    'taxes', coalesce((select jsonb_agg(to_jsonb(t)) from public.invoice_taxes t where t.invoice_id = i.id), '[]'::jsonb));
  delete from public.invoices where id = i.id;
  v_rid := public.reversal_finish(i.company_id, 'invoice', i.id, v_title, 'error', p_reason, v_before, v_e);
  return public.reversal_result('invoice', p_invoice_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

do $$
declare f text;
begin
  foreach f in array array[
    'reverse_expense(uuid,text,boolean)', 'reverse_payable_settlement(uuid,text,boolean)',
    'reverse_advance(uuid,text,boolean)', 'reverse_vendor_payment(uuid,text,boolean)',
    'reverse_bank_transfer(uuid,text,boolean)', 'reverse_bank_to_custodian(uuid,text,boolean)',
    'reverse_custody_transfer(uuid,text,boolean)', 'reverse_cash_deposit(uuid,text,boolean)',
    'reverse_cheque_clearance(uuid,text,boolean)', 'reverse_write_off(uuid,text,boolean)',
    'reverse_partner_entry(uuid,text,boolean)', 'reverse_payroll_adjustment(uuid,text,boolean)',
    'reverse_manual_journal(uuid,text,boolean)', 'reverse_invoice(uuid,text,boolean)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0504 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
