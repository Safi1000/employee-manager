-- 0533 — a security deposit is the company's money held elsewhere
--
-- Found 2026-10-21: a 40,000 bid security (a pay order bought from Askari in
-- July 2026, before Bastion existed) came back and was deposited on 9 Oct.
-- Bastion could record that only as income, and giving one out only as an
-- expense. It is neither: while it is out it is an ASSET — the company's own
-- money that a tender authority, client or landlord holds and must return —
-- and coming back it simply turns back into bank money. Askari ran 40,000
-- above Bastion because the return had nowhere to go.
--
-- DECIDED 2026-10-21 (Shayan): a proper register, for this one and every
-- future one.
--
--   chart of accounts   1170 Security Deposits (asset, system key
--                       'security_deposits'), for every company with a chart.
--   security_deposits   one row per deposit: purpose (bid / performance /
--                       rent / other), party, instrument (pay order / cheque /
--                       CDR / other), reference, amount, date given and from
--                       which bank, and — once back — date returned and to
--                       which bank.
--   record_security_deposit(...)          money out: bank down, 1170 up.
--   return_security_deposit(...)          money back: bank up, 1170 down.
--   record_opening_security_deposit(...)  a deposit given BEFORE the books
--                       start. No bank moves now (the money left before the
--                       bank's opening figure was taken); it reaches the
--                       ledger through the opening trial balance, which the
--                       Opening Balances screen prefills from this register
--                       like it does banks and clients. Refused once the
--                       company's opening batch is posted, because the opening
--                       could then no longer carry it.
--
-- Money moves through apply_money_delta (kind 'security_deposit', added to
-- bank_transactions_kind_check below), so the bank balance, its transaction
-- log and the ledger move together in one transaction — the reconciliation in
-- ledger_checks_base reads exactly that log. All three functions are
-- SECURITY DEFINER, gated on accounting.edit (the key every other bank move
-- asks), tenant-guarded on every uuid they take, and single-row: each names
-- one deposit or one bank, so none is a set operation.
--
-- Rows are written ONLY by those functions: authenticated may read the table
-- (with the same restrictive read gate 0531 put on bank_accounts) and may not
-- insert, update or delete it directly — a register row written by hand would
-- be a deposit with no money behind it.
--
-- No screen owes this: the Banks tab gains the register and both actions in
-- the same release, and Opening Balances reads it.
--
-- DEFERRED: a deposit FORFEITED (kept by the other side) is a loss, and which
-- expense account it lands in is policy not yet decided. Today a forfeit
-- would stay "outstanding". The change, when decided: a
-- forfeit_security_deposit() posting Dr <that account> / Cr 1170 and setting
-- status 'forfeited' (the check constraint below already admits it).
-- DEFERRED: a mistaken entry is reversed by hand (a journal and a bank
-- adjustment); there is no one-click reversal yet.
--
-- Idempotent: if-not-exists / create-or-replace throughout.

-- ── 1170 Security Deposits ───────────────────────────────────────────────────
insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side, system_key, system_account, active, is_control, notes)
select c.company_id, '1170', 'Security Deposits', 'asset', 'debit', 'security_deposits', true, true, false,
       'Refundable deposits held by others (bid, performance, rent). 0533.'
  from (select distinct company_id from public.chart_of_accounts where system_key = 'ar') c
 where not exists (select 1 from public.chart_of_accounts x
                    where x.company_id = c.company_id
                      and (x.system_key = 'security_deposits' or x.account_code = '1170'));

-- ── bank_transactions may log the movement ───────────────────────────────────
alter table public.bank_transactions drop constraint if exists bank_transactions_kind_check;
alter table public.bank_transactions add constraint bank_transactions_kind_check check (kind = any (array[
  'opening', 'deposit', 'withdraw_to_cash', 'payroll', 'reconcile', 'adjustment', 'cash_adjustment',
  'expense', 'receipt', 'advance', 'transfer', 'cheque', 'partner_entry', 'security_deposit']));

