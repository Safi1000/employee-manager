-- 0396 — a day carries ONE status. Present, Absent or Leave is one row; a
--         double duty is two rows and both say `double_duty`. Nothing else.
--
-- ===========================================================================
-- THE RULE, WHICH IS NOW SHORT ENOUGH TO STATE IN ONE LINE
-- ===========================================================================
--
--     Exactly one row per (employee, date) — unless the status is
--     `double_duty`, in which case exactly two.
--
-- 0393 said a leave cannot share its day. 0395 said a double duty is exactly
-- two rows both marked DD. This generalises both: a day answers ONE question,
-- "what happened", and the only answer that needs two rows is the one that
-- means two shifts.
--
-- Those two triggers stay. They are not redundant — each explains the specific
-- thing it refuses, and "a leave covers the whole day" tells the operator
-- something that "a day has one status" does not. This one catches what neither
-- names: two DIFFERENT worked statuses, or the same non-DD status twice.
--
-- ===========================================================================
-- THE SIX DAYS ON PRODUCTION
-- ===========================================================================
--
-- Every other day already complies — 38,070 single-status days and 284 proper
-- double duties. Six do not, and both shapes come from the same cause:
--
--   FIVE   Basharat Khan (HMC-074), 3/4/11/12/13 August
--          day=present(s:day) | evening=absent(s:evening)
--
--   ONE    Babar Baig (HMC-049), 2 August
--          day=absent(s:day) | evening=absent(s:evening)
--
-- Both men hold TWO CONCURRENT POSTINGS — one on days, one on evenings — so
-- the board offered them on two rosters and each roster was confirmed
-- separately. Two independent confirmations, two rows, and nothing in between
-- to notice the day now said two things.
--
-- (This is also the mechanism behind the very first defect in this sequence:
-- Babar Baig's leave was written twice, once under each of his shifts, which is
-- what 0393 repaired. Same guard, same cause, different symptom.)
--
-- ===========================================================================
-- HOW THEY ARE RESOLVED, AND WHY THAT WAY
-- ===========================================================================
--
-- BABAR BAIG — unambiguous. Both rows say `absent`; the day is an absence
-- however it is folded. Keep the earlier `marked_at`, drop the duplicate. No
-- figure moves.
--
-- BASHARAT KHAN — a judgement, and it is stated rather than hidden. He was
-- PRESENT on his day posting and ABSENT on his evening one. One status has to
-- survive, and it is the PRESENT:
--
--   * He demonstrably worked a shift. Recording the day as an absence would
--     deny pay for work actually done, and an attendance system that can do
--     that by tidying up is worse than one with a contradiction in it.
--   * The reverse error is milder and visible elsewhere: the missed evening
--     shift is a STAFFING fact — the client had a post uncovered — and that is
--     what the shift roster and the strength reports are for. It is not a claim
--     that this guard did nothing that day.
--
-- If Shayan wants these five as absences instead, the five rows are named in
-- the notice this migration raises and the change is one statement.
--
-- Prod holds 0 payroll_runs, 0 payslips and 0 accounting_periods, so nothing
-- disbursed moves either way.
--
-- ===========================================================================
-- WHAT CHANGED ON THE SCREEN, IN THE SAME BREATH
-- ===========================================================================
--
-- The Bulk Mark calendar no longer shows D / N / E chips. The shift a mark
-- lands on is now derived from the guard's dated deployment segment, and a
-- double duty takes the rostered shift plus the client's other one.
--
-- That control was the source of the three worst defects in this sequence: a
-- leave written under a different chip on a second visit (17 broken days,
-- 0393), the [rostered, cover] pair re-sorted into site order so the wrong row
-- was marked the cover (33 inverted days, 0394), and a third shift being
-- tappable at all (25 impossible days, 0395). The roster already knew the
-- answer every time it was asked.

-- ---------------------------------------------------------------------------
-- THE REPAIR.
-- ---------------------------------------------------------------------------
do $$
declare
  v_before int;
  v_dup    int;
  v_mixed  int;
  v_list   text;
  v_bad    int;
