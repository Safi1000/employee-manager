-- 0143: Fix record_bank_to_custodian so Total Cash is not double-counted.
--
-- 0142 credited the custodian via a custody_transfer, but a custodian's transfer
-- balance also feeds Total Cash — while the same cash is already inside Cash in
-- Hand (treasury). Office→office transfers net to zero so they were harmless, but
-- a bank→office transfer credits only the TO side and would inflate Total Cash.
--
-- Fix: attribute the withdrawal to the custodian through the bank_transactions
-- ledger row (reference_id = custodian cash_location) instead of a custody_transfer.
-- The frontend adds these withdraw_to_cash rows to the custodian's HELD cash
-- (which is a breakdown of Cash in Hand, not an addition to Total Cash). Net effect:
-- bank −amount, Cash in Hand +amount, custodian held +amount, Total Cash unchanged.

create or replace function public.record_bank_to_custodian(
  p_bank_account_id       uuid,
  p_custodian_location_id uuid,
  p_amount                numeric,
  p_date                  date,
  p_notes                 text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid;
  v_bal     numeric;
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

  -- Ledger row is the single record of this move; reference_id ties the cash to
  -- the receiving custodian (used by the held-cash breakdown + custody log).
  insert into public.bank_transactions
    (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
  values
    (p_bank_account_id, 'withdraw_to_cash', p_amount, p_amount, -p_amount,
     coalesce(nullif(btrim(p_notes), ''), 'Cash withdrawn to custodian'),
     p_custodian_location_id);
end $$;

grant execute on function public.record_bank_to_custodian(uuid, uuid, numeric, date, text) to authenticated;
