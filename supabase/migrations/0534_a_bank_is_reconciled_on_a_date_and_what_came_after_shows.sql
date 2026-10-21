-- 0534 — a bank is reconciled on a date, and what came after shows
--
-- Asked 2026-10-21 (Shayan): "last I checked everything was aligning, now it
-- isn't" — on Askari, with no way to see what had changed since. Bastion had no
-- record of WHEN a bank last agreed with the statement, so every mismatch had to
-- be hunted through the whole history.
--
-- DECIDED 2026-10-21 (Shayan):
--   * A reconciliation is a dated confirmation: "on <statement date> the bank
--     said <balance>; Bastion said <balance>", stamped with the SYSTEM time it
--     was made and who made it.
--   * Every bank movement ENTERED after that stamp — whatever date it carries,
--     backdated included — is shown apart on the Banks tab. Entry time, not the
--     document's date, is what makes "since I last checked" true:
--     bank_transactions.created_at is that time, for every movement, because
--     every movement goes through apply_money_delta.
--   * A difference left over goes to a SUSPENSE account, so Bastion's bank
--     equals the statement and the unexplained amount is parked in one visible
--     place instead of hiding in the bank.
--
--   chart of accounts       1190 Bank Suspense (asset, system key 'suspense').
--   bank_reconciliations    one row per reconciliation.
--   reconcile_bank(...)     records it; if asked and there is a difference,
--                           moves the bank to the statement figure
--                           (apply_money_delta, kind 'reconcile') and posts the
--                           other side to 1190.
--   clear_bank_suspense(..) when the real cause is found and recorded properly,
--                           takes the suspense amount back out of the bank and
--                           1190 — otherwise recording the cause would count it
--                           twice.
--
-- Both functions SECURITY DEFINER, gated on accounting.edit, tenant-guarded,
-- single-row (one bank, or one reconciliation). The bank row is locked FOR
-- UPDATE while the book figure is read and moved, so a payment saved at the
-- same moment cannot fall between the reading and the adjustment.
-- Rows are written only by the functions; reading follows bank_accounts (0531).
--
-- No screen owes this: the Banks tab gains the reconcile action, each bank's
-- last reconciliation, and the "entered since" list in the same release.
--
-- Idempotent: if-not-exists / create-or-replace throughout.

-- ── 1190 Bank Suspense ───────────────────────────────────────────────────────
insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side, system_key, system_account, active, is_control, notes)
select c.company_id, '1190', 'Bank Suspense', 'asset', 'debit', 'suspense', true, true, false,
       'Unexplained bank reconciliation differences, parked until found. Should return to zero. 0534.'
  from (select distinct company_id from public.chart_of_accounts where system_key = 'ar') c
 where not exists (select 1 from public.chart_of_accounts x
                    where x.company_id = c.company_id
                      and (x.system_key = 'suspense' or x.account_code = '1190'));

-- ── the register ─────────────────────────────────────────────────────────────
create table if not exists public.bank_reconciliations (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id),
  bank_account_id     uuid not null references public.bank_accounts(id),
  statement_date      date not null,
  statement_balance   numeric(14,2) not null,
  book_balance        numeric(14,2) not null,
  difference          numeric(14,2) not null,       -- statement − book, before any suspense entry
  posted_to_suspense  boolean not null default false,
  suspense_journal_id uuid references public.journal_entries(id),
  notes               text,
  reconciled_at       timestamptz not null default now(),
  reconciled_by       uuid default auth.uid(),
  cleared_at          timestamptz,
  cleared_by          uuid,
  clear_journal_id    uuid references public.journal_entries(id),
  clear_note          text,
  constraint bank_reconciliations_diff_chk check (difference = statement_balance - book_balance),
  constraint bank_reconciliations_suspense_chk check (not posted_to_suspense or difference <> 0),
  constraint bank_reconciliations_clear_chk check (cleared_at is null or posted_to_suspense)
);
create index if not exists bank_reconciliations_bank_idx on public.bank_reconciliations (bank_account_id, reconciled_at desc);

comment on table public.bank_reconciliations is
  '0534. A dated confirmation that a bank agreed with its statement (or by how much it did not), stamped with '
  'the system time. Movements entered after reconciled_at are shown apart on the Banks tab. A difference may be '
  'parked in 1190 Bank Suspense and later cleared. Written only by reconcile_bank and clear_bank_suspense.';

