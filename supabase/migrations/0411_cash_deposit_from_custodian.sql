-- 0411 — a cash deposit is made BY a custodian, from the cash they hold.
--
-- record_cash_deposit moved treasury.cash_balance → bank and stamped
-- deposited_by = auth.uid() (the user who recorded it). It never touched a
-- custodian: cash_deposits.cash_location_id existed but was never set, and neither
-- held-cash computation (custodian.ts / CashCustody.heldCash) reads deposits — so a
-- deposit reduced the aggregate Cash in Hand but no individual's held cash, and the
-- two drifted apart on every deposit.
--
-- Now the caller passes the depositing custodian's cash_location. The money moves
-- exactly as before (treasury −, bank +); the only addition is storing the
-- attribution so held-cash reads can subtract it. deposited_by stays the recorder
-- (audit); the screens show the custodian from cash_location_id.
--
-- A parameter is added, so the old 4-arg signature is dropped rather than left as a
-- second overload PostgREST could not choose between. Body reproduced from the live
-- definition (fetched 2026-09-09) with only the custodian additions.

drop function if exists public.record_cash_deposit(uuid, numeric, date, text);

create or replace function public.record_cash_deposit(
  p_bank_account_id uuid,
  p_amount numeric,
  p_date date,
  p_notes text,
  p_cash_location_id uuid
) returns cash_deposits
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_company_id uuid;
  v_bank_name text;
  v_cash numeric;
  v_treasury_id uuid;
  v_slip integer;
  v_deposit public.cash_deposits;
begin
  perform public.require_perm('accounting.edit');
  -- tenant guard [resolved]: owning company looked up from p_bank_account_id via public.bank_accounts (0242)
  if p_bank_account_id is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  -- The depositing custodian's cash_location must belong to the same company.
  if p_cash_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_cash_location_id)); end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount_must_be_positive';
  end if;
  if p_cash_location_id is null then
    raise exception 'custodian_required';
  end if;

  select company_id, bank_name into v_company_id, v_bank_name
  from public.bank_accounts where id = p_bank_account_id;
  if v_company_id is null then
    raise exception 'bank_not_found';
  end if;

  select id, cash_balance into v_treasury_id, v_cash
  from public.treasury where company_id = v_company_id for update;
  if v_treasury_id is null then
    raise exception 'no_treasury';
  end if;
  if v_cash < p_amount then
    raise exception 'insufficient_cash';
  end if;

  select coalesce(max(slip_number), 0) + 1 into v_slip
  from public.cash_deposits where company_id = v_company_id;

  update public.treasury
    set cash_balance = cash_balance - p_amount, updated_at = now()
    where id = v_treasury_id;
  update public.bank_accounts
    set balance = balance + p_amount, updated_at = now()
    where id = p_bank_account_id;

  insert into public.cash_deposits (company_id, bank_account_id, amount, deposit_date, slip_number, notes, deposited_by, cash_location_id)
  values (v_company_id, p_bank_account_id, p_amount, coalesce(p_date, current_date), v_slip, nullif(btrim(p_notes), ''), auth.uid(), p_cash_location_id)
  returning * into v_deposit;

  insert into public.bank_transactions
    (company_id, bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id, created_at)
  values
    (v_company_id, p_bank_account_id, 'deposit', p_amount, -p_amount, p_amount,
     'Cash deposit — slip #' || v_slip::text || ' to ' || coalesce(v_bank_name, 'bank'),
     v_deposit.id::text, (coalesce(p_date, current_date)::timestamp + time '12:00'));

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changed_at, changes)
  values (v_company_id, 'cash_deposits', v_deposit.id, 'insert', auth.uid(), now(),
          jsonb_build_object(
            'slip_number', jsonb_build_object('after', v_slip),
            'amount', jsonb_build_object('after', p_amount),
            'bank_account_id', jsonb_build_object('after', p_bank_account_id::text),
            'cash_location_id', jsonb_build_object('after', p_cash_location_id::text)
          ));

  return v_deposit;
end;
$function$;

grant execute on function public.record_cash_deposit(uuid, numeric, date, text, uuid) to authenticated, service_role;

-- p_cash_location_id and p_bank_account_id are both guarded by assert_same_company;
-- assert the detector reads clean, as every migration must.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
