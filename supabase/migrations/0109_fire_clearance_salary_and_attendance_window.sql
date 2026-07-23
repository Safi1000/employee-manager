-- Fire flow + attendance window enforcement (this iteration's requests).
--
-- Two independent pieces:
--
-- 1. Exit clearance also surfaces UNDISBURSED SALARY. The "Fire" popup and the
--    Lifecycle & Compliance panel must show every kind of outstanding due:
--    advances, salary not yet disbursed, unreturned kit, and open incidents.
--    The first three of those already existed as clearance gates; salary was
--    the missing one. It is added as an informational figure (it does not
--    change what counts as "cleared" — final-dues release still gates on kit,
--    advance and incidents, exactly as before).
--
-- 2. Attendance can only be marked inside a guard's real service window:
--       lower bound = latest of (join date, contract start)
--       upper bound = earliest of (contract end, fire/exit date)
--    Marking outside that window is rejected for EVERYONE, permission or not —
--    it is a data-integrity bound, not a convenience lock. Separately, marking
--    a day older than the backfill cutoff now requires the new
--    `attendance.backdate` permission (replacing the old free-text reason gate).

-- ===========================================================================
-- 1. Undisbursed salary as a clearance figure.
-- ===========================================================================

alter table public.clearance_certificates
  add column if not exists undisbursed_salary numeric(16,2);

-- Recreate the gates function with the extra column. (A returns-table signature
-- can't be changed by CREATE OR REPLACE, so drop first.)
drop function if exists public.employee_clearance_gates(uuid);
create function public.employee_clearance_gates(p_employee_id uuid)
returns table (
  outstanding_kit_count integer,
  outstanding_advance   numeric,
  open_incident_count   integer,
  undisbursed_salary    numeric
) language sql stable security definer set search_path = public as $$
  select
    (select count(*)::integer from public.issuances i
      where i.employee_id = p_employee_id and i.return_date is null),
    (select coalesce(sum(a.amount), 0) from public.advances a where a.employee_id = p_employee_id)
      - (select coalesce(sum(p.advance), 0) from public.payslips p where p.employee_id = p_employee_id),
    (select count(*)::integer
       from public.incident_guards ig
       join public.incidents inc on inc.id = ig.incident_id
      where ig.employee_id = p_employee_id and inc.status <> 'closed'),
    -- Money we still owe the guard: net salary on payslips not yet disbursed.
    (select coalesce(sum(p.net_salary), 0) from public.payslips p
      where p.employee_id = p_employee_id and not p.disbursed);
$$;

-- assess_clearance snapshots the new figure too. "Cleared" is deliberately left
-- unchanged (kit + advance + incidents) so the existing final-dues gate keeps
-- its exact meaning; undisbursed salary is shown, not enforced here.
create or replace function public.assess_clearance(p_employee_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  g        record;
  v_id     uuid;
  v_ok     boolean;
  v_company uuid;
begin
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  select * into g from public.employee_clearance_gates(p_employee_id);
  v_ok := g.outstanding_kit_count = 0 and g.outstanding_advance <= 0 and g.open_incident_count = 0;

  select id into v_id from public.clearance_certificates
   where employee_id = p_employee_id and not dues_released
   order by created_at desc limit 1;

  if v_id is null then
    insert into public.clearance_certificates (company_id, employee_id)
    values (v_company, p_employee_id) returning id into v_id;
  end if;

  update public.clearance_certificates set
    kit_returned          = (g.outstanding_kit_count = 0),
    outstanding_kit_count = g.outstanding_kit_count,
    advance_settled       = (g.outstanding_advance <= 0),
    outstanding_advance   = g.outstanding_advance,
    incidents_reviewed    = (g.open_incident_count = 0),
    open_incident_count   = g.open_incident_count,
    undisbursed_salary    = g.undisbursed_salary,
    status                = (case when v_ok then 'cleared' else 'blocked' end)::public.clearance_status,
    cleared_by            = case when v_ok then auth.uid() else cleared_by end,
    updated_at            = now()
  where id = v_id;

  return v_id;
end;
$$;

-- ===========================================================================
-- 2. Attendance service-window + backdate-permission enforcement.
--    Replaces the 0108 reason-based backfill trigger.
-- ===========================================================================

create or replace function public.enforce_attendance_backfill()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  e  record;
  lb date;  -- lower bound of the allowed window (inclusive)
  ub date;  -- upper bound of the allowed window (inclusive)
begin
  -- An UPDATE that doesn't change the status isn't a (re)mark; let it pass.
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  -- Pull the guard's service window: join/exit dates and (if assigned) the
  -- contract's start/end. GREATEST/LEAST ignore NULLs, so a missing contract
  -- or open-ended date simply drops out of the bound.
  select em.join_date, em.exit_date, c.start_date as c_start, c.end_date as c_end
    into e
    from public.employees em
    left join public.contracts c on c.id = em.contract_id
   where em.id = new.employee_id;

  lb := greatest(e.join_date, e.c_start);
  ub := least(e.c_end, e.exit_date);

  -- Hard bounds — enforced for everyone, backdate permission or not.
  if lb is not null and new.attendance_date < lb then
    raise exception
      'attendance for % is before this guard''s service window (starts %)', new.attendance_date, lb
      using errcode = '23514';
  end if;
  if ub is not null and new.attendance_date > ub then
    raise exception
      'attendance for % is after this guard''s service window (ends %)', new.attendance_date, ub
      using errcode = '23514';
  end if;

  -- Bulk historical import can still bypass the recency cutoff.
  if coalesce(current_setting('app.skip_attendance_lock', true), '') = '1' then
    return new;
  end if;

  -- Backdating past the cutoff needs the Backdate Attendance permission.
  if public.is_attendance_locked(new.company_id, new.attendance_date)
     and not public.has_perm('attendance.backdate') then
    raise exception
      'backdating attendance to % requires the Backdate Attendance permission', new.attendance_date
      using errcode = '23514';
  end if;

  return new;
end;
$$;
