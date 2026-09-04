-- 0381 — amend, delete, settle and unsettle an expense in one transaction each.
--
-- ===========================================================================
-- FOUR OF THE EIGHT CROSS-KEY FLOWS
-- ===========================================================================
--
-- handleEdit, handleDelete (Expenses.tsx), handleMarkPaid and
-- handleRevertToPending (Accounting.tsx) each did the same thing: several
-- round trips, money in one and the row in another, no transaction. A refusal
-- on the second half leaves the first half committed.
--
-- handleMarkPaid had the worst ordering of the four — it moved the money
-- FIRST and updated the expense last. A user with accounting.edit and without
-- expenses.edit paid the vendor and left the payable sitting at Pending, and
-- the screen said what went wrong only after the cash was gone.
--
-- ===========================================================================
-- expense_reverse_money() — WHERE A REVERSAL IS DEFINED, ONCE
-- ===========================================================================
--
-- "Undo the money this expense represents" is not one rule, it is four, and
-- the frontend spelled all four out three separate times (reverseExistingPayment,
-- handleRevertToPending, and again in the delete path):
--
--   Cash                       -> return the cash
--   Bank                       -> return it to bank_account_id
--   Payable, still Pending     -> nothing moved, nothing to return
--   Payable, already Paid      -> return it via paid_via / paid_bank_account_id
--   Cheque                     -> nothing; a cheque moves money when it clears
--
-- The fourth line is the one that gets forgotten, because a settled payable
-- pays out of a DIFFERENT account from the one on the expense. Written once
-- here, read off the row rather than from a caller's parameters, so no caller
-- can pass the wrong account for its own reversal.

create or replace function public.expense_reverse_money(p_expense_id uuid, p_label text)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare e record;
begin
  select id, company_id, amount, payment_mode, bank_account_id,
         payable_status, paid_via, paid_bank_account_id,
         category_id, client_id, description
    into e
    from public.expenses where id = p_expense_id;

  if e.id is null then
    -- Invisible under RLS and absent are the same thing to a reader, and both
    -- mean this caller must not be moving money on its behalf.
    raise exception
      'That expense does not exist, or you cannot see it. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;

  if e.payment_mode = 'Payable' then
    -- A Pending payable never moved money, so there is nothing to give back.
    -- A Paid one moved it out of the account named by paid_via, which is not
    -- necessarily bank_account_id — that is the whole reason this is read off
    -- the row.
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

comment on function public.expense_reverse_money(uuid, text) is
  '0381: gives back the money an expense currently represents, reading the mode and the account OFF THE ROW. A settled payable pays out of paid_via/paid_bank_account_id and not bank_account_id, which is the case a caller passing its own parameters gets wrong. Call it inside the transaction that changes or removes the expense.';

