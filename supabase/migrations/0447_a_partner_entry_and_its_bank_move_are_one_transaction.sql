-- 0447 — a partner entry and its bank move are one transaction.
--
-- PartnerDetailModal recorded a drawing or contribution by inserting the
-- partner_account_entries row, then READING bank_accounts.balance and WRITING
-- back balance + delta from the browser: two round trips, no lock, no
-- bank_transactions line, and if the second failed the entry stood with the
-- money unmoved. It was the last live balance write on a screen, on the screen
-- that pays partners.
--
-- Deleting an entry had the other half of the same hole: the row's journal
-- trigger reversed the GL, and nothing restored the bank balance at all.
--
-- Both now go through one function each, in one transaction, and the money
-- moves through apply_money_delta() — the only definition of how a balance
-- moves and how it is logged.
--
-- SECURITY INVOKER, deliberately. Each call writes ONE row named by the
-- caller, so under RLS a hidden row is a refusal, not a smaller result
-- (CLAUDE.md, "a set operation is not safe to convert"). The caller's own
-- policies apply: the entry needs company membership, and the bank move needs
-- accounting.edit — exactly what the browser path needed, now atomic.
--
-- WHAT MOVES MONEY, unchanged from the screen: BANK_TRANSFER and CHEQUE move
-- the chosen bank account (drawing out, contribution in). CASH moves no
-- balance here — cash custody is derived from the entry's cash_location_id.
-- FUEL_CARD moves nothing.

alter table public.bank_transactions drop constraint if exists bank_transactions_kind_check;
alter table public.bank_transactions add constraint bank_transactions_kind_check check (kind = any (array[
  'opening', 'deposit', 'withdraw_to_cash', 'payroll', 'reconcile', 'adjustment', 'cash_adjustment',
  'expense', 'receipt', 'advance', 'transfer', 'cheque',
  'partner_entry'   -- 0447
]));

create or replace function public.record_partner_entry(
  p_partner_id       uuid,
  p_date             date,
  p_type             text,
  p_description      text,
  p_amount           numeric,
  p_method           text,
  p_bank_account_id  uuid,
  p_cash_location_id uuid)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $fn$
declare v_co uuid; v_name text; v_id uuid;
begin
  if p_type not in ('DRAWING', 'CONTRIBUTION') then
    raise exception 'A partner payment is a drawing or a contribution.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount above zero.';
  end if;
  if p_method in ('BANK_TRANSFER', 'CHEQUE') and p_bank_account_id is null then
    raise exception 'Choose the bank account.';
  end if;
  if p_method = 'CASH' and p_cash_location_id is null then
    raise exception 'Choose who paid (cash custodian).';
  end if;

  select company_id, name into v_co, v_name from public.partners where id = p_partner_id;
  if v_co is null then raise exception 'Partner not found.'; end if;

  insert into public.partner_account_entries
    (company_id, partner_id, date, type, description, amount, payment_method,
     bank_account_id, cash_location_id, created_by)
  values
    (v_co, p_partner_id, p_date, p_type, nullif(trim(coalesce(p_description, '')), ''), p_amount, p_method,
     case when p_method in ('BANK_TRANSFER', 'CHEQUE') then p_bank_account_id end,
     case when p_method = 'CASH' then p_cash_location_id end,
     auth.uid())
  returning id into v_id;

  if p_method in ('BANK_TRANSFER', 'CHEQUE') then
    perform public.apply_money_delta(
      v_co, 'Bank', p_bank_account_id,
      case when p_type = 'DRAWING' then -p_amount else p_amount end,
      'partner_entry',
      v_name || ' — ' || lower(p_type) || coalesce(' — ' || nullif(trim(coalesce(p_description, '')), ''), ''),
      v_id::text);
  end if;

  return v_id;
end;
$fn$;

create or replace function public.delete_partner_entry(p_entry_id uuid)
returns void
language plpgsql
security invoker
set search_path to 'public'
as $fn$
declare e record; v_name text; v_n int;
begin
  select * into e from public.partner_account_entries where id = p_entry_id;
  if not found then raise exception 'Entry not found.'; end if;
  if coalesce(e.is_locked, false) then raise exception 'This entry is locked and cannot be deleted.'; end if;

  -- The money first, the exact inverse of what recording it moved.
  if e.payment_method in ('BANK_TRANSFER', 'CHEQUE') and e.bank_account_id is not null
     and e.type in ('DRAWING', 'CONTRIBUTION') then
    select name into v_name from public.partners where id = e.partner_id;
    perform public.apply_money_delta(
      e.company_id, 'Bank', e.bank_account_id,
      case when e.type = 'DRAWING' then e.amount else -e.amount end,
      'partner_entry',
      'Deleted: ' || coalesce(v_name, 'partner') || ' — ' || lower(e.type),
      e.id::text);
  end if;

  delete from public.partner_account_entries where id = p_entry_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'The entry could not be deleted. Nothing has been changed.' using errcode = '42501';
  end if;
