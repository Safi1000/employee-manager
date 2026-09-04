-- 0393 — a leave occupies the WHOLE day. It cannot share the day with a worked
--         shift, and it cannot appear on two shifts at once.
--
-- ===========================================================================
-- THE RULE
-- ===========================================================================
--
-- A guard on leave did not stand anywhere that day. So for one (employee, date):
--
--   * at most ONE leave row, and
--   * if there is a leave row, there is NO other row — no P, no A, no DD.
--
-- "Leave" here is every non-worked status the board renders as L: the canonical
-- `leave`, the spec's `rotation_leave`, and `rest_day`. They are the same kind
-- of day and the sheet already collapses them to one symbol (attendanceSheet.ts
-- symbolOf), so the rule has to cover all three or it covers none.
--
-- ===========================================================================
-- WHY IT HAPPENED
-- ===========================================================================
--
-- attendance_records is unique on (employee_id, attendance_date, worked_shift)
-- — migration 0126. Every marking screen upserts on that key. That is CORRECT
-- for double duty, which is genuinely two shifts in one day and needs two rows.
--
-- It is wrong for leave, because leave has no shift. Mark a day Leave while the
-- picker sits on `day`, come back a week later with the picker on `evening`,
-- and the second write does not REPLACE the day — it ADDS a row. The upsert key
-- never collides, nothing raises, and the Monthly Board then renders L in two
-- columns, or L beside a P.
--
-- Note the shape: the defect needs no unusual input. It needs the same day
-- touched twice with the shift chip in a different position, which is the
-- ordinary way a correction gets made. That is why it produced 17 bad days and
-- not one.
--
-- ===========================================================================
-- WHAT WAS FOUND ON PRODUCTION (crm-design), 2026-09-04
-- ===========================================================================
--
-- 38,692 rows / 38,360 employee-days. 3,154 days carry a leave. Of those, 17
-- are broken — 34 rows in two distinct shapes:
--
--   A. 9 days where EVERY row is a leave, on two different shifts.
--      Babar Baig ×4 (day+evening), Israr Hussain ×2, Feroz Khan, Mukhtar
--      Hussain, Rizwan Ahmed (NG) — all day+night.
--
--   B. 8 days where a leave sits beside a worked mark.
--      Basharat Khan ×4 (P on day, L on evening), Nazakat Hussain ×2
--      (L on day, P on night), Muhammad Maskeen (P on day, L on night),
--      Tahir Mehmood (DD on day, L on night).
--
-- Nothing downstream has consumed these figures: prod holds 0 payroll_runs,
-- 0 payslips and 0 accounting_periods. The repair below therefore moves no
-- money and reopens no paid period. It changes what the Monthly Board shows and
-- what the next payroll run will read — which is the point.
--
-- ===========================================================================
-- WHAT IS REPAIRED, AND WHAT IS DELIBERATELY NOT
-- ===========================================================================
--
-- Shape A — REPAIRED, and no figure moves. Both rows say leave, so the day is a
-- leave day on either reading; only the duplicate row is wrong. Keep the
-- earliest marked_at (the original decision), drop the later stamp.
--
-- Shape B — REPAIRED ONLY WHERE THE ROSTER SETTLES IT. If the leave names a
-- shift the guard was NOT rostered on that date, while the worked mark sits on
-- the shift they WERE, the leave is the stray: it claims a shift the guard never
-- stood. Delete it, keep the worked mark. That covers Basharat ×4 and Nazakat
-- ×2 — 6 of the 8. Per-date roster comes from the dated `deployments` segment
-- covering the date, never employees.shift, which is only the CURRENT shift and
-- back-dates a shift change over the whole month (lib/shiftOnDate.ts).
--
-- Shape C — two days the roster could NOT settle, ANSWERED BY SHAYAN
-- (2026-09-04) and repaired to his answer rather than to a rule:
--
--   Muhammad Maskeen  2026-08-18   was P on day + L on night, and night is the
--                                  shift he was rostered on, so neither mark
--                                  could be called the stray.
--                                  ANSWER: he is on LEAVE. Remove the P.
--   Tahir Mehmood     2026-08-24   was DD on day + L on night, and that leave
--                                  was entered as a SUPERVISOR OVERRIDE on
--                                  2026-09-03 — the most recent deliberate act
--                                  on the day, which is why rule B (which never
--                                  touches an override) left it alone.
--                                  ANSWER: he is on LEAVE. Remove the DD.
--
-- Both resolve the same way — drop the worked row, keep the leave — but they are
-- listed and matched by employee_code and date rather than folded into a rule.
-- A rule would claim the roster settles them and it does not; what settles them
-- is that somebody was asked. If either row is not found the migration REFUSES,
-- because a decision applied to nothing is not a decision applied.
--
-- Both sit inside the ONE OPS-verified month on prod (Emaar DHA ISB, 2026-08),
-- which is locked — hence the maintenance session below.
--
-- ===========================================================================
-- WHY A TRIGGER AND NOT A CONSTRAINT
-- ===========================================================================
--
-- The rule spans ROWS — "no sibling row for this day says something else" — so
-- no CHECK can express it, and no UNIQUE index either: 0390 could use a unique
-- partial index because "one cash opening per company" is a uniqueness claim.
-- "A leave excludes its siblings" is not. An EXCLUDE constraint cannot see the
-- other rows' status either.
--
-- It REFUSES rather than quietly deleting the siblings itself. A trigger that
-- tidied up around each write would make a wrong mark look like a right one and
-- destroy the row it removed — this project's recurring failure mode, an
-- unauthorised or mistaken act arriving dressed as success. The screens clear
-- the day explicitly before writing a leave (Expenses-style: the caller does the
-- work, the database refuses the caller who did not).
--
-- Nothing server-side writes attendance_records — every write comes from the
-- three marking screens — so this trigger's blast radius is exactly those, and
-- they are updated in the same change.