grant execute on function public.expense_reverse_money(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- amend_expense — the old money back, the row changed, the new money out.
--
-- The UPDATE asserts its own row count for the same reason every balance write
-- does: under RLS an expense the caller may not edit updates zero rows and
-- raises nothing, and the reversal above it would have already committed. The
-- assert is what makes that a refusal instead of a gift.
-- ---------------------------------------------------------------------------
create or replace function public.amend_expense(
  p_expense_id uuid,
  p_category_id uuid, p_amount numeric, p_expense_date date, p_payment_mode text,
  p_client_id uuid default null, p_branch_id uuid default null,
  p_vendor_id uuid default null, p_description text default null,
  p_custodian_location_id uuid default null, p_bank_account_id uuid default null,
  p_cheque_id uuid default null, p_due_date date default null,
  p_notes text default null, p_expense_by uuid default null,
  p_coverage_start date default null, p_coverage_end date default null,
  p_service_start date default null, p_service_end date default null,
  p_receipt_path text default null, p_drive_file_id text default null,
  p_drive_view_url text default null, p_receipt_file_name text default null
) returns void
language plpgsql
set search_path to 'public'
as $function$
declare
  v_n       int;
  v_company uuid;
  v_prev    record;
begin
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

  -- 1. The money that is already out comes back.
  perform public.expense_reverse_money(p_expense_id, 'Reverse expense (edit)');

  -- 2. The row.
  update public.expenses set
    category_id = p_category_id,
    -- Locked, exactly as record_expense derives it: a client makes it a cost of
    -- services and nothing else does. Not a caller's choice on either path.
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
    -- Staying a payable keeps whatever status it had; becoming one starts at
    -- Pending; ceasing to be one has no status at all.
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

  -- 3. The new money goes out. A payable that is still Pending moves nothing,
  --    which is why this asks the mode and not just the amount.
  if p_payment_mode <> 'Payable' then
    perform public.apply_money_delta(
      v_company, p_payment_mode, p_bank_account_id, -p_amount,
      'expense', public.describe_expense(p_category_id, p_client_id, p_description),
      p_expense_id::text);
  end if;
end;
$function$;

grant execute on function public.amend_expense(
  uuid, uuid, numeric, date, text, uuid, uuid, uuid, text, uuid, uuid, uuid, date,
  text, uuid, date, date, date, date, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_expense — the money back and the row gone, together.
-- ---------------------------------------------------------------------------
create or replace function public.delete_expense(p_expense_id uuid)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare v_n int;
begin
  perform public.expense_reverse_money(p_expense_id, 'Reverse expense (deleted)');

  delete from public.expenses where id = p_expense_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception
      'Deleting an expense needs the expenses.edit permission. Nothing has been recorded.'
      using errcode = '42501';
  end if;
end;
$function$;

grant execute on function public.delete_expense(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- settle_payable_expense — the vendor is paid and the payable says so, or
-- neither happens. This is the flow whose old ordering paid first.
-- ---------------------------------------------------------------------------
create or replace function public.settle_payable_expense(
  p_expense_id uuid,
  p_paid_via text,
  p_paid_bank_account_id uuid default null,
  p_custodian_location_id uuid default null
) returns void
language plpgsql
set search_path to 'public'
as $function$
declare v_n int; e record;
begin
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
  -- Read and compared here rather than trusted from the screen: the row may
  -- have been settled by someone else since the list was loaded, and paying a
  -- vendor twice is not recoverable by an undo.
  if e.payable_status = 'Paid' then
    raise exception 'That payable is already settled. Nothing has been recorded.' using errcode = '23514';
  end if;

  -- The ROW FIRST, then the money — the opposite of what handleMarkPaid did.
  -- Both orders are safe inside one transaction, but this one fails without
  -- having touched a balance at all when the caller lacks expenses.edit, which
  -- is the commoner refusal.
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
      'Settling a payable needs the expenses.edit permission. Nothing has been recorded.'
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

grant execute on function public.settle_payable_expense(uuid, text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- revert_payable_expense — the refund and the status, together.
-- ---------------------------------------------------------------------------
create or replace function public.revert_payable_expense(p_expense_id uuid)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare v_n int; e record;
begin
  select id, payment_mode, payable_status into e from public.expenses where id = p_expense_id;
  if e.id is null then
    raise exception 'That payable does not exist, or you cannot see it. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if e.payment_mode <> 'Payable' or e.payable_status <> 'Paid' then
    raise exception 'Only a settled payable can be reverted to pending.' using errcode = '23514';
  end if;

  -- Reversed BEFORE the status is cleared, because expense_reverse_money reads
  -- paid_via off the row and the update below is what erases it. Clearing
  -- first would refund nothing and report success.
  perform public.expense_reverse_money(p_expense_id, 'Payable reverted to pending');

  update public.expenses set
    payable_status = 'Pending',
    paid_via = null,
    paid_bank_account_id = null,
    custodian_location_id = null,
    paid_at = null,
    updated_at = now()
  where id = p_expense_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception
      'Reverting a payable needs the expenses.edit permission. Nothing has been recorded.'
      using errcode = '42501';
  end if;
end;
$function$;

grant execute on function public.revert_payable_expense(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- PROVE IT, against real rows, rolled back.
--
-- The assertion that matters is the ROUND TRIP: an expense recorded, amended
-- to a different amount, and deleted must leave the cash balance exactly where
-- it started. Any one of the three getting its sign or its account wrong shows
-- up as a residue, and nothing else would show it — each step on its own
-- "succeeds".
--
-- The settle/revert pair is exercised the same way, and additionally proves
-- the case this migration exists for: a settled payable refunds out of
-- paid_via, which is a DIFFERENT account from the one on the expense.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_uid   uuid;
  v_cat   uuid;
  v_loc   uuid;
  v_start numeric;
  v_now   numeric;
  v_id    uuid;
begin
  select id into v_co from public.companies order by created_at limit 1;
  select id into v_uid from public.profiles where company_id = v_co limit 1;
  select id into v_cat from public.expense_categories where company_id = v_co limit 1;
  -- expenses_cash_names_a_location: a cash expense must name the custodian who
  -- handed the cash over. An existing one is reused rather than invented,
  -- because creating a location would be a write this probe cannot roll back
  -- cleanly if anything downstream references it.
  select custodian_location_id into v_loc from public.expenses
   where company_id = v_co and custodian_location_id is not null limit 1;
  if v_co is null or v_uid is null or v_cat is null or v_loc is null then
    raise exception '0381 FAILED: no company / profile / expense category / custodian location to probe against.';
  end if;
  -- Borrow a real member's claim, or fill_company_id and current_company_id()
  -- have nothing to read and the probe tests nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);

  select cash_balance into v_start from public.treasury where company_id = v_co;
  if v_start is null then
    raise exception '0381 FAILED: no treasury row; the round trip cannot be measured.';
  end if;

  -- Record -> amend -> delete, all Cash.
  v_id := public.record_expense(v_cat, 777.11, current_date, 'Cash', null, null, null, 'PROBE 0381', v_loc);
  select cash_balance into v_now from public.treasury where company_id = v_co;
  if v_now <> v_start - 777.11 then
    raise exception '0381 FAILED: after record, cash is % and should be %.', v_now, v_start - 777.11;
  end if;

  perform public.amend_expense(v_id, v_cat, 200.00, current_date, 'Cash', null, null, null, 'PROBE 0381 amended', v_loc);
  select cash_balance into v_now from public.treasury where company_id = v_co;
  if v_now <> v_start - 200.00 then
    raise exception
      '0381 FAILED: after amending 777.11 -> 200.00, cash is % and should be %. The reversal and the new charge do not cancel.',
      v_now, v_start - 200.00;
  end if;

  perform public.delete_expense(v_id);
  select cash_balance into v_now from public.treasury where company_id = v_co;
  if v_now <> v_start then
    raise exception '0381 FAILED: after delete, cash is % and should be back at %.', v_now, v_start;
  end if;

  -- A payable: recorded (moves nothing), settled in cash, reverted.
  v_id := public.record_expense(v_cat, 500.00, current_date, 'Payable', null, null, null,
                                'PROBE 0381 payable', null, null, null, current_date + 30);
  select cash_balance into v_now from public.treasury where company_id = v_co;
  if v_now <> v_start then
    raise exception '0381 FAILED: recording a PAYABLE moved cash to %. A payable moves money when it is settled, not before.', v_now;
  end if;

  perform public.settle_payable_expense(v_id, 'Cash', null, v_loc);
  select cash_balance into v_now from public.treasury where company_id = v_co;
  if v_now <> v_start - 500.00 then
    raise exception '0381 FAILED: after settling, cash is % and should be %.', v_now, v_start - 500.00;
  end if;

  perform public.revert_payable_expense(v_id);
  select cash_balance into v_now from public.treasury where company_id = v_co;
  if v_now <> v_start then
    raise exception
      '0381 FAILED: after reverting, cash is % and should be back at %. The refund did not read paid_via off the row.',
      v_now, v_start;
  end if;

  -- Settling twice must be refused. Without the status check, the second call
  -- pays the vendor again and the row cannot tell the difference.
  perform public.settle_payable_expense(v_id, 'Cash', null, v_loc);
  begin
    perform public.settle_payable_expense(v_id, 'Cash', null, v_loc);
    raise exception '0381 FAILED: a payable was settled twice.';
  exception when others then
    if sqlerrm not like '%already settled%' then
      raise exception '0381 FAILED: the second settle raised "%", which is not the refusal being tested.', sqlerrm;
    end if;
  end;

  raise exception 'ROLLBACK_PROBE 0381 OK: record/amend/delete and settle/revert both return cash exactly to %, and a double settle is refused by message.', v_start;
exception when others then
  if sqlerrm not like 'ROLLBACK_PROBE%' then raise; end if;
  raise notice '%', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0381 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
