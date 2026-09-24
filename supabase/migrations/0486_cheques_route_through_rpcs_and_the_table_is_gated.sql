-- 0486 — cheques: creation and status changes go through RPCs on accounting.edit,
-- and the table is gated. A cheque posts to the GL (journal_on_cheque) and its
-- clearance/bounce moves a bank/treasury balance (cheque_apply_balance /
-- cheque_bounce fire on the status update) — all accounting acts.
--
-- record_cheque covers both raw insert sites (the invoice-payment cheque and the
-- general cheque add). set_cheque_status does the cleared/bounced update the same
-- way the browser did, so the balance and journal triggers fire unchanged.
-- company_id/region are filled by the table's own BEFORE-INSERT triggers.

create or replace function public.record_cheque(
  p_bank_account_id       uuid,
  p_cheque_number         text,
  p_amount                numeric,
  p_cheque_date           date,
  p_cheque_type           text,
  p_direction             text,
  p_recipient             text,
  p_notes                 text,
  p_invoice_id            uuid default null,
  p_client_id             uuid default null,
  p_custodian_location_id uuid default null
) returns uuid
  language plpgsql
  security definer
  set search_path to 'public'
as $fn$
declare v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  -- Tenant: every uuid endpoint must belong to the caller's company (null-safe).
  if p_bank_account_id is not null then
    perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id));
  end if;
  if p_invoice_id is not null then
    perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id));
  end if;
  if p_client_id is not null then
    perform public.assert_same_company((select company_id from public.clients where id = p_client_id));
  end if;
  if p_custodian_location_id is not null then
    perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id));
  end if;

  insert into public.cheques
    (bank_account_id, cheque_number, amount, cheque_date, cheque_type, direction,
     recipient, notes, invoice_id, client_id, custodian_location_id, status)
  values
    (p_bank_account_id, p_cheque_number, p_amount, p_cheque_date,
     p_cheque_type::public.cheque_type, p_direction, p_recipient, p_notes,
     p_invoice_id, p_client_id, p_custodian_location_id, 'pending')
  returning id into v_id;
  return v_id;
end $fn$;

grant execute on function public.record_cheque(uuid, text, numeric, date, text, text, text, text, uuid, uuid, uuid) to authenticated;

create or replace function public.set_cheque_status(
  p_cheque_id     uuid,
  p_status        text,
  p_bounce_reason text default null
) returns void
  language plpgsql
  security definer
  set search_path to 'public'
as $fn$
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  perform public.assert_same_company((select company_id from public.cheques where id = p_cheque_id));
  if p_status not in ('pending', 'cleared', 'bounced') then
    raise exception 'Unknown cheque status %. Nothing has been recorded.', p_status using errcode = 'P0001';
  end if;
  -- Same UPDATE the browser did: the balance and journal triggers fire on it.
  update public.cheques
     set status = p_status,
         bounce_reason = case when p_status = 'bounced' then p_bounce_reason else bounce_reason end
   where id = p_cheque_id;
  if not found then
    raise exception 'That cheque no longer exists. Nothing has been recorded.' using errcode = 'P0001';
  end if;
end $fn$;

grant execute on function public.set_cheque_status(uuid, text, text) to authenticated;

-- Gate the table. record_cheque / set_cheque_status (and sync_cheque_journal, and
-- any definer payment RPC that issues a cheque) run as owner and bypass this; only
-- raw client writes are blocked. The Drive-metadata patch after record_cheque is
-- by the same accounting.edit user, so it passes.
drop policy if exists perm_write_ins on public.cheques;
drop policy if exists perm_write_upd on public.cheques;
drop policy if exists perm_write_del on public.cheques;
create policy perm_write_ins on public.cheques as restrictive for insert
  with check ((select public.has_perm('accounting.edit')));
create policy perm_write_upd on public.cheques as restrictive for update
  using ((select public.has_perm('accounting.edit')))
  with check ((select public.has_perm('accounting.edit')));
create policy perm_write_del on public.cheques as restrictive for delete
  using ((select public.has_perm('accounting.edit')));

-- ── verification ───────────────────────────────────────────────────────────────
do $mig$
declare v_n int;
begin
  if not exists (select 1 from public.permission_keys where key = 'accounting.edit') then
    raise exception '0486 FAILED: accounting.edit missing from permission_keys.';
  end if;
  select count(*) into v_n from pg_policy p join pg_class c on c.oid=p.polrelid
    where c.relname='cheques' and p.polname like 'perm_write_%';
  if v_n <> 3 then raise exception '0486 FAILED: expected 3 perm_write policies, found %.', v_n; end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0486 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