-- ---------------------------------------------------------------------------
-- The rule, named once, so the trigger, the repair and the report cannot drift.
-- ---------------------------------------------------------------------------
create or replace function public.attendance_status_is_leave(p_status text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select lower(coalesce(p_status, '')) in ('leave', 'rotation_leave', 'rest_day');
$function$;

comment on function public.attendance_status_is_leave(text) is
  '0393: the three tokens the attendance board renders as L — `leave` (canonical), `rotation_leave` (spec) and `rest_day`. One definition so enforce_leave_is_the_whole_day(), attendance_day_conflicts() and the repair cannot disagree about what a leave is.';

-- ---------------------------------------------------------------------------
-- The report. Every (employee, date) that breaks the rule, with the reason.
-- ---------------------------------------------------------------------------
create or replace function public.attendance_day_conflicts()
returns table (
  employee_id   uuid,
  full_name     text,
  attendance_date date,
  shape         text,
  marks         text
)
language sql
stable
set search_path to 'public'
as $function$
  select r.employee_id,
         e.full_name,
         r.attendance_date,
         case when count(*) filter (where not public.attendance_status_is_leave(r.status)) = 0
              then 'leave on more than one shift'
              else 'leave beside a worked shift' end,
         string_agg(r.worked_shift::text || '=' || r.status, ' | ' order by r.worked_shift::text)
    from public.attendance_records r
    join public.employees e on e.id = r.employee_id
   group by r.employee_id, e.full_name, r.attendance_date
  having count(*) filter (where public.attendance_status_is_leave(r.status)) > 1
      or (count(*) filter (where public.attendance_status_is_leave(r.status)) > 0
      and count(*) filter (where not public.attendance_status_is_leave(r.status)) > 0);
$function$;

comment on function public.attendance_day_conflicts() is
  '0393: employee-days where a leave shares the day with something else — a second leave on another shift, or a P/A/DD. A leave is the whole day, so both are contradictions rather than detail. Zero on prod after 0393, and enforce_leave_is_the_whole_day() keeps it there — this function exists to answer the question for a database that predates that trigger, or after a bulk load that bypassed it.';

grant execute on function public.attendance_day_conflicts() to authenticated;

-- ---------------------------------------------------------------------------
-- THE REPAIR.
--
-- Runs BEFORE the trigger is created — not because the trigger would block it
-- (it fires on insert/update, and this only deletes), but because the trigger's
-- own probe below asserts the state the repair leaves.
--
-- app.ledger_maintenance is the sanctioned bypass for the month locks
-- (is_maintenance_session(), which additionally requires a superuser/bypassrls
-- session). Both affected months have ENDED, so without it
-- enforce_confirmed_month_end_lock refuses every delete of a confirmed shift and
-- the repair silently does nothing. Set local: it dies with the transaction.
-- ---------------------------------------------------------------------------
do $$
declare
  v_before int;
  v_a      int;
  v_b      int;
  v_c      int;
  v_after  int;
  v_left   text;
begin
  if not exists (select 1 from pg_roles
                  where rolname = session_user and (rolsuper or rolbypassrls)) then
    raise exception
      '0393 REFUSED: the repair needs a maintenance session to get past the month locks, and this session is not one.';
  end if;
  perform set_config('app.ledger_maintenance', 'on', true);

  select count(*) into v_before from public.attendance_day_conflicts();
  if v_before = 0 then
    raise notice '0393: no conflicting days — the repair has nothing to do (it is idempotent).';
  end if;

  -- ---- Shape A: every row that day is a leave. Keep the earliest marked_at.
  -- Deterministic tiebreak on id, so a re-run picks the same survivor.
  with conflict as (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) filter (where public.attendance_status_is_leave(status)) > 1
       and count(*) filter (where not public.attendance_status_is_leave(status)) = 0),
  doomed as (
    select r.id
      from conflict c
      join public.attendance_records r
        on r.employee_id = c.employee_id and r.attendance_date = c.attendance_date
     where r.id <> (select r2.id
                      from public.attendance_records r2
                     where r2.employee_id = c.employee_id
                       and r2.attendance_date = c.attendance_date
                     order by r2.marked_at nulls last, r2.id
                     limit 1))
  delete from public.attendance_records a using doomed d where a.id = d.id;
  get diagnostics v_a = row_count;

  -- ---- Shape B: the leave names a shift the guard was not rostered on, and a
  -- worked mark sits on one they were. Never a supervisor override.
  with conflict as (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) filter (where public.attendance_status_is_leave(status)) > 0
       and count(*) filter (where not public.attendance_status_is_leave(status)) > 0),
  rostered as (
    select c.employee_id, c.attendance_date,
           array_agg(distinct coalesce(d.shift_code::text, cl.shift_code::text)) as shifts
      from conflict c
      join public.deployments d
        on d.guard_id = c.employee_id
       and d.start_date <= c.attendance_date
       and (d.end_date is null or d.end_date >= c.attendance_date)
      left join public.contract_lines cl on cl.id = d.contract_line_id
     group by 1, 2),
  doomed as (
    select r.id
      from conflict c
      join rostered ro
        on ro.employee_id = c.employee_id and ro.attendance_date = c.attendance_date
      join public.attendance_records r
        on r.employee_id = c.employee_id and r.attendance_date = c.attendance_date
     where public.attendance_status_is_leave(r.status)
       and not coalesce(r.supervisor_override, false)
       and not (r.worked_shift::text = any(ro.shifts))
       and exists (select 1
                     from public.attendance_records w
                    where w.employee_id = c.employee_id
                      and w.attendance_date = c.attendance_date
                      and not public.attendance_status_is_leave(w.status)
                      and w.worked_shift::text = any(ro.shifts)))
  delete from public.attendance_records a using doomed d where a.id = d.id;
  get diagnostics v_b = row_count;

  -- ---- Shape C: the two the roster could not settle. Both answered LEAVE, so
  -- the worked row goes. Named, not derived — and asserted to have HIT, because
  -- a decision that silently matched nothing is the failure this project keeps
  -- finding: the statement succeeds, the row count is zero, and nobody looks.
  delete from public.attendance_records r
   using public.employees e
   where e.id = r.employee_id
     and not public.attendance_status_is_leave(r.status)
     and ((e.employee_code = 'GGS-00246' and r.attendance_date = date '2026-08-18')
       or (e.employee_code = 'GGS-00018' and r.attendance_date = date '2026-08-24'));
  get diagnostics v_c = row_count;
  if v_before > 0 and v_c <> 2 then
    raise exception
      '0393 REFUSED: the two days Shayan answered matched % row(s), expected 2. The data is not what the decision was made about.', v_c;
  end if;

  select count(*), string_agg(full_name || ' ' || attendance_date, '; ' order by full_name)
    into v_after, v_left
    from public.attendance_day_conflicts();

  raise notice '0393 repair: % conflicting day(s) before; deleted % duplicate-leave, % stray-shift leave, % answered-day row(s); % day(s) left: %',
    v_before, v_a, v_b, v_c, v_after, coalesce(v_left, '(none)');

  -- Every shape is now accounted for, so the only acceptable answer is zero.
  if v_after <> 0 then
    raise exception '0393 FAILED: % day(s) still conflict after the repair: %', v_after, v_left;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE RULE, ENFORCED. Refuses; does not tidy.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_leave_is_the_whole_day()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_other text;