-- ── the register ─────────────────────────────────────────────────────────────
create table if not exists public.security_deposits (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id),
  purpose              text not null check (purpose in ('bid', 'performance', 'rent', 'other')),
  party                text not null check (btrim(party) <> ''),
  instrument           text not null check (instrument in ('pay_order', 'cheque', 'cdr', 'other')),
  reference            text,
  amount               numeric(14,2) not null check (amount > 0),
  given_on             date not null,
  given_from_bank_id   uuid references public.bank_accounts(id),
  given_before_books   boolean not null default false,
  given_journal_id     uuid references public.journal_entries(id),
  status               text not null default 'outstanding' check (status in ('outstanding', 'returned', 'forfeited')),
  returned_on          date,
  returned_to_bank_id  uuid references public.bank_accounts(id),
  returned_journal_id  uuid references public.journal_entries(id),
  notes                text,
  created_by           uuid default auth.uid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Given from a bank now, or before the books with no bank: never both.
  constraint security_deposits_source_chk check (given_before_books = (given_from_bank_id is null)),
  -- Returned carries its date and bank; nothing else does.
  constraint security_deposits_return_chk check (
    (status = 'returned') = (returned_on is not null and returned_to_bank_id is not null)),
  constraint security_deposits_return_after_chk check (returned_on is null or returned_on >= given_on)
);
create index if not exists security_deposits_company_idx on public.security_deposits (company_id, status);

comment on table public.security_deposits is
  '0533. Refundable deposits the company has given (bid, performance, rent): its own money held elsewhere, '
  'carried in 1170 Security Deposits. Written only by record_security_deposit, return_security_deposit and '
  'record_opening_security_deposit. DEFERRED: forfeiture (which expense account) and one-click reversal.';

alter table public.security_deposits enable row level security;
drop policy if exists company_members on public.security_deposits;
create policy company_members on public.security_deposits as permissive for all
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));
drop policy if exists ssa_all on public.security_deposits;
create policy ssa_all on public.security_deposits as permissive for all
  using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()));
drop policy if exists perm_read on public.security_deposits;
create policy perm_read on public.security_deposits as restrictive for select using (
  (select public.has_perm('banks.view')) or (select public.has_perm('accounting.edit')) or (select public.has_perm('reports.view'))
  or (select public.has_perm('cashflow.view')) or (select public.has_perm('accountant.view')) or (select public.has_perm('reversals.execute')));

revoke all on public.security_deposits from anon;
revoke insert, update, delete on public.security_deposits from authenticated;
grant select on public.security_deposits to authenticated;

drop trigger if exists trg_security_deposits_updated_at on public.security_deposits;
create trigger trg_security_deposits_updated_at before update on public.security_deposits
  for each row execute function public.set_updated_at();
drop trigger if exists trg_zzz_security_deposits_audit on public.security_deposits;
create trigger trg_zzz_security_deposits_audit after insert or update or delete on public.security_deposits
  for each row execute function public.log_audit_change();

-- ── the account, for a company seeded after this migration ───────────────────
create or replace function public.security_deposits_account(p_company_id uuid)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare v_id uuid;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  v_id := public.coa_id(p_company_id, 'security_deposits');
  if v_id is null then
    insert into public.chart_of_accounts
      (company_id, account_code, account_name, account_type, normal_side, system_key, system_account, active, is_control, notes)
    values (p_company_id, '1170', 'Security Deposits', 'asset', 'debit', 'security_deposits', true, true, false,
            'Refundable deposits held by others (bid, performance, rent). 0533.')
    returning id into v_id;
  end if;
  return v_id;
end $function$;
revoke all on function public.security_deposits_account(uuid) from public, anon, authenticated;

