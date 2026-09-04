-- 0394 — a double duty is ONE rostered shift worked, plus every extra shift
--         beside it. The extras are what carry `double_duty`, and nothing else
--         on that day may say present, absent or leave.
--
-- ===========================================================================
-- THE ENCODING, WHICH ALREADY EXISTED AND WAS NOT ENFORCED ANYWHERE
-- ===========================================================================
--
-- A double-duty day is several rows, one per shift stood, and the Attendance
-- board decides which is which by ONE test:
--
--     isExtraDuty = worked_shift <> scheduled_shift
--
-- So a well-formed day is exactly:
--
--     the BASE row   worked_shift =  scheduled_shift   status = present
--     each EXTRA row worked_shift <> scheduled_shift   status = double_duty
--
-- Every row already carries `scheduled_shift`, on all 38,692 of them — there
-- is not one null. The daily board therefore always recorded enough to say
-- which shift a guard was rostered to and which he picked up on top. Nothing
-- ever checked that the statuses agreed with it.
--
-- ===========================================================================
-- TWO DEFECTS, FOUND BY ASKING THE DAILY BOARD
-- ===========================================================================
--
-- 1. TWENTY-FIVE DAYS WITH NO DOUBLE DUTY AT ALL.
--
--    day=present(sched night) | night=present(sched night)
--
--    The guard stood his night shift and covered a day shift, and both rows
--    say `present`. Two shifts worked, nothing marked double duty, so the
--    month counted one present and no extra duty. Whatever a double duty is
--    worth, these guards were not credited with it.
--
-- 2. THIRTY-THREE DAYS WITH THE DOUBLE DUTY ON THE WRONG SHIFT.
--
--    day=present(sched night) | night=double_duty(sched night)
--
--    Read that against the encoding: the row marked `double_duty` is the one
--    the guard was ROSTERED to, and the cover shift is the plain present. It is
--    inside out.
--
--    The cause is in BulkMarkByEmployeeModal and is worth naming, because it is
--    the shape of bug this file keeps meeting. The picker held the two shifts
--    as [rostered, cover] — order carrying the meaning — and then stored them
--    with `siteShifts.filter(c => chosen.includes(c))`, which rebuilds the
--    array in the SITE's shift order. For a night guard covering days that is
--    [day, night], and the code downstream took "index 0" to mean "rostered".
--    So it wrote the cover as present and the rostered shift as the extra duty.
--
--    Nothing looked wrong: both rows existed, the day showed two shifts, and
--    the totals were right. Only WHICH cell said DD was wrong, which no total
--    would ever catch. Fixed in that file in the same change, and fixed by
--    comparing to scheduled_shift rather than by array position — the same test
--    the board uses and the same one this migration repairs against, so the
--    three now agree by construction instead of by coincidence.
--
-- A third shape is deliberately NOT touched: 33 days where a guard worked a
-- shift that was not his and has NO row on his own shift. That is a SWAP, not a
-- double duty — he stood one shift, just not the rostered one — and converting
-- it would invent an extra duty nobody worked.
--
-- ===========================================================================
-- WHAT IS REPAIRED, AND THE TWO RULES THAT DO IT
-- ===========================================================================
--
-- "The base row" is the row on the shift the guard was rostered to, i.e. the one
-- where worked_shift = scheduled_shift. The two rules need DIFFERENT conditions
-- on it, which is the whole subtlety here:
--
--   EXTRAS  — any worked row with worked_shift <> scheduled_shift, on a day that
--             has AT LEAST ONE base row and no leave, becomes `double_duty`.
--             "At least one", not "exactly one": the row is an extra duty
--             whatever else the day holds, because it names a shift that is not
--             the one it was scheduled for.
--
--   THE BASE — set to `present` only on days with EXACTLY ONE base row and at
--             least one extra. This is what turns the 33 inverted days the right
--             way round, and it needs the stricter test because on a day with
--             two base rows there is no single answer to which one is "the" base.
--
-- Ninety-two days have exactly that: two rows, each with worked_shift =
-- scheduled_shift, because the guard holds TWO postings — one on days and one on
-- nights — and stood both. Seventy-one of them read
-- `day=double_duty(s:day) | night=present(s:night)`.
--
-- An earlier draft of this migration resolved the day's roster as the most
-- common scheduled_shift across its rows. On those ninety-two days both shifts
-- tie at one apiece, so the tie-break — alphabetical — would have picked `day`,
-- flipped both statuses, and rewritten seventy-one days on the strength of `d`
-- sorting before `n`. It was caught by counting how many days the two drafts
-- disagreed about. A repair rule has to be checked against the rows it will
-- touch, not only against the ones that motivated it.
--
-- Those ninety-two days are left exactly as they are, and they are already
-- correct under the rule below: one non-DD row, on its own rostered shift.
--
-- A third shape is also deliberately untouched: 33 days where a guard worked a
-- shift that was not his and has NO base row at all. That is a SWAP — he stood
-- one shift, just not the rostered one — and converting it would invent an extra
-- duty nobody worked.
--
-- Leave days are excluded outright. 0393 owns those, a leave is the whole day,
-- and the one day on production that breaks BOTH rules is a leave day that 0393
-- repairs first. This migration must therefore run after it, which the numbering
-- already guarantees.
--
-- Nothing downstream has consumed any of this: prod holds 0 payroll_runs,
-- 0 payslips and 0 accounting_periods.