begin
  if not exists (select 1 from pg_roles
                  where rolname = session_user and (rolsuper or rolbypassrls)) then
    raise exception
      '0396 REFUSED: the repair needs a maintenance session to get past the month locks, and this session is not one.';
  end if;
  perform set_config('app.ledger_maintenance', 'on', true);

  select count(*) into v_before from (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) > 1
       and not (count(*) = 2 and count(*) filter (where status = 'double_duty') = 2)) b;

  -- ---- Same status twice: keep the earliest marked_at, drop the rest.
  with dupes as (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) > 1
       and count(distinct status) = 1
       and count(*) filter (where status = 'double_duty') = 0),
  doomed as (
    select r.id
      from dupes d
      join public.attendance_records r
        on r.employee_id = d.employee_id and r.attendance_date = d.attendance_date
     where r.id <> (select r2.id
                      from public.attendance_records r2
                     where r2.employee_id = d.employee_id
                       and r2.attendance_date = d.attendance_date
                     order by r2.marked_at nulls last, r2.id
                     limit 1))
  delete from public.attendance_records a using doomed x where a.id = x.id;
  get diagnostics v_dup = row_count;

  -- ---- Two different statuses: the WORKED row survives. Named in the notice.
  with mixed as (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) > 1
       and count(distinct status) > 1
       and count(*) filter (where status = 'present') > 0)
  select string_agg(e.full_name || ' ' || r.attendance_date || ' ' || r.worked_shift::text || '=' || r.status,
                    '; ' order by e.full_name, r.attendance_date)
    into v_list
    from mixed m
    join public.attendance_records r
      on r.employee_id = m.employee_id and r.attendance_date = m.attendance_date
    join public.employees e on e.id = r.employee_id
   where r.status <> 'present';

  with mixed as (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) > 1
       and count(distinct status) > 1
       and count(*) filter (where status = 'present') > 0)
  delete from public.attendance_records r
   using mixed m
   where r.employee_id = m.employee_id
     and r.attendance_date = m.attendance_date
     and r.status <> 'present';
  get diagnostics v_mixed = row_count;

  raise notice
    '0396 repair: % contradicting day(s); dropped % duplicate row(s) and % non-worked row(s) beside a present: %',
    v_before, v_dup, v_mixed, coalesce(v_list, '(none)');

  select count(*) into v_bad from (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) > 1
       and not (count(*) = 2 and count(*) filter (where status = 'double_duty') = 2)) x;
  if v_bad <> 0 then
    raise exception
      '0396 REFUSED: % day(s) would still carry more than one status. The constraint is not installed.', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE RULE, ENFORCED. Deferred, for the reason 0395 gives: the board writes a
-- double duty as two rows and the day is legitimately half-written in between.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_one_status_per_day()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_emp   uuid;
  v_date  date;
  v_rows  int;
  v_dd    int;
  v_kinds int;
  v_shape text;
  v_name  text;
begin
  if TG_OP = 'DELETE' then
    v_emp := OLD.employee_id; v_date := OLD.attendance_date;
  else
    v_emp := NEW.employee_id; v_date := NEW.attendance_date;
  end if;

  select count(*), count(*) filter (where status = 'double_duty'), count(distinct status),
         string_agg(worked_shift::text || '=' || status, ', ' order by worked_shift::text)
    into v_rows, v_dd, v_kinds, v_shape
    from public.attendance_records
   where employee_id = v_emp and attendance_date = v_date;

  -- Nothing left on the day, or a single row: both are fine, and the single-row
  -- case is the overwhelming majority, so it returns before any further work.
  if v_rows <= 1 then
    return null;
  end if;
  -- The one legal multi-row day.
  if v_rows = 2 and v_dd = 2 then
    return null;
  end if;

  select full_name into v_name from public.employees where id = v_emp;

  if v_kinds > 1 then
    raise exception
      'A day records one thing: % is marked % on %. Present, Absent and Leave cannot share a day.',
      coalesce(v_name, 'this guard'), v_shape, v_date
      using errcode = '23514',
            hint = 'Clear the day and mark it once. If the guard worked two shifts, mark it Double Duty.';
  end if;

  raise exception
    'A day records one thing, and only a double duty takes two rows: % is marked % on %.',
    coalesce(v_name, 'this guard'), v_shape, v_date
    using errcode = '23514',
          hint = 'Clear the day and mark it once — the same status twice is the same day recorded twice.';
end;
$function$;