begin
  if public.attendance_status_is_leave(NEW.status) then
    -- A leave admits no company. Any sibling row on the same day contradicts it,
    -- including another leave: leave has no shift, so a second one is a
    -- duplicate of the same day and not a second fact about it.
    select string_agg(r.worked_shift::text || '=' || r.status, ', ' order by r.worked_shift::text)
      into v_other
      from public.attendance_records r
     where r.employee_id = NEW.employee_id
       and r.attendance_date = NEW.attendance_date
       and r.id is distinct from NEW.id;
    if v_other is not null then
      raise exception
        'A leave covers the whole day, so it cannot be recorded next to another shift. % already has % on %. Clear the day first, then mark it Leave.',
        (select full_name from public.employees where id = NEW.employee_id),
        v_other, NEW.attendance_date
        using errcode = '23514',
              hint = 'Use Clear (unmark) on that date, then mark Leave — marking Leave over a shift is the same day being described two ways.';
    end if;
  else
    -- The other direction, and it is not the same statement: a worked mark
    -- arriving onto a day already marked leave. Double duty legitimately writes
    -- two worked rows, so only a LEAVE sibling is refused here.
    select string_agg(r.worked_shift::text || '=' || r.status, ', ' order by r.worked_shift::text)
      into v_other
      from public.attendance_records r
     where r.employee_id = NEW.employee_id
       and r.attendance_date = NEW.attendance_date
       and r.id is distinct from NEW.id
       and public.attendance_status_is_leave(r.status);
    if v_other is not null then
      raise exception
        'That day is already recorded as leave (%), and a leave covers the whole day. Clear the day first if % actually worked it.',
        v_other,
        (select full_name from public.employees where id = NEW.employee_id)
        using errcode = '23514',
              hint = 'Use Clear (unmark) on that date, then mark the shift worked.';
    end if;
  end if;
  return NEW;