-- ---------------------------------------------------------------------------
-- THE REPAIR. Maintenance session for the month locks, as 0393.
-- ---------------------------------------------------------------------------
do $$
declare
  v_extra int;
  v_base  int;
  v_gain  int;
  v_bad   int;
begin
  if not exists (select 1 from pg_roles
                  where rolname = session_user and (rolsuper or rolbypassrls)) then
    raise exception
      '0394 REFUSED: the repair needs a maintenance session to get past the month locks, and this session is not one.';
  end if;
  perform set_config('app.ledger_maintenance', 'on', true);

  -- Counted BEFORE the writes, or it reports "nothing changed" every time.
  select count(*) into v_gain from (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) filter (where public.attendance_status_is_leave(status)) = 0
       and count(*) filter (where worked_shift::text is not distinct from scheduled_shift::text) >= 1
       and count(*) filter (where worked_shift::text is distinct from scheduled_shift::text
                              and status in ('present', 'double_duty')) > 0
       and count(*) filter (where status = 'double_duty') = 0) g;

  -- EXTRAS: at least one base row on the day is enough.
  with d as (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) filter (where public.attendance_status_is_leave(status)) = 0
       and count(*) filter (where worked_shift::text is not distinct from scheduled_shift::text) >= 1)
  update public.attendance_records r
     set status = 'double_duty', entry_type = 'double_duty'
    from d
   where r.employee_id = d.employee_id
     and r.attendance_date = d.attendance_date
     and r.worked_shift::text is distinct from r.scheduled_shift::text
     and r.status in ('present', 'double_duty')
     and (r.status <> 'double_duty' or r.entry_type is distinct from 'double_duty');
  get diagnostics v_extra = row_count;

  -- THE BASE: exactly one base row, and the day has extras. Run second, so it
  -- sees the extras the statement above has just created.
  with d as (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) filter (where public.attendance_status_is_leave(status)) = 0
       and count(*) filter (where worked_shift::text is not distinct from scheduled_shift::text) = 1
       and count(*) filter (where worked_shift::text is distinct from scheduled_shift::text
                              and status = 'double_duty') > 0)
  update public.attendance_records r
     set status = 'present', entry_type = 'normal'
    from d
   where r.employee_id = d.employee_id
     and r.attendance_date = d.attendance_date
     and r.worked_shift::text is not distinct from r.scheduled_shift::text
     and (r.status <> 'present' or r.entry_type is distinct from 'normal');
  get diagnostics v_base = row_count;

  raise notice
    '0394 repair: % extra row(s) set to double_duty, % base row(s) set to present; % day(s) gained a double duty that had none.',
    v_extra, v_base, v_gain;

  -- Nothing may be left that the trigger below would refuse. Asserted HERE and
  -- not only in the probe, so a database whose history differs from
  -- production's stops the migration rather than installing a trigger its own
  -- rows violate.
  select count(*) into v_bad from (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having (count(*) > 1
            and count(*) filter (where status = 'present'
                                   and worked_shift::text is distinct from scheduled_shift::text) > 0)
        or (count(*) filter (where status = 'double_duty') > 0
            and count(*) filter (where status = 'absent') > 0)) x;
  if v_bad <> 0 then
    raise exception
      '0394 REFUSED: % day(s) would still break the rule after the repair. The trigger is not installed.', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE RULE, ENFORCED.