alter table public.bank_reconciliations enable row level security;
drop policy if exists company_members on public.bank_reconciliations;
create policy company_members on public.bank_reconciliations as permissive for all
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));
drop policy if exists ssa_all on public.bank_reconciliations;
create policy ssa_all on public.bank_reconciliations as permissive for all
  using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()));
drop policy if exists perm_read on public.bank_reconciliations;
create policy perm_read on public.bank_reconciliations as restrictive for select using (
  (select public.has_perm('banks.view')) or (select public.has_perm('accounting.edit')) or (select public.has_perm('reports.view'))
  or (select public.has_perm('cashflow.view')) or (select public.has_perm('accountant.view')) or (select public.has_perm('reversals.execute')));

revoke all on public.bank_reconciliations from anon;
revoke insert, update, delete on public.bank_reconciliations from authenticated;
grant select on public.bank_reconciliations to authenticated;

drop trigger if exists trg_zzz_bank_reconciliations_audit on public.bank_reconciliations;
create trigger trg_zzz_bank_reconciliations_audit after insert or update or delete on public.bank_reconciliations
  for each row execute function public.log_audit_change();

-- ── the account, for a company seeded after this migration ───────────────────
create or replace function public.bank_suspense_account(p_company_id uuid)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare v_id uuid;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  v_id := public.coa_id(p_company_id, 'suspense');
  if v_id is null then
    insert into public.chart_of_accounts
      (company_id, account_code, account_name, account_type, normal_side, system_key, system_account, active, is_control, notes)
    values (p_company_id, '1190', 'Bank Suspense', 'asset', 'debit', 'suspense', true, true, false,
            'Unexplained bank reconciliation differences, parked until found. Should return to zero. 0534.')
    returning id into v_id;
  end if;
  return v_id;
end $function$;
revoke all on function public.bank_suspense_account(uuid) from public, anon, authenticated;

-- ── reconcile ────────────────────────────────────────────────────────────────
create or replace function public.reconcile_bank(
  p_bank_account_id uuid, p_statement_date date, p_statement_balance numeric,
  p_post_difference boolean default true, p_notes text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare b public.bank_accounts; v_diff numeric; v_id uuid; v_je uuid; v_desc text;
begin
  perform public.require_perm('accounting.edit');
  -- tenant guard [resolved]: owning company from p_bank_account_id via public.bank_accounts
  if p_bank_account_id is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;

  if p_statement_date is null then raise exception 'Enter the statement date. Nothing has been recorded.'; end if;
  if p_statement_balance is null then raise exception 'Enter the balance the bank shows. Nothing has been recorded.'; end if;

  -- Locked: the book figure read here is the one the adjustment moves from.
  select * into b from public.bank_accounts where id = p_bank_account_id for update;
  if b.id is null then raise exception 'That bank account does not exist. Nothing has been recorded.'; end if;

  v_diff := round(p_statement_balance - b.balance, 2);

  insert into public.bank_reconciliations
    (company_id, bank_account_id, statement_date, statement_balance, book_balance, difference, posted_to_suspense, notes)
  values (b.company_id, b.id, p_statement_date, p_statement_balance, b.balance, v_diff,
          coalesce(p_post_difference, true) and v_diff <> 0, nullif(btrim(p_notes), ''))
  returning id into v_id;

  if coalesce(p_post_difference, true) and v_diff <> 0 then
    v_desc := format('Reconciliation %s: %s %s to match the statement (to suspense)',
                     to_char(p_statement_date, 'DD Mon YYYY'), b.bank_name,
                     case when v_diff > 0 then 'up' else 'down' end);
    perform public.apply_money_delta(b.company_id, 'Bank', b.id, v_diff, 'reconcile', v_desc, v_id::text);
    v_je := public.post_journal(b.company_id, p_statement_date, v_desc, 'bank_reconciliations', v_id, false,
      jsonb_build_array(
        jsonb_build_object('account_id', public.bank_account_gl(b.company_id, b.id),
                           'debit', greatest(v_diff, 0), 'credit', greatest(-v_diff, 0)),
        jsonb_build_object('account_id', public.bank_suspense_account(b.company_id),
                           'debit', greatest(-v_diff, 0), 'credit', greatest(v_diff, 0))));
    update public.bank_reconciliations set suspense_journal_id = v_je where id = v_id;
  end if;

  return v_id;
end $function$;

-- ── clear a parked difference once its cause is recorded ─────────────────────
create or replace function public.clear_bank_suspense(p_reconciliation_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare r public.bank_reconciliations; v_desc text; v_je uuid; v_n int;
begin
  perform public.require_perm('accounting.edit');
  -- tenant guard [resolved]: owning company from p_reconciliation_id via public.bank_reconciliations
  if p_reconciliation_id is not null then perform public.assert_same_company((select company_id from public.bank_reconciliations where id = p_reconciliation_id)); end if;

  select * into r from public.bank_reconciliations where id = p_reconciliation_id for update;
  if r.id is null then raise exception 'That reconciliation does not exist. Nothing has been recorded.'; end if;
  if not r.posted_to_suspense then raise exception 'This reconciliation parked nothing in suspense. Nothing has been recorded.'; end if;
  if r.cleared_at is not null then raise exception 'This suspense amount was already cleared. Nothing has been recorded.'; end if;
  if nullif(btrim(p_note), '') is null then
    raise exception 'Say what the difference turned out to be. Nothing has been recorded.';
  end if;

  perform 1 from public.bank_accounts where id = r.bank_account_id for update;
  v_desc := format('Suspense cleared (reconciliation %s): %s', to_char(r.statement_date, 'DD Mon YYYY'), btrim(p_note));
  perform public.apply_money_delta(r.company_id, 'Bank', r.bank_account_id, -r.difference, 'reconcile', v_desc, r.id::text);
  v_je := public.post_journal(r.company_id, current_date, v_desc, 'bank_reconciliations', r.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', public.bank_account_gl(r.company_id, r.bank_account_id),
                         'debit', greatest(-r.difference, 0), 'credit', greatest(r.difference, 0)),
      jsonb_build_object('account_id', public.bank_suspense_account(r.company_id),
                         'debit', greatest(r.difference, 0), 'credit', greatest(-r.difference, 0))));

  update public.bank_reconciliations
     set cleared_at = now(), cleared_by = auth.uid(), clear_journal_id = v_je, clear_note = btrim(p_note)
   where id = r.id and cleared_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The suspense amount could not be cleared. Nothing has been recorded.'; end if;