end;
$function$;

comment on function public.enforce_leave_is_the_whole_day() is
  '0393: a leave (leave / rotation_leave / rest_day) is the whole day, so it may not share an (employee, date) with any other attendance row — not a P, not an A, not a DD, and not a second leave on another shift. attendance_records is unique on (employee_id, attendance_date, worked_shift), which is right for double duty and wrong for leave: re-marking a leave day with the shift picker on a different chip ADDED a row instead of replacing the day, and produced 17 broken days before this existed. Refuses rather than deleting the siblings itself — a trigger that tidied up would make a mistaken mark look like a correct one and take the evidence with it. Callers clear the day first.';

drop trigger if exists trg_leave_is_the_whole_day on public.attendance_records;
create trigger trg_leave_is_the_whole_day
  before insert or update on public.attendance_records
  for each row
  execute function public.enforce_leave_is_the_whole_day();

-- ---------------------------------------------------------------------------
-- PROVE IT, against a real guard, rolled back.
--
-- Four arms, and each refusal is asserted ON ITS MESSAGE. "Something raised"
-- would pass here against the month lock, the window trigger, the reliever
-- trigger or a not-null violation — this table carries nine other BEFORE
-- triggers, which is exactly the situation that makes a bare `when others` test
-- worthless.
-- ---------------------------------------------------------------------------
do $$
declare
  v_emp   uuid;
  v_co    uuid;
  v_date  date;
  v_n     int;
