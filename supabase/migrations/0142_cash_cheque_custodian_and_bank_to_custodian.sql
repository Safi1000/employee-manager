-- 0142: Attribute cash to custodians for cash cheques + bank→custodian transfers.
--
-- Two gaps closed so that Σ(custodian held cash) always equals Cash in Hand
-- (treasury.cash_balance):
--   1. A cash cheque can now name the office-staff custodian who receives the
--      cash (cheques.custodian_location_id). The existing cheque_apply_balance()
--      trigger still moves the money into Cash in Hand; the frontend adds the
--      cleared cash-cheque amount to that custodian's held cash.
--   2. record_bank_to_custodian() moves cash from a bank straight to an
--      office-staff custodian in one atomic step: bank −amount, Cash in Hand
--      +amount, a custody_transfer (bank→custodian) that credits the custodian's
--      held cash, and a withdraw_to_cash ledger row for the transaction log.

-- 1. Cash-cheque → custodian link -------------------------------------------
alter table public.cheques
  add column if not exists custodian_location_id uuid references public.cash_locations(id);

-- 2. Bank → custodian (office staff) cash withdrawal, attributed --------------
create or replace function public.record_bank_to_custodian(
  p_bank_account_id       uuid,
  p_custodian_location_id uuid,
  p_amount                numeric,
  p_date                  date,
  p_notes                 text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_company  uuid;
  v_bal      numeric;
  v_bank_loc uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount_must_be_positive';
  end if;

  select balance, company_id into v_bal, v_company
    from public.bank_accounts where id = p_bank_account_id;
  if v_company is null then raise exception 'bank_not_found'; end if;
  if p_amount > v_bal then raise exception 'insufficient_bank_balance'; end if;

  -- Money out of the bank, into Cash in Hand.
  update public.bank_accounts
     set balance = balance - p_amount, updated_at = now()
   where id = p_bank_account_id;

  update public.treasury
     set cash_balance = cash_balance + p_amount, updated_at = now()
   where company_id = v_company;
  if not found then
    insert into public.treasury (company_id, cash_balance) values (v_company, p_amount);
  end if;

  -- Credit the custodian's held cash via a dated transfer from the bank's
  -- mirror location (from side is the BANK cash_location if one exists).
  select id into v_bank_loc
    from public.cash_locations
   where bank_account_id = p_bank_account_id and location_type = 'BANK'
   limit 1;

  insert into public.custody_transfers
    (company_id, date, from_location_id, to_location_id, amount, notes, created_by)
  values
    (v_company, p_date, v_bank_loc, p_custodian_location_id, p_amount, p_notes, auth.uid());

  -- Ledger entry for the transaction logs (bank + cash custody).
  insert into public.bank_transactions
    (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
  values
    (p_bank_account_id, 'withdraw_to_cash', p_amount, p_amount, -p_amount,
     coalesce(nullif(btrim(p_notes), ''), 'Cash withdrawn to custodian'),
     p_custodian_location_id);
end $$;

grant execute on function public.record_bank_to_custodian(uuid, uuid, numeric, date, text) to authenticated;
