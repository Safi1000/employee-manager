-- 0131: Fix separations made via the legacy lifecycle-only path + harden rehire.
--
-- Before the badge-fire fix, guards were separated with transition_employee_
-- lifecycle, which set NEITHER last_working_day NOR closed the posting. Those
-- guards therefore (a) still appeared on the attendance roster and (b) blocked
-- rehire, because rehire_guard opened a SECOND active posting and hit
-- deployments_one_active_per_guard. This migration:
--   1. backfills last_working_day / termination_date / exit_date for already-
--      separated guards from their lifecycle-event date (best-effort fallbacks),
--   2. closes their dangling open postings at that date,
--   3. makes rehire_guard defensively close any lingering open posting before
--      opening the new stint, and stamp the new posting's shift_code.
-- Additive / corrective only. No attendance, payroll, or history is deleted.

-- ---------------------------------------------------------------------------
-- 1. Backfill the missing separation dates.
-- ---------------------------------------------------------------------------
update public.employees e
set last_working_day = d.eff,
    termination_date = coalesce(e.termination_date, d.eff),
    exit_date        = coalesce(e.exit_date, d.eff)
from (
  select e2.id,
    coalesce(
      (select max(le.changed_at)::date
         from public.employee_lifecycle_events le
        where le.employee_id = e2.id
          and le.to_state in ('terminated','fired','left','absconded')),
      e2.termination_date, e2.exit_date, e2.updated_at::date, current_date
    ) as eff
  from public.employees e2
  where e2.lifecycle_state in ('terminated','fired','left','absconded')
    and e2.last_working_day is null
) d
where d.id = e.id;

-- ---------------------------------------------------------------------------
-- 2. Close dangling open postings for separated guards at their last working day
--    (never before the posting started).
-- ---------------------------------------------------------------------------
update public.deployments dep
set end_date   = greatest(dep.start_date, e.last_working_day),
    reason     = 'separation',
    updated_at = now()
from public.employees e
where e.id = dep.guard_id
  and dep.end_date is null
  and e.lifecycle_state in ('terminated','fired','left','absconded')
  and e.last_working_day is not null;

-- ---------------------------------------------------------------------------
-- 3. Harden rehire_guard (§9.6): close any lingering open posting before opening
--    the new stint, and carry the guard's shift onto the new posting. Otherwise
--    unchanged (same record, same permanent code, history preserved).
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

  -- Defensive: close any lingering open posting so the new stint is the ONLY
  -- active one (guards separated via legacy paths may still have an open row).
  update public.deployments
     set end_date   = greatest(start_date, p_join_date - 1),
         reason     = 'separation',
         updated_at = now()
   where guard_id = p_guard and end_date is null;

  -- New posting (Phase 4). The sync trigger repoints client_id + clears the
  -- display number so the app can allocate a fresh client-prefixed code.
  insert into public.deployments
    (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason, shift_code)
  values (e.company_id, p_guard, p_client_id, p_contract_line_id, v_site, p_join_date, 'new_hire', e.shift);

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, changed_by, notes)
  values
    (e.company_id, p_guard, e.lifecycle_state, 'active',
     'Rehire (stint #' || (e.rehire_count + 1) || ')', auth.uid(), null);
end $$;

grant execute on function public.rehire_guard(uuid, date, uuid, uuid, uuid) to authenticated;