begin
  perform set_config('app.ledger_maintenance', 'on', true);

  -- A guard with a real posting, and a date inside a month that has not ended,
  -- so the confirmed/month-end locks are not what is being measured.
  select e.id, e.company_id into v_emp, v_co
    from public.employees e
   where e.lifecycle_state <> 'archived'
     and exists (select 1 from public.deployments d where d.guard_id = e.id)
   order by e.created_at
   limit 1;
  if v_emp is null then
    raise exception '0393 FAILED: no deployed employee to probe against.';
  end if;
  v_date := date_trunc('month', current_date)::date + 1;

  delete from public.attendance_records
   where employee_id = v_emp and attendance_date = v_date;

  -- 1. A leave lands on an empty day. This must WORK — a trigger that refused
  --    everything would pass every arm below.
  insert into public.attendance_records
    (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source)
  values (v_co, v_emp, v_date, 'leave', 'day', 'day', 'manual');

  -- 2. A second leave on ANOTHER shift — the shape that made 9 of the 17.
  begin
    insert into public.attendance_records
      (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source)
    values (v_co, v_emp, v_date, 'leave', 'night', 'night', 'manual');
    raise exception '0393 FAILED: a second leave was accepted on another shift.';
  exception when others then
    if sqlerrm not like '%covers the whole day%' then
      raise exception '0393 FAILED: the duplicate leave raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;

  -- 3. A worked mark onto a day already on leave — the other 8.
  begin
    insert into public.attendance_records
      (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source)
    values (v_co, v_emp, v_date, 'present', 'night', 'night', 'manual');
    raise exception '0393 FAILED: a present was accepted on a leave day.';
  exception when others then
    if sqlerrm not like '%already recorded as leave%' then
      raise exception '0393 FAILED: the present-on-leave raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;

  -- 4. Clear the day, and BOTH now go in — including two worked shifts, because
  --    double duty is a real two-row day and must survive this trigger. If it
  --    did not, the rule would have been written as "one row per day", which is
  --    a different and wrong rule.
  delete from public.attendance_records
   where employee_id = v_emp and attendance_date = v_date;
  insert into public.attendance_records
    (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source, entry_type)
  values (v_co, v_emp, v_date, 'present', 'day', 'day', 'manual', 'normal'),
         (v_co, v_emp, v_date, 'double_duty', 'night', 'day', 'manual', 'double_duty');
  select count(*) into v_n from public.attendance_records
   where employee_id = v_emp and attendance_date = v_date;
  if v_n <> 2 then
    raise exception '0393 FAILED: double duty left % row(s), expected 2. The trigger is too wide.', v_n;
  end if;

  -- 5. And an UPDATE is covered, not only an INSERT. Turning one of those two
  --    worked rows into a leave is the same contradiction arriving by another
  --    verb, and 0224b/0231b are this project's reminder that a guard tests the
  --    statement it names and nothing else.
  begin
    update public.attendance_records
       set status = 'leave'
     where employee_id = v_emp and attendance_date = v_date and worked_shift::text = 'night';
    raise exception '0393 FAILED: an UPDATE turned one shift of a two-shift day into a leave.';
  exception when others then
    if sqlerrm not like '%covers the whole day%' then
      raise exception '0393 FAILED: the update-to-leave raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;

  raise exception
    'ROLLBACK_PROBE 0393 OK: leave is exclusive on insert and on update, both directions refused by message, and double duty still writes its two rows.';
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
    raise exception '0393 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
