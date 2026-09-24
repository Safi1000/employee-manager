-- 0484 — custody_transfers: the staff→staff transfer goes through an RPC on
-- accounting.edit, and the table is gated. The bank→custodian path already routes
-- through record_bank_to_custodian (0143); this closes the one raw path left.
--
-- A custody transfer posts to the GL (journal_on_custody_transfer) and shifts held
-- cash between custodians, so it is an accounting write. custody_transfers has NO
-- fill_company trigger, so the RPC sets company_id itself — from the FROM location,
-- which it has already asserted belongs to the caller's company.

create or replace function public.record_custody_transfer(
  p_from_location_id uuid,
  p_to_location_id   uuid,
  p_amount           numeric,
  p_date             date,
  p_notes            text
) returns uuid
  language plpgsql
  security definer
  set search_path to 'public'
as $fn$
declare v_company uuid; v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  -- Tenant guard: both endpoints must belong to the caller's company. The param
  -- names appear inside the asserts so tenant_guard_gaps() sees them covered.
  perform public.assert_same_company((select company_id from public.cash_locations where id = p_from_location_id));
  perform public.assert_same_company((select company_id from public.cash_locations where id = p_to_location_id));

  if p_amount is null or p_amount <= 0 then
    raise exception 'A custody transfer needs a positive amount. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'From and To locations must be different. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  select company_id into v_company from public.cash_locations where id = p_from_location_id;

  insert into public.custody_transfers
    (company_id, date, from_location_id, to_location_id, amount, notes, created_by)
  values
    (v_company, p_date, p_from_location_id, p_to_location_id, p_amount, p_notes, auth.uid())
  returning id into v_id;
  return v_id;
end $fn$;

grant execute on function public.record_custody_transfer(uuid, uuid, numeric, date, text) to authenticated;

-- Gate the table. record_custody_transfer and record_bank_to_custodian are both
-- definer and bypass this; only raw client writes are blocked.
drop policy if exists perm_write_ins on public.custody_transfers;
drop policy if exists perm_write_upd on public.custody_transfers;
drop policy if exists perm_write_del on public.custody_transfers;
create policy perm_write_ins on public.custody_transfers as restrictive for insert
  with check ((select public.has_perm('accounting.edit')));
create policy perm_write_upd on public.custody_transfers as restrictive for update
  using ((select public.has_perm('accounting.edit')))
  with check ((select public.has_perm('accounting.edit')));
create policy perm_write_del on public.custody_transfers as restrictive for delete
  using ((select public.has_perm('accounting.edit')));

-- ── verification ───────────────────────────────────────────────────────────────
do $mig$
declare v_n int;
begin
  if not exists (select 1 from public.permission_keys where key = 'accounting.edit') then
    raise exception '0484 FAILED: accounting.edit missing from permission_keys.';
  end if;
  select count(*) into v_n from pg_policy p join pg_class c on c.oid=p.polrelid
    where c.relname='custody_transfers' and p.polname like 'perm_write_%';
  if v_n <> 3 then raise exception '0484 FAILED: expected 3 perm_write policies, found %.', v_n; end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0484 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
