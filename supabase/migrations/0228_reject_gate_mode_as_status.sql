-- 0228 — `blocked` is a gate refusal, not an attendance status. Refuse it.
--
-- `attendance_gate(guard, date)` returns a MODE describing whether a mark is
-- permitted: allowed / allowed_unposted / override_required / blocked. The UI is
-- supposed to act on that mode. At some point it wrote the mode into
-- `attendance_records.status` instead, and because 0127's CHECK constraint
-- listed 'blocked' as a legal status, the database accepted it.
--
-- Two defects stacked: one that wrote the wrong value, one that permitted it.
-- This closes the second, which is the one that can be closed unilaterally.
--
-- The residue: 24 rows, all one guard (GGS-00408, live org), consecutive days
-- 2026-07-01..07-24, `marked_by_user_id` null on every one — nobody entered
-- them. The gate for that guard/date still answers today:
--     {"mode": "blocked", "reason": "Not employed before 01/08/2026"}
--
-- Those 24 rows are deliberately NOT reclassified here. The same guard has 115
-- `present` rows going back to 2026-04-01, also before his 2026-08-01 join date,
-- so either the join date is wrong or four months of attendance is. Picking a
-- status now would bury that question. It needs a human answer first.
--
-- Both current writers (AttendanceBoard, BulkMarkByEmployeeModal) already
-- refuse a blocked day and neither offers `blocked` in its picker, so this
-- guards against regression rather than fixing a live leak. It is in the table
-- because the table is the only place every writer passes through — several
-- screens write to attendance_records directly, which is the same reasoning
-- 0152 gave for enforcing the attendance window with a trigger rather than
-- trusting the gate.

create or replace function public.reject_gate_mode_as_status()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Maintenance sessions may touch the legacy rows (that is how they will
  -- eventually be reclassified).
  if public.is_maintenance_session() then
    return new;
  end if;

  -- Only refuse status being SET to 'blocked'. An update that moves a legacy row
  -- AWAY from 'blocked' is exactly what the eventual cleanup does, and an update
  -- to some other column on such a row is not this trigger's business.
  if new.status = 'blocked'
     and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    raise exception
      '"blocked" is a gate refusal, not an attendance status — act on attendance_gate()''s mode instead of recording it'
      using errcode = '23514',
            hint = 'attendance_gate() returns allowed / allowed_unposted / override_required / blocked. A blocked day must not be marked at all.';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_reject_gate_mode_as_status on public.attendance_records;
create trigger trg_reject_gate_mode_as_status
  before insert or update on public.attendance_records
  for each row execute function public.reject_gate_mode_as_status();

comment on function public.reject_gate_mode_as_status() is
  'Refuses attendance_records.status = ''blocked'' — a gate mode that leaked into the status vocabulary. Existing legacy rows are tolerated so they can be reclassified once the underlying join-date discrepancy is resolved.';

-- Names the residue so it does not get forgotten once the join-date question is
-- answered. Deliberately not a ledger_checks entry: this is an operational
-- data-quality issue, not an accounting identity.
create or replace function public.attendance_gate_mode_residue(p_company_id uuid)
returns table(employee_id uuid, full_name text, guard_code text,
              rows bigint, first_day date, last_day date, join_date date)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select e.id, e.full_name, e.guard_code, count(*),
         min(a.attendance_date), max(a.attendance_date), e.join_date
    from public.attendance_records a
    join public.employees e on e.id = a.employee_id
   where a.company_id = p_company_id and a.status = 'blocked'
   group by e.id, e.full_name, e.guard_code, e.join_date
   order by count(*) desc;
$function$;

comment on function public.attendance_gate_mode_residue(uuid) is
  'Attendance rows still carrying the leaked gate mode "blocked". Each needs reclassifying to what the guard was actually doing — see 0228.';
