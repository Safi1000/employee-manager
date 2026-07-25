-- 0125: Phase 5 — Bank of AJK pilot setup (§13).
--
-- Bank of AJK client already exists (prefix 'BOAJK' already set). This sets up
-- its Phase-1 model with reasonable, spec-consistent defaults so the 52-guard
-- pilot can use the new client-first hiring flow:
--   * one default site,
--   * day + night 12-hour shift_definitions (banks run 24/7 guarding),
--   * a guard_deployment contract,
--   * a GUARD strength line of 52 (the pilot target headcount).
--
-- ASSUMPTIONS (noted; adjust via UI once the real 52 are known):
--   * Single GUARD strength line of 52; the per-shift split of actual guards is
--     decided per guard at hiring (each posting carries its shift).
--   * Site location 'Main branch' placeholder.
-- Additive + idempotent. No rows dropped.

do $$
declare
  v_client   uuid;
  v_company  uuid;
  v_site     uuid;
  v_contract uuid;
begin
  select id, company_id into v_client, v_company
    from public.clients where name = 'Bank of AJK' limit 1;
  if v_client is null then
    raise notice 'Bank of AJK client not found — skipping';
    return;
  end if;

  -- 1. Default site
  select id into v_site from public.sites where client_id = v_client and is_default limit 1;
  if v_site is null then
    insert into public.sites (company_id, client_id, name, location, is_default)
    values (v_company, v_client, 'Bank of AJK', 'Main branch', true)
    returning id into v_site;
  end if;

  -- 2. Shift definitions (day + night, 12h; night crosses midnight)
  insert into public.shift_definitions
    (company_id, site_id, shift_code, start_time, end_time, duration_hours, crosses_midnight)
  select v_company, v_site, 'day', time '08:00', time '20:00', 12.0, false
  where not exists (select 1 from public.shift_definitions where site_id = v_site and shift_code = 'day');

  insert into public.shift_definitions
    (company_id, site_id, shift_code, start_time, end_time, duration_hours, crosses_midnight)
  select v_company, v_site, 'night', time '20:00', time '08:00', 12.0, true
  where not exists (select 1 from public.shift_definitions where site_id = v_site and shift_code = 'night');

  -- 3. Contract (minimal; contract_code auto via trigger)
  select id into v_contract from public.contracts where client_id = v_client limit 1;
  if v_contract is null then
    insert into public.contracts (company_id, client_id, contract_type, start_date, number_of_guards)
    values (v_company, v_client, 'guard_deployment', current_date, 52)
    returning id into v_contract;
  end if;

  -- 4. GUARD strength line of 52 (the pilot target)
  if not exists (select 1 from public.contract_lines where site_id = v_site and category = 'GUARD') then
    insert into public.contract_lines
      (company_id, contract_id, category, site_id, shift_code, billed_qty, relief_allowance, relief_mode, effective_from)
    values (v_company, v_contract, 'GUARD', v_site, 'day', 52, 0, 'none', current_date);
  end if;
end $$;
