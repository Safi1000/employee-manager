-- 0471 — Bank of AJK's July "Rawalakot" site is removed, with its 18 attendance
-- confirmations.
--
-- The site (6446bf81-109a-4116-a278-bc43d81f56df, created 2026-07-25) belonged
-- to BAJK's first contract, which was terminated and deleted on 2026-09-22.
-- CON-0038 staffs "Main Rawalakot" instead; nothing but 18 supervisor
-- attendance_confirmations (17–29 Aug 2026, Zafar Saab / Nosherwan) still
-- pointed at it.
--
-- Named authorisation (2026-09-22): "Delete the site and the 18 sign-offs with
-- it." The confirmations are deleted explicitly rather than left to the
-- ON DELETE CASCADE, so the count removed is asserted, not assumed.
--
-- MEASURED BEFORE (prod): contract_lines 0, deployments 0, attendance_records 0,
-- vacancies 0, kit_events 0, shift_definitions 0, attendance_confirmations 18.

do $mig$
declare
  c_site   constant uuid := '6446bf81-109a-4116-a278-bc43d81f56df';
  c_client constant uuid := '9fc431f3-6329-4050-8df2-eac136278716';
  v_n int;
begin
  -- Idempotent: already gone is fine.
  if not exists (select 1 from public.sites where id = c_site) then
    raise notice '0471: site already removed.';
    return;
  end if;
  if not exists (select 1 from public.sites where id = c_site and client_id = c_client and name = 'Rawalakot') then
    raise exception '0471 REFUSED: site % is not BAJK''s "Rawalakot".', c_site;
  end if;
  if exists (select 1 from public.contract_lines where site_id = c_site)
  or exists (select 1 from public.deployments where site_id = c_site)
  or exists (select 1 from public.attendance_records where site_id = c_site)
  or exists (select 1 from public.vacancies where site_id = c_site)
  or exists (select 1 from public.kit_events where site_id = c_site) then
    raise exception '0471 REFUSED: something other than attendance confirmations now references the site.';
  end if;

  delete from public.attendance_confirmations where site_id = c_site;
  get diagnostics v_n = row_count;
  if v_n <> 18 then
    raise exception '0471 REFUSED: expected 18 attendance confirmations, found %.', v_n;
  end if;

  delete from public.shift_definitions where site_id = c_site;
  delete from public.sites where id = c_site;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0471 FAILED: site not deleted.';
  end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0471 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