--
-- "If someone is DD he cannot be present or absent or on leave in any other
-- remaining shift" — with the one thing that sentence does not mean: the BASE
-- present is not an "other shift". It is the shift the double duty was extra
-- to, and the encoding requires it. So:
--
--   * a PRESENT on a shift that is not the one rostered, on a day that has
--     another row, must be double_duty instead;
--   * no ABSENT on a day carrying a double duty.
--
-- Note the first rule is not phrased "on a day carrying a double duty", and
-- that is the whole correction. A first draft was, and its own probe caught it:
-- updating the day's only DD row back to a plain present left TWO plain
-- presents, the day no longer carried a double duty, so the guard stopped
-- applying to it — which is precisely defect 1 above, waved straight through by
-- the trigger written to prevent it. A rule that only holds while it is already
-- being obeyed is not a rule.
--
-- Two things this deliberately does NOT refuse, both real on production:
--
--   * A single row on a shift that is not the rostered one. That is a SWAP —
--     one shift stood, just not his — and 33 days are exactly that.
--   * Two absences on one day, e.g. day=absent(s:day) | evening=absent(s:evening).
--     Seven days are this: a guard holding two postings who missed both. The
--     first draft refused these too, via an "at most one non-DD row" clause
--     that read plausibly and was checked against the shapes it was written for
--     rather than against the whole table.
--
-- Leave is left entirely to 0393, which refuses it for its own reason.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_double_duty_owns_the_day()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows int;
  v_bad  text;
  v_name text;
