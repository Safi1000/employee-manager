-- 0128: Phase 7 — separation protocol + rehire (§9).
--
-- Integrates the Phase-3 separation fields, Phase-4 deployments close, and
-- lifecycle move into one atomic action, and adds a rehire that relinks to the
-- SAME record (permanent guard_code + history preserved). Additive; the existing
-- transition_employee_lifecycle / assess_clearance / clearance_certificates are
-- left intact.
--
-- ASSUMPTIONS (noted): reuses the existing separation_reason enum, mapped to
-- lifecycle_state as absconded→absconded, termination_*→fired, else→left.
-- NOTHING is deleted on separation (§9.5): postings/attendance/payroll/docs/
-- warnings/service-log all persist; the guard only leaves rosters via the window.

-- ---------------------------------------------------------------------------
-- 1. record_separation() — the single separation action.
--    Sets the two distinct dates + reason + rehire flag, closes the ACTIVE
--    posting (end_date = last_working_day, reason 'separation' — never edited in
--    place), moves lifecycle_state, and logs to the service log. The Phase-6
--    vacancy trigger fires on the posting close.
-- ---------------------------------------------------------------------------
create or replace function public.record_separation(
  p_guard            uuid,
  p_reason           separation_reason,
  p_last_working_day date,
  p_termination_date date,
  p_rehire_eligible  boolean,
  p_note             text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  e public.employees%rowtype;
  v_new_state employee_lifecycle_state;
begin
  select * into e from public.employees where id = p_guard for update;
  if e.id is null then raise exception 'Guard % not found', p_guard; end if;
  if p_last_working_day is null then raise exception 'Last working day is required'; end if;
  if coalesce(trim(p_note),'') = '' then raise exception 'A separation reason/note is required'; end if;

  v_new_state := case
    when p_reason = 'absconded' then 'absconded'
    when p_reason in ('termination_misconduct','termination_performance') then 'fired'
    else 'left'
  end::employee_lifecycle_state;

  update public.employees set
    separation_reason   = p_reason,
    last_working_day    = p_last_working_day,
    termination_date    = p_termination_date,
    eligible_for_rehire = p_rehire_eligible,
    exit_reason         = p_note,
    exit_date           = coalesce(p_termination_date, p_last_working_day),
    lifecycle_state     = v_new_state,
    updated_at          = now()
  where id = p_guard;

  -- Close the active posting (Phase 4: close the row, never edit in place).
  update public.deployments
     set end_date = p_last_working_day, reason = 'separation', updated_at = now()
   where guard_id = p_guard and end_date is null;

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, eligible_for_rehire, changed_by, notes)
  values
    (e.company_id, p_guard, e.lifecycle_state, v_new_state,
     'Separation: ' || p_reason::text, p_rehire_eligible, auth.uid(), p_note);
end $$;

grant execute on function public.record_separation(uuid, separation_reason, date, date, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. rehire_guard() — relinks to the SAME record (§9.6).
--    Same permanent guard_code + history; reopens the employment window
--    (clears last_working_day/termination_date/separation_reason), sets active,
--    increments rehire_count, and opens a NEW posting from the rehire date.
--    Blocked when eligible_for_rehire is false or the guard is blacklisted.
-- ---------------------------------------------------------------------------
create or replace function public.rehire_guard(
  p_guard            uuid,
  p_join_date        date,
  p_client_id        uuid,
  p_contract_line_id uuid default null,
  p_site_id          uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  e public.employees%rowtype;
  v_site uuid;
begin
  select * into e from public.employees where id = p_guard for update;
  if e.id is null then raise exception 'Guard % not found', p_guard; end if;
  if e.eligible_for_rehire is false then
    raise exception 'Guard is not eligible for rehire (marked at last separation)';
  end if;
  if e.blacklisted then
    raise exception 'Guard is blacklisted and cannot be rehired';
  end if;

  v_site := coalesce(p_site_id, (select id from public.sites where client_id = p_client_id and is_default limit 1));

  update public.employees set
    lifecycle_state   = 'active',
    last_working_day  = null,
    termination_date  = null,
    separation_reason = null,
    exit_date         = null,
    exit_reason       = null,
    rehire_count      = rehire_count + 1,
    updated_at        = now()
  where id = p_guard;

  -- New posting (Phase 4). The sync trigger repoints client_id + clears the
  -- display number so the app can allocate a fresh client-prefixed code.
  insert into public.deployments
    (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason)
  values (e.company_id, p_guard, p_client_id, p_contract_line_id, v_site, p_join_date, 'new_hire');

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, changed_by, notes)
  values
    (e.company_id, p_guard, e.lifecycle_state, 'active',
     'Rehire (stint #' || (e.rehire_count + 1) || ')', auth.uid(), null);
end $$;

grant execute on function public.rehire_guard(uuid, date, uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. log_clearance_issued() — §9.3: issuing the clearance is logged to the
--    service log (the clearance itself lives in clearance_certificates).
-- ---------------------------------------------------------------------------
create or replace function public.log_clearance_issued(p_guard uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_state employee_lifecycle_state;
begin
  select company_id, lifecycle_state into v_company, v_state from public.employees where id = p_guard;
  if v_company is null then raise exception 'Guard % not found', p_guard; end if;
  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, changed_by, notes)
  values (v_company, p_guard, v_state, v_state, 'Exit clearance issued', auth.uid(), p_note);
end $$;

grant execute on function public.log_clearance_issued(uuid, text) to authenticated;