end;
$fn$;

revoke execute on function public.record_partner_entry(uuid, date, text, text, numeric, text, uuid, uuid) from anon, public;
grant  execute on function public.record_partner_entry(uuid, date, text, text, numeric, text, uuid, uuid) to authenticated;
revoke execute on function public.delete_partner_entry(uuid) from anon, public;
grant  execute on function public.delete_partner_entry(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- THE PROBE, rolled back. A bank drawing of 500 against a real company bank
-- account: the balance moves by exactly −500, one partner_entry line is logged,
-- the capital account is debited 500. Deleting it: the balance is back to the
-- rupee, the GL nets to zero, and the entry is gone.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid; v_uid uuid; v_p uuid; v_acct uuid; v_bank uuid; v_before numeric; v_after numeric;
  v_id uuid; v_n int; v_net numeric;
begin
  select id into v_co from public.companies where active and archived_at is null order by created_at limit 1;
  select p.id into v_uid from public.profiles p where p.company_id = v_co
   and p.role in ('super_admin','super_super_admin') order by p.role limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  select id into v_bank from public.bank_accounts where company_id = v_co and owner_partner_id is null limit 1;
  if v_bank is null then raise exception '0447 PROBE FAILED: no company bank account to probe with.'; end if;
  insert into public.partners (company_id, name, scope, profit_share_percent, opening_balance, start_month, allocation_method, is_active)
  values (v_co, '0447 Probe Partner', 'COMPANY', 0, 0, '2026-09-01', 'FIXED_PCT', true)
  returning id into v_p;
  select coa_account_id into v_acct from public.partners where id = v_p;

  select balance into v_before from public.bank_accounts where id = v_bank;
  v_id := public.record_partner_entry(v_p, current_date, 'DRAWING', '0447 probe', 500, 'BANK_TRANSFER', v_bank, null);

  select balance into v_after from public.bank_accounts where id = v_bank;
  if v_after <> v_before - 500 then
    raise exception '0447 PROBE FAILED: the bank balance moved by %, expected −500.', v_after - v_before;
  end if;
  select count(*) into v_n from public.bank_transactions where kind = 'partner_entry' and reference_id = v_id::text and account_delta = -500;
  if v_n <> 1 then raise exception '0447 PROBE FAILED: % partner_entry bank line(s) logged, expected 1.', v_n; end if;
  select coalesce(sum(jl.debit - jl.credit), 0) into v_net from public.journal_lines jl where jl.account_id = v_acct;
  if v_net <> 500 then raise exception '0447 PROBE FAILED: the capital account moved by %, expected a 500 debit.', v_net; end if;

  -- A bank drawing with no bank account is refused before anything is written.
  begin
    perform public.record_partner_entry(v_p, current_date, 'DRAWING', null, 100, 'BANK_TRANSFER', null, null);
    raise exception '0447 PROBE FAILED: a bank drawing with no bank account was accepted.';
  exception when others then
    if sqlerrm <> 'Choose the bank account.' then raise; end if;
  end;

  perform public.delete_partner_entry(v_id);
  select balance into v_after from public.bank_accounts where id = v_bank;
  if v_after <> v_before then
    raise exception '0447 PROBE FAILED: after deleting, the bank balance is % from where it started, expected 0.', v_after - v_before;
  end if;
  select coalesce(sum(jl.debit - jl.credit), 0) into v_net from public.journal_lines jl where jl.account_id = v_acct;
  if v_net <> 0 then raise exception '0447 PROBE FAILED: after deleting, the capital account nets %, expected 0.', v_net; end if;
  if exists (select 1 from public.partner_account_entries where id = v_id) then
    raise exception '0447 PROBE FAILED: the entry still exists after deleting.';
  end if;

  raise exception 'ROLLBACK_PROBE';
exception
  when others then
    perform set_config('request.jwt.claims', null, true);
    perform set_config('request.jwt.claim.sub', null, true);
    if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
    raise notice '0447 probe passed: a bank drawing moves 500 once, logged; deleting it restores the balance and nets the GL.';
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0447 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