begin
  -- How many rows does this day have once NEW is in place? A day with ONE row
  -- is a guard standing one shift, and that shift not being his rostered one is
  -- a SWAP — perfectly ordinary, and 33 days of production are exactly that. It
  -- only becomes an extra duty when there is another shift for it to be extra to.
  select count(*) + 1 into v_rows
    from public.attendance_records r
   where r.employee_id = NEW.employee_id
     and r.attendance_date = NEW.attendance_date
     and r.id is distinct from NEW.id;

  with all_rows as (
    select r.worked_shift::text as ws, r.status as st, r.scheduled_shift::text as ss
      from public.attendance_records r
     where r.employee_id = NEW.employee_id
       and r.attendance_date = NEW.attendance_date
       and r.id is distinct from NEW.id
    union all
    select NEW.worked_shift::text, NEW.status, NEW.scheduled_shift::text
  )
  select string_agg(t.ws || '=' || t.st, ', ' order by t.ws) into v_bad
    from all_rows t
   where
     -- A worked shift that is NOT the one rostered, beside another shift, is by
     -- definition the extra duty. It has to say so. Each row is judged against
     -- ITS OWN scheduled_shift, never against NEW's: where two rows disagree
     -- about which shift was scheduled, taking the incoming row's answer would
     -- flag whichever row happened not to be the one being written.
     (v_rows > 1 and t.st = 'present' and t.ws is distinct from t.ss)
     -- A double duty is a day fully worked, so nothing on it can be an absence.
     -- (Leave is refused by 0393, for its own reason.)
     or (t.st = 'absent'
         and exists (select 1 from all_rows u where u.st = 'double_duty'));

  if v_bad is not null then
    select full_name into v_name from public.employees where id = NEW.employee_id;
    raise exception
      'A double duty is % own shift plus every extra shift beside it, so an extra shift must be marked Double Duty and nothing that day can be absent. Found: %.',
      coalesce(v_name || '''s', 'this guard''s'), v_bad
      using errcode = '23514',
            hint = 'The rostered shift stays Present and every EXTRA shift is Double Duty. Clear the day and mark it again if the shifts have changed.';
  end if;

  return NEW;
end;
$function$;

comment on function public.enforce_double_duty_owns_the_day() is
  '0394: a worked shift that is not the rostered one (worked_shift <> scheduled_shift), on a day that has another row, IS the extra duty and must be marked double_duty rather than present; and no day carrying a double duty may also carry an absent. Encodes what the Attendance board already assumed and nothing checked. Deliberately not conditioned on the day already having a double duty — an earlier draft was, and could be escaped by removing the last DD row, which is defect 1 exactly. A lone off-roster row is a SHIFT SWAP and is allowed (33 days); two absences on a day are a guard with two postings who missed both, and are allowed (7 days). Before this, 25 days recorded two worked shifts as two plain presents and counted no extra duty at all, and 33 more had the double_duty on the rostered shift instead of the cover.';

drop trigger if exists trg_double_duty_owns_the_day on public.attendance_records;
create trigger trg_double_duty_owns_the_day
  before insert or update on public.attendance_records
  for each row
  execute function public.enforce_double_duty_owns_the_day();

-- ---------------------------------------------------------------------------
-- PROVE IT — including that the REPAIRED data satisfies the new trigger, which
-- a probe on synthetic rows alone would not show.
-- ---------------------------------------------------------------------------
do $$
declare
  v_emp uuid; v_co uuid; v_date date; v_n int; v_left int;
begin
  perform set_config('app.ledger_maintenance', 'on', true);

  -- 0. The whole table now agrees with the rule. This is the arm that matters:
  --    a trigger that only ever sees new rows would let every historical
  --    violation stand while reporting success.
  select count(*) into v_left from (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having (count(*) > 1
            and count(*) filter (where status = 'present'
                                   and worked_shift::text is distinct from scheduled_shift::text) > 0)
        or (count(*) filter (where status = 'double_duty') > 0
            and count(*) filter (where status = 'absent') > 0)) x;
  if v_left <> 0 then
    raise exception '0394 FAILED: % day(s) still break the rule after the repair.', v_left;
  end if;

  select e.id, e.company_id into v_emp, v_co
    from public.employees e
   where e.lifecycle_state <> 'archived'
     and exists (select 1 from public.deployments d where d.guard_id = e.id)
   order by e.created_at limit 1;
  if v_emp is null then raise exception '0394 FAILED: no deployed employee to probe against.'; end if;
  v_date := date_trunc('month', current_date)::date + 2;
  delete from public.attendance_records where employee_id = v_emp and attendance_date = v_date;

  -- 1. The well-formed day WORKS: base present on the rostered shift + the cover
  --    as double duty. A trigger refusing everything would pass arms 2-4.
  insert into public.attendance_records
    (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source, entry_type)
  values (v_co, v_emp, v_date, 'present', 'night', 'night', 'manual', 'normal'),
         (v_co, v_emp, v_date, 'double_duty', 'day', 'night', 'manual', 'double_duty');
  select count(*) into v_n from public.attendance_records
   where employee_id = v_emp and attendance_date = v_date;
  if v_n <> 2 then raise exception '0394 FAILED: a well-formed double duty left % row(s).', v_n; end if;

  -- 2. A SECOND plain present on a third shift — the 25-day defect arriving
  --    again. Refused by message.
  begin
    insert into public.attendance_records
      (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source)
    values (v_co, v_emp, v_date, 'present', 'evening', 'night', 'manual');
    raise exception '0394 FAILED: a plain present was accepted beside a double duty.';
  exception when others then
    if sqlerrm not like '%must be marked Double Duty%' then
      raise exception '0394 FAILED: the extra present raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;

  -- 3. An ABSENT on the remaining shift.
  begin
    insert into public.attendance_records
      (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source)
    values (v_co, v_emp, v_date, 'absent', 'evening', 'night', 'manual');
    raise exception '0394 FAILED: an absent was accepted beside a double duty.';
  exception when others then
    if sqlerrm not like '%must be marked Double Duty%' then
      raise exception '0394 FAILED: the absent raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;

  -- 4. And by UPDATE, not only INSERT — turning the cover row back into a plain
  --    present is exactly the inversion this migration repaired.
  begin
    update public.attendance_records
       set status = 'present'
     where employee_id = v_emp and attendance_date = v_date and worked_shift::text = 'day';
    raise exception '0394 FAILED: an UPDATE turned the cover shift into a second plain present.';
  exception when others then
    if sqlerrm not like '%must be marked Double Duty%' then
      raise exception '0394 FAILED: the update raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;

  -- 5. A day with NO double duty is untouched by any of this — a guard who
  --    simply swapped onto another shift still records one plain present.
  delete from public.attendance_records where employee_id = v_emp and attendance_date = v_date;
  insert into public.attendance_records
    (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source)
  values (v_co, v_emp, v_date, 'present', 'day', 'night', 'manual');

  raise exception
    'ROLLBACK_PROBE 0394 OK: the repaired table satisfies the rule; a well-formed double duty writes, a second present / an absent / an update-to-present are each refused by message, and a plain shift swap is untouched.';
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
    raise exception '0394 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