end $function$;

revoke all on function public.reconcile_bank(uuid, date, numeric, boolean, text) from public, anon;
revoke all on function public.clear_bank_suspense(uuid, text) from public, anon;
grant execute on function public.reconcile_bank(uuid, date, numeric, boolean, text) to authenticated;
grant execute on function public.clear_bank_suspense(uuid, text) to authenticated;

-- ── asserts — on the things that can break ───────────────────────────────────
do $$
declare v_n int; v_m int; v_who text;
begin
  select count(distinct company_id) into v_n from public.chart_of_accounts where system_key = 'ar';
  select count(*) into v_m from public.chart_of_accounts where system_key = 'suspense';
  if v_m <> v_n then raise exception '0534 REFUSED: % companies have a chart but % carry 1190.', v_n, v_m; end if;

  -- 'reconcile' must still be an admissible movement kind (0533 restated the list).
  select count(*) into v_n from pg_constraint
   where conname = 'bank_transactions_kind_check' and pg_get_constraintdef(oid) like '%''reconcile''%';
  if v_n <> 1 then raise exception '0534 REFUSED: bank_transactions_kind_check does not admit reconcile.'; end if;

  if has_table_privilege('authenticated', 'public.bank_reconciliations', 'INSERT')
     or has_table_privilege('authenticated', 'public.bank_reconciliations', 'UPDATE')
     or has_table_privilege('authenticated', 'public.bank_reconciliations', 'DELETE') then
    raise exception '0534 REFUSED: authenticated can write bank_reconciliations directly.';
  end if;
  if has_function_privilege('authenticated', 'public.bank_suspense_account(uuid)', 'EXECUTE') then
    raise exception '0534 REFUSED: bank_suspense_account is callable by authenticated.';
  end if;
  select count(*) into v_n from pg_policies
   where tablename = 'bank_reconciliations' and policyname = 'perm_read' and permissive = 'RESTRICTIVE';
  if v_n <> 1 then raise exception '0534 REFUSED: bank_reconciliations has no restrictive read gate.'; end if;

  select count(*), string_agg(key::text, ', ') into v_n, v_who from public.permission_key_gaps();
  if v_n <> 0 then raise exception '0534 REFUSED: permission_key_gaps() reports %: %', v_n, v_who; end if;
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ') into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then raise exception '0534 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who; end if;
end $$;