-- ── money out ────────────────────────────────────────────────────────────────
create or replace function public.record_security_deposit(
  p_bank_account_id uuid, p_amount numeric, p_given_on date, p_purpose text, p_party text,
  p_instrument text, p_reference text default null, p_notes text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare v_company uuid; v_id uuid; v_desc text; v_je uuid;
begin
  perform public.require_perm('accounting.edit');
  -- tenant guard [resolved]: owning company from p_bank_account_id via public.bank_accounts
  if p_bank_account_id is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;

  select company_id into v_company from public.bank_accounts where id = p_bank_account_id;
  if v_company is null then raise exception 'Choose the bank the deposit was paid from. Nothing has been recorded.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'The deposit amount must be more than zero. Nothing has been recorded.'; end if;
  if p_given_on is null then raise exception 'Enter the date the deposit was given. Nothing has been recorded.'; end if;

  insert into public.security_deposits
    (company_id, purpose, party, instrument, reference, amount, given_on, given_from_bank_id, given_before_books, notes)
  values (v_company, p_purpose, btrim(p_party), p_instrument, nullif(btrim(p_reference), ''), p_amount, p_given_on,
          p_bank_account_id, false, nullif(btrim(p_notes), ''))
  returning id into v_id;

  v_desc := format('Security deposit (%s) to %s', p_purpose, btrim(p_party))
            || coalesce(' — ' || nullif(btrim(p_reference), ''), '');

  perform public.apply_money_delta(v_company, 'Bank', p_bank_account_id, -p_amount, 'security_deposit', v_desc, v_id::text);

  v_je := public.post_journal(v_company, p_given_on, v_desc, 'security_deposits', v_id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', public.security_deposits_account(v_company), 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', public.bank_account_gl(v_company, p_bank_account_id), 'debit', 0, 'credit', p_amount)));

  update public.security_deposits set given_journal_id = v_je where id = v_id;
  return v_id;
end $function$;

-- ── money back ───────────────────────────────────────────────────────────────
create or replace function public.return_security_deposit(
  p_deposit_id uuid, p_bank_account_id uuid, p_returned_on date, p_notes text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare d public.security_deposits; v_bank_company uuid; v_desc text; v_je uuid; v_n int;
begin
  perform public.require_perm('accounting.edit');
  -- tenant guard [resolved]: owning company from p_deposit_id via public.security_deposits
  if p_deposit_id is not null then perform public.assert_same_company((select company_id from public.security_deposits where id = p_deposit_id)); end if;
  -- tenant guard [resolved]: owning company from p_bank_account_id via public.bank_accounts
  if p_bank_account_id is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;

  select * into d from public.security_deposits where id = p_deposit_id for update;
  if d.id is null then raise exception 'That security deposit does not exist. Nothing has been recorded.'; end if;
  if d.status <> 'outstanding' then
    raise exception 'This security deposit is already %, so it cannot be returned again. Nothing has been recorded.', d.status;
  end if;
  select company_id into v_bank_company from public.bank_accounts where id = p_bank_account_id;
  if v_bank_company is distinct from d.company_id then
    raise exception 'Choose the bank the deposit came back into. Nothing has been recorded.';
  end if;
  if p_returned_on is null or p_returned_on < d.given_on then
    raise exception 'The return date must be on or after the date it was given (%). Nothing has been recorded.', d.given_on;
  end if;

  v_desc := format('Security deposit (%s) returned by %s', d.purpose, d.party)
            || coalesce(' — ' || d.reference, '');

  perform public.apply_money_delta(d.company_id, 'Bank', p_bank_account_id, d.amount, 'security_deposit', v_desc, d.id::text);

  v_je := public.post_journal(d.company_id, p_returned_on, v_desc, 'security_deposits', d.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', public.bank_account_gl(d.company_id, p_bank_account_id), 'debit', d.amount, 'credit', 0),
      jsonb_build_object('account_id', public.security_deposits_account(d.company_id), 'debit', 0, 'credit', d.amount)));

  update public.security_deposits
     set status = 'returned', returned_on = p_returned_on, returned_to_bank_id = p_bank_account_id,
         returned_journal_id = v_je,
         notes = coalesce(notes || E'\n', '') || nullif(btrim(p_notes), '')
   where id = d.id and status = 'outstanding';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The security deposit could not be marked returned. Nothing has been recorded.'; end if;
end $function$;