comment on function public.enforce_one_status_per_day() is
  '0396: exactly one attendance row per (employee, date), unless the status is double_duty, in which case exactly two. Generalises 0393 (a leave cannot share its day) and 0395 (a double duty is two rows both marked DD), and catches what neither names: two different worked statuses on one day, or the same non-DD status recorded twice. Both shapes came from guards holding two concurrent postings, whose two rosters were confirmed separately with nothing in between to notice the day now said two things. Deferred to COMMIT because a double duty is legitimately half-written between its two rows.';

drop trigger if exists trg_one_status_per_day on public.attendance_records;
create constraint trigger trg_one_status_per_day
  after insert or update or delete on public.attendance_records
  deferrable initially deferred
  for each row
  execute function public.enforce_one_status_per_day();

-- ---------------------------------------------------------------------------
-- PROVE IT.
-- ---------------------------------------------------------------------------
do $$
declare
  v_emp uuid; v_co uuid; v_date date; v_n int; v_left int;
begin
  perform set_config('app.ledger_maintenance', 'on', true);

  select count(*) into v_left from (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) > 1
       and not (count(*) = 2 and count(*) filter (where status = 'double_duty') = 2)) x;
  if v_left <> 0 then
    raise exception '0396 FAILED: % day(s) still carry more than one status.', v_left;
  end if;

  select e.id, e.company_id into v_emp, v_co
    from public.employees e
   where e.lifecycle_state <> 'archived'
     and exists (select 1 from public.deployments d where d.guard_id = e.id)
   order by e.created_at limit 1;
  if v_emp is null then raise exception '0396 FAILED: no deployed employee to probe against.'; end if;
  v_date := date_trunc('month', current_date)::date + 4;
  delete from public.attendance_records where employee_id = v_emp and attendance_date = v_date;

  -- 1. A double duty still writes, across two statements. Same deferral test as
  --    0395: this is the arm a row-level trigger would have broken.
  insert into public.attendance_records
    (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source, entry_type)
  values (v_co, v_emp, v_date, 'double_duty', 'night', 'night', 'manual', 'double_duty');
  insert into public.attendance_records
    (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source, entry_type)
  values (v_co, v_emp, v_date, 'double_duty', 'day', 'night', 'manual', 'double_duty');
  set constraints public.trg_one_status_per_day immediate;
  select count(*) into v_n from public.attendance_records
   where employee_id = v_emp and attendance_date = v_date;
  if v_n <> 2 then raise exception '0396 FAILED: a double duty left % row(s).', v_n; end if;
  delete from public.attendance_records where employee_id = v_emp and attendance_date = v_date;

  -- 2. Present on one shift, Absent on another — Basharat Khan's five days.
  begin
    insert into public.attendance_records
      (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source)
    values (v_co, v_emp, v_date, 'present', 'day', 'day', 'manual'),
           (v_co, v_emp, v_date, 'absent', 'night', 'night', 'manual');
    set constraints public.trg_one_status_per_day immediate;
    raise exception '0396 FAILED: a present and an absent were accepted on one day.';
  exception when others then
    if sqlerrm not like '%A day records one thing%' then
      raise exception '0396 FAILED: the mixed day raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;
  delete from public.attendance_records where employee_id = v_emp and attendance_date = v_date;

  -- 3. The SAME status twice — Babar Baig's day.
  begin
    insert into public.attendance_records
      (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source)
    values (v_co, v_emp, v_date, 'absent', 'day', 'day', 'manual'),
           (v_co, v_emp, v_date, 'absent', 'night', 'night', 'manual');
    set constraints public.trg_one_status_per_day immediate;
    raise exception '0396 FAILED: the same status was accepted twice on one day.';
  exception when others then
    if sqlerrm not like '%only a double duty takes two rows%' then
      raise exception '0396 FAILED: the duplicate status raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;
  delete from public.attendance_records where employee_id = v_emp and attendance_date = v_date;

  -- 4. And the ordinary case is untouched.
  insert into public.attendance_records
    (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source)
  values (v_co, v_emp, v_date, 'present', 'night', 'night', 'manual');
  set constraints public.trg_one_status_per_day immediate;

  raise exception
    'ROLLBACK_PROBE 0396 OK: one status per day enforced; a double duty still writes across two statements, and a mixed day and a doubled status are each refused by message.';
exception when others then
  if sqlerrm not like 'ROLLBACK_PROBE%' then raise; end if;
  raise notice '%', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0396 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
