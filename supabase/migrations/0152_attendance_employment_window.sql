-- ---------------------------------------------------------------------------
-- 0152 — Attendance may only be marked inside the employment AND contract window
--
-- Two layers, deliberately:
--   1. attendance_gate() gains the contract window + the separation-date rule,
--      so the UI greys the day out before anyone clicks.
--   2. A BEFORE INSERT/UPDATE trigger on attendance_records enforces the same
--      rules for real. The gate is advisory — several screens (the timesheet's
--      daily marking, "Mark All Present", the bulk-mark calendar) write straight
--      to the table, so the table itself has to be the authority.
--
-- Window rules (all inclusive of the boundary unless stated):
--   • before join_date                      → blocked
--   • on/after termination_date             → blocked  ("the date they were fired")
--   • after last_working_day                → blocked  (the last day worked is
--                                              still markable; the fire flow sets
--                                              termination_date to the same day,
--                                              so a firing does block that date)
--   • lifecycle_state = 'archived'          → blocked
--   • before the assigned contract's start_date, or after its end_date
--     (skipped for open-ended contracts, and for staff with no contract)
--
-- Existing rows are left untouched — this governs new writes only.
-- ---------------------------------------------------------------------------

-- 1. Shared predicate, so the gate and the trigger can never drift apart.
--    Returns null when the date is markable, otherwise the human reason.
create or replace function public.attendance_window_block_reason(
  p_guard uuid,
  p_date  date
) returns text language plpgsql stable security definer set search_path = public as $$
declare
  e public.employees%rowtype;
  c public.contracts%rowtype;
begin
  select * into e from public.employees where id = p_guard;
  if e.id is null then return 'Guard not found'; end if;

  if e.lifecycle_state = 'archived' then
    return 'Record archived';
  end if;
  if e.join_date is not null and p_date < e.join_date then
    return 'Not employed before ' || to_char(e.join_date, 'DD/MM/YYYY');
  end if;
  if e.termination_date is not null and p_date >= e.termination_date then
    return 'Separated on ' || to_char(e.termination_date, 'DD/MM/YYYY')
           || ' — that date and later cannot be marked';
  end if;
  if e.last_working_day is not null and p_date > e.last_working_day then
    return 'Employment ended ' || to_char(e.last_working_day, 'DD/MM/YYYY');
  end if;

  if e.contract_id is not null then
    select * into c from public.contracts where id = e.contract_id;
    if c.id is not null then
      if c.start_date is not null and p_date < c.start_date then
        return 'Contract ' || c.contract_code || ' starts ' || to_char(c.start_date, 'DD/MM/YYYY');
      end if;
      if coalesce(c.is_infinite, false) = false
         and c.end_date is not null and p_date > c.end_date then
        return 'Contract ' || c.contract_code || ' ended ' || to_char(c.end_date, 'DD/MM/YYYY');
      end if;
    end if;
  end if;

  return null;
end $$;

grant execute on function public.attendance_window_block_reason(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. attendance_gate() — same contract as before (jsonb {mode, reason}); the
--    join_date / last_working_day / archived checks are now delegated to the
--    shared predicate, which also adds the contract window and the
--    separation-date rule.
-- ---------------------------------------------------------------------------
create or replace function public.attendance_gate(p_guard uuid, p_date date, p_backdate_limit int default 3)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  e public.employees%rowtype;
  v_reason text;
  v_has_posting boolean;
begin
  select * into e from public.employees where id = p_guard;
  if e.id is null then return jsonb_build_object('mode','blocked','reason','Guard not found'); end if;

  v_reason := public.attendance_window_block_reason(p_guard, p_date);
  if v_reason is not null then
    return jsonb_build_object('mode','blocked','reason',v_reason);
  end if;

  if exists (select 1 from public.accounting_periods ap
             where ap.company_id = e.company_id and ap.period_month = date_trunc('month', p_date)::date) then
    return jsonb_build_object('mode','blocked','reason','Payroll closed for ' || to_char(p_date,'Mon YYYY') || '. Post a reversal instead.');
  end if;
  if p_date < current_date - p_backdate_limit then
    return jsonb_build_object('mode','override_required','reason','Backdated beyond ' || p_backdate_limit || ' days — supervisor override required');
  end if;

  select exists (select 1 from public.deployments d
    where d.guard_id = p_guard and d.start_date <= p_date
      and (d.end_date is null or d.end_date >= p_date)) into v_has_posting;

  if v_has_posting then
    return jsonb_build_object('mode','allowed','reason',null);
  else
    return jsonb_build_object('mode','allowed_unposted','reason','No active posting — recorded against pool (not billable)');
  end if;
end $$;

grant execute on function public.attendance_gate(uuid, date, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The enforcement trigger. Every write path goes through this, including the
--    bulk-mark calendar's upsert.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_attendance_window()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_reason text;
begin
  v_reason := public.attendance_window_block_reason(new.employee_id, new.attendance_date);
  if v_reason is not null then
    raise exception 'Attendance cannot be marked for % : %',
      to_char(new.attendance_date, 'DD/MM/YYYY'), v_reason
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_attendance_window on public.attendance_records;
create trigger trg_attendance_window
  before insert or update of employee_id, attendance_date on public.attendance_records
  for each row execute function public.enforce_attendance_window();
