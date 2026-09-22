-- 0468 — Bank of AJK's 213 duplicate sites are removed, and a site name is
-- unique per client.
--
-- WHAT HAPPENED. On 2026-09-22 the contract editor was used to set up BAJK
-- (client 9fc431f3-6329-4050-8df2-eac136278716). Its save was ~70 separate
-- round trips: sites first, then the contract, then the lines. The lines of a
-- new Active contract are always refused by 0450's committed-total invariant
-- (baseline 0 -> "was 0, now 4"), but by then the sites had committed — and the
-- form never wrote the new site ids back into its state, so every retry
-- inserted the same ~30 sites again. Six attempts left 244 sites for 31 real
-- names; four orphan Active contracts were created and later deleted by hand.
-- CON-0038 (saved as Draft, then flipped to Active) is correct: 30 lines,
-- committed 52, pointing at 30 of the sites.
--
-- MEASURED BEFORE (prod): 244 BAJK sites. 30 referenced by contract_lines, 1
-- by something else (the July "Rawalakot"), 213 referenced by nothing —
-- including no shift_definitions. Every other client: zero duplicate names.
--
-- Named authorisation (2026-09-22): "yes cleanup" of the 213 unreferenced BAJK
-- sites on crm-design (mmkfpnshxjcyijhuydgr).
--
-- THE INDEX. The duplication was possible because nothing in the database says
-- a client cannot have two sites of the same name. Now something does:
-- sites_client_name_key on (client_id, lower(btrim(name))). Whatever a screen
-- does next, a second "Bagh" under BAJK is refused rather than stored.
-- save_contract (0469) resolves a new site by that same key, so re-saving a
-- form reuses the site instead of tripping the index.

do $mig$
declare
  c_client constant uuid := '9fc431f3-6329-4050-8df2-eac136278716';
  v_doomed uuid[];
  v_n int;
begin
  select coalesce(array_agg(s.id), '{}') into v_doomed
    from public.sites s
   where s.client_id = c_client
     and not exists (select 1 from public.contract_lines x          where x.site_id = s.id)
     and not exists (select 1 from public.deployments x             where x.site_id = s.id)
     and not exists (select 1 from public.attendance_records x      where x.site_id = s.id)
     and not exists (select 1 from public.attendance_confirmations x where x.site_id = s.id)
     and not exists (select 1 from public.vacancies x               where x.site_id = s.id)
     and not exists (select 1 from public.kit_events x              where x.site_id = s.id)
     and not exists (select 1 from public.shift_definitions x       where x.site_id = s.id);

  -- Idempotent: an already-cleaned database has nothing unreferenced to remove.
  -- Anything other than 0 or the measured 213 is a state nobody looked at.
  v_n := cardinality(v_doomed);
  if v_n not in (0, 213) then
    raise exception '0468 REFUSED: expected 213 unreferenced BAJK sites (or 0 if already applied), found %.', v_n;
  end if;

  delete from public.sites where id = any (v_doomed);
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_doomed) then
    raise exception '0468 FAILED: deleted % of % sites.', v_n, cardinality(v_doomed);
  end if;
  raise notice '0468: removed % duplicate BAJK site(s).', v_n;
end $mig$;

create unique index if not exists sites_client_name_key
  on public.sites (client_id, lower(btrim(name)));

-- Verification: the failure being guarded is "a duplicate name survives", which
-- is answered by counting duplicate names, not by counting rows removed.
do $mig$
declare v_dups int; v_bajk int;
begin
  select count(*) into v_dups from (
    select 1 from public.sites group by client_id, lower(btrim(name)) having count(*) > 1) d;
  if v_dups <> 0 then raise exception '0468 FAILED: % duplicate (client, name) pair(s) remain.', v_dups; end if;
  select count(*) into v_bajk from public.sites where client_id = '9fc431f3-6329-4050-8df2-eac136278716';
  if v_bajk <> 31 then raise exception '0468 FAILED: BAJK has % sites, expected 31.', v_bajk; end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0468 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
