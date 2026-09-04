-- 0382 — record, amend and delete an advance in one transaction each.
--
-- ===========================================================================
-- THE OTHER THREE OF THE EIGHT, AND THE ONE-KEY TWIST
-- ===========================================================================
--
-- handleAddAdvance, handleEditAdvance and reverseAdvancePayment are the same
-- shape as the expense flows: the advance row in one round trip, the cash or
-- bank movement in another, no transaction between them.
--
-- They differ in one way that §2 of docs/PERMISSION_GAPS.md recorded and 0372
-- half-closed: an advance needed NO permission at all to create. 0372 put the
-- three advances policies behind expenses.edit as an explicitly PROVISIONAL
-- key — wrong key beats no key — so these flows are now genuinely cross-key
-- (expenses.edit for the row, accounting.edit for a bank balance) where before
-- only one key was in play. That makes the transaction boundary matter MORE
-- than it did when the list was written, not less.
--
-- ===========================================================================
-- WHY THE ADVANCE HELPERS ARE SEPARATE FROM THE EXPENSE ONES
-- ===========================================================================
--
-- An advance is not an expense with a different table name. It has no payable
-- state, so there is no paid_via to read back — the reversal is always out of
-- the account named on the row. And its audit lines carry kind = 'advance',
-- which is what the cashflow screens filter on.
--
-- What they share is apply_money_delta(), which is the part that was worth
-- sharing: the row-count assert, the arithmetic under the lock, and the two
-- zero-row diagnoses. The shapes above it stay honest about the difference.

create or replace function public.describe_advance(p_employee_id uuid, p_client_id uuid)
returns text
language sql
stable
set search_path to 'public'
as $function$
  select 'Advance · '
      || coalesce((select e.employee_code || ' ' || e.full_name
                     from public.employees e where e.id = p_employee_id), 'employee')
      || coalesce(' (' || (select c.name from public.clients c where c.id = p_client_id) || ')', '');
$function$;

grant execute on function public.describe_advance(uuid, uuid) to authenticated;

create or replace function public.advance_reverse_money(p_advance_id uuid, p_label text)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare a record;
begin
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

grant execute on function public.advance_reverse_money(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- record_advance — the row and the cash, together.
-- ---------------------------------------------------------------------------
create or replace function public.record_advance(
  p_employee_id uuid,
  p_amount numeric,
  p_advance_date date,
  p_payment_mode text,
  p_client_id uuid default null,
  p_bank_account_id uuid default null,
  p_cheque_id uuid default null,
  p_custodian_location_id uuid default null,
  p_notes text default null
) returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare v_id uuid; v_company uuid;
begin
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

grant execute on function public.record_advance(uuid, numeric, date, text, uuid, uuid, uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- amend_advance — old cash back, row changed, new cash out.
-- ---------------------------------------------------------------------------
create or replace function public.amend_advance(
  p_advance_id uuid,
  p_employee_id uuid,
  p_amount numeric,
  p_advance_date date,
  p_payment_mode text,
  p_client_id uuid default null,
  p_bank_account_id uuid default null,
  p_cheque_id uuid default null,
  p_custodian_location_id uuid default null,
  p_notes text default null
) returns void
language plpgsql
set search_path to 'public'
as $function$
declare v_n int; v_company uuid;
begin
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

grant execute on function public.amend_advance(uuid, uuid, numeric, date, text, uuid, uuid, uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_advance — the cash back and the row gone, together.
-- ---------------------------------------------------------------------------
create or replace function public.delete_advance(p_advance_id uuid)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare v_n int;
begin
  perform public.advance_reverse_money(p_advance_id, 'Reverse advance (deleted)');

  delete from public.advances where id = p_advance_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception
      'Deleting an advance needs the expenses.edit permission. Nothing has been recorded.'
      using errcode = '42501';
  end if;
end;
$function$;

grant execute on function public.delete_advance(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- PROVE IT — the same round trip, and one thing the expense probe could not
-- test: an amend that CHANGES THE MODE.
--
-- Cash -> Bank is where a reversal reading the caller's new parameters instead
-- of the stored row goes wrong: it would return the money to the bank account
-- the advance is moving TO, leaving cash short and the bank twice credited.
-- Both balances are measured, because a test that watched only one of them
-- would call that correct.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_uid   uuid;
  v_emp   uuid;
  v_bank  uuid;
  v_loc   uuid;
  v_cash0 numeric; v_cash1 numeric;
  v_bank0 numeric; v_bank1 numeric;
  v_id    uuid;
begin
  select id into v_co from public.companies order by created_at limit 1;
  select id into v_uid from public.profiles where company_id = v_co limit 1;
  select id into v_emp from public.employees where company_id = v_co limit 1;
  select id into v_bank from public.bank_accounts where company_id = v_co limit 1;
  select custodian_location_id into v_loc from public.advances
   where company_id = v_co and custodian_location_id is not null limit 1;
  if v_loc is null then
    select custodian_location_id into v_loc from public.expenses
     where company_id = v_co and custodian_location_id is not null limit 1;
  end if;
  if v_co is null or v_uid is null or v_emp is null or v_bank is null then
    raise exception '0382 FAILED: no company / profile / employee / bank account to probe against.';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);

  select cash_balance into v_cash0 from public.treasury where company_id = v_co;
  select balance into v_bank0 from public.bank_accounts where id = v_bank;
  if v_cash0 is null then raise exception '0382 FAILED: no treasury row to measure against.'; end if;

  -- Cash advance.
  v_id := public.record_advance(v_emp, 333.33, current_date, 'Cash', null, null, null, v_loc);
  select cash_balance into v_cash1 from public.treasury where company_id = v_co;
  if v_cash1 <> v_cash0 - 333.33 then
    raise exception '0382 FAILED: after a cash advance, cash is % and should be %.', v_cash1, v_cash0 - 333.33;
  end if;

  -- Amended to BANK. The cash must come all the way back and the bank must
  -- fall by the new amount — exactly once.
  perform public.amend_advance(v_id, v_emp, 444.44, current_date, 'Bank', null, v_bank);
  select cash_balance into v_cash1 from public.treasury where company_id = v_co;
  select balance into v_bank1 from public.bank_accounts where id = v_bank;
  if v_cash1 <> v_cash0 then
    raise exception
      '0382 FAILED: after Cash -> Bank, cash is % and should be back at %. The reversal did not read the OLD mode off the row.',
      v_cash1, v_cash0;
  end if;
  if v_bank1 <> v_bank0 - 444.44 then
    raise exception '0382 FAILED: after Cash -> Bank, the bank is % and should be %.', v_bank1, v_bank0 - 444.44;
  end if;

  perform public.delete_advance(v_id);
  select cash_balance into v_cash1 from public.treasury where company_id = v_co;
  select balance into v_bank1 from public.bank_accounts where id = v_bank;
  if v_cash1 <> v_cash0 or v_bank1 <> v_bank0 then
    raise exception '0382 FAILED: after delete, cash is %/% and bank is %/%.', v_cash1, v_cash0, v_bank1, v_bank0;
  end if;

  raise exception
    'ROLLBACK_PROBE 0382 OK: cash and bank both return exactly to % / %, including across a Cash -> Bank amend.',
    v_cash0, v_bank0;
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
    raise exception '0382 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