-- ── given before the books started ───────────────────────────────────────────
create or replace function public.record_opening_security_deposit(
  p_company_id uuid, p_amount numeric, p_given_on date, p_purpose text, p_party text,
  p_instrument text, p_reference text default null, p_notes text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare v_id uuid;
begin
  perform public.require_perm('accounting.edit');
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  if p_company_id is null then raise exception 'A security deposit needs a company. Nothing has been recorded.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'The deposit amount must be more than zero. Nothing has been recorded.'; end if;
  if p_given_on is null then raise exception 'Enter the date the deposit was given. Nothing has been recorded.'; end if;
  if exists (select 1 from public.opening_balance_batches b
              where b.company_id = p_company_id and b.status::text = 'posted') then
    raise exception 'The opening balances are already posted, so a deposit from before the books can no longer go into them. Record it with a journal instead. Nothing has been recorded.';
  end if;

  insert into public.security_deposits
    (company_id, purpose, party, instrument, reference, amount, given_on, given_from_bank_id, given_before_books, notes)
  values (p_company_id, p_purpose, btrim(p_party), p_instrument, nullif(btrim(p_reference), ''), p_amount, p_given_on,
          null, true, nullif(btrim(p_notes), ''))
  returning id into v_id;
  return v_id;
end $function$;

revoke all on function public.record_security_deposit(uuid, numeric, date, text, text, text, text, text) from public, anon;
revoke all on function public.return_security_deposit(uuid, uuid, date, text) from public, anon;
revoke all on function public.record_opening_security_deposit(uuid, numeric, date, text, text, text, text, text) from public, anon;
grant execute on function public.record_security_deposit(uuid, numeric, date, text, text, text, text, text) to authenticated;
grant execute on function public.return_security_deposit(uuid, uuid, date, text) to authenticated;
grant execute on function public.record_opening_security_deposit(uuid, numeric, date, text, text, text, text, text) to authenticated;

-- ── asserts — on the things that can break ───────────────────────────────────
do $$
declare v_n int; v_m int; v_who text;
begin
  -- Every company with a chart now has exactly one 1170.
  select count(distinct company_id) into v_n from public.chart_of_accounts where system_key = 'ar';
  select count(*) into v_m from public.chart_of_accounts where system_key = 'security_deposits';
  if v_m <> v_n then raise exception '0533 REFUSED: % companies have a chart but % carry 1170.', v_n, v_m; end if;

  -- The new movement kind is admissible, and the old ones still are.
  select count(*) into v_n from pg_constraint
   where conname = 'bank_transactions_kind_check' and pg_get_constraintdef(oid) like '%security_deposit%'
     and pg_get_constraintdef(oid) like '%partner_entry%';
  if v_n <> 1 then raise exception '0533 REFUSED: bank_transactions_kind_check does not admit security_deposit.'; end if;

  -- Nobody can write the register except through the functions.
  if has_table_privilege('authenticated', 'public.security_deposits', 'INSERT')
     or has_table_privilege('authenticated', 'public.security_deposits', 'UPDATE')
     or has_table_privilege('authenticated', 'public.security_deposits', 'DELETE') then
    raise exception '0533 REFUSED: authenticated can write security_deposits directly.';
  end if;
  if has_function_privilege('authenticated', 'public.security_deposits_account(uuid)', 'EXECUTE') then
    raise exception '0533 REFUSED: security_deposits_account is callable by authenticated.';
  end if;

  -- Read gate in place.
  select count(*) into v_n from pg_policies
   where tablename = 'security_deposits' and policyname = 'perm_read' and permissive = 'RESTRICTIVE';
  if v_n <> 1 then raise exception '0533 REFUSED: security_deposits has no restrictive read gate.'; end if;

  select count(*), string_agg(key::text, ', ') into v_n, v_who from public.permission_key_gaps();
  if v_n <> 0 then raise exception '0533 REFUSED: permission_key_gaps() reports %: %', v_n, v_who; end if;
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ') into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then raise exception '0533 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who; end if;
end $$;
