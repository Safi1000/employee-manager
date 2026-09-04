-- 0395 — a double duty is EXACTLY TWO shifts, and both rows say `double_duty`.
--         Never one, never three.
--
-- ===========================================================================
-- THE ENCODING CHANGES HERE, AND THAT IS THE POINT
-- ===========================================================================
--
-- 0394 recorded a double duty the way the Attendance board always had: the
-- rostered shift as `present`, each extra shift as `double_duty`. Shayan's rule
-- (2026-09-04) replaces it:
--
--     "at most 2 DD entries and at least 2 DD entries within the same day,
--      nothing more nothing less"
--
-- So a double-duty day is two rows and BOTH carry `double_duty`. A guard covers
-- at most two shifts in a day; three is not physically possible and is a
-- recording error, not a fact.
--
-- Two consequences worth stating, because they are the reasons this is better
-- than what it replaces:
--
--   * The day is legible from the STATUSES ALONE. Under the old encoding a
--     double duty was "a present and a double_duty", and telling that apart
--     from "a present and a mistake" required joining each row to its
--     scheduled_shift and knowing the convention. Two rows that both say
--     `double_duty` say what they are.
--
--   * The Monthly Board shows DD in BOTH shift columns, which is what a reader
--     expects of a day worked twice. Under the old encoding one column said P
--     and the other DD, and the P column was indistinguishable from an ordinary
--     day's.
--
-- ===========================================================================
-- WHAT IS ON PRODUCTION, AND WHAT HAPPENS TO IT
-- ===========================================================================
--
--   33,910 days   one worked shift                    untouched
--    4,166 days   no worked shift (leave / absent)    untouched
--      258 days   1 present + 1 double_duty           BOTH become double_duty
--        1 day    2 presents                          BOTH become double_duty
--       25 days   THREE worked shifts                 one row deleted, then both
--
-- The 283 relabelled days lose nothing: the same two shifts stay recorded, and
-- the day already counted as one present plus one extra duty.
--
-- ===========================================================================
-- THE TWENTY-FIVE, AND THE CHOICE THAT COULD NOT BE AVOIDED
-- ===========================================================================
--
-- All 25 are HMC Taxila, 14 guards, 16-30 August. 24 of them read
-- `day=double_duty | evening=double_duty | night=present` with the guard
-- rostered on nights; the 25th is Nazar Hussain, rostered days.
--
-- A row has to go, and the evidence does not say which. What was checked:
--
--   * scheduled_shift — all three rows carry the SAME rostered shift, so it
--     identifies the base but says nothing about which of the two covers is
--     false.
--   * deployments — every one of these guards is posted to exactly one shift,
--     so both covers are equally off-roster.
--   * attendance_confirmations — all three shifts are supervisor-confirmed on
--     all 25 days.
--   * the contract headcount — HMC Taxila reads 109 day / 0 evening / 0 night
--     while these guards are DEPLOYED to night, so it contradicts itself and
--     cannot be leant on.
--   * whether the shifts are real — day, evening and night each carry 34-44
--     marked guards on these dates, so no shift is a phantom.
--
-- So the rule is stated rather than discovered, and it is this:
--
--   THE BASE ROW IS NEVER DELETED. A guard certainly stood his own rostered
--   shift; that is the one row nothing casts doubt on.
--
--   OF THE TWO COVERS, THE ONE MARKED LATER GOES. The day already held a
--   complete double duty before that row arrived — it is the row that made the
--   day impossible, and the last write is the one with the weakest claim to
--   being what the supervisor originally reported.
--
-- That drops 13 `day` covers, 11 `evening` and 1 `night`. The spread matters:
-- a rule that had turned out to delete the same shift 25 times would have been
-- measuring the sort order rather than the data, and would have been wrong.
--
-- Each deleted row is listed by name and date in the notice this migration
-- raises, so any one of them can be put back if the operator says otherwise.
--
-- Prod holds 0 payroll_runs, 0 payslips and 0 accounting_periods, so no
-- disbursed figure moves.

-- ---------------------------------------------------------------------------
-- THE REPAIR.
-- ---------------------------------------------------------------------------
do $$
declare
  v_over   int;
  v_del    int;
  v_relab  int;
  v_list   text;
  v_bad    int;
begin
  if not exists (select 1 from pg_roles
                  where rolname = session_user and (rolsuper or rolbypassrls)) then
    raise exception
      '0395 REFUSED: the repair needs a maintenance session to get past the month locks, and this session is not one.';
  end if;
  perform set_config('app.ledger_maintenance', 'on', true);

  select count(*) into v_over from (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) filter (where status in ('present', 'double_duty')) > 2) o;

  -- ---- Three shifts in a day: delete the later-marked COVER. Never the base.
  with over3 as (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) filter (where status in ('present', 'double_duty')) > 2),
  ranked as (
    select r.id, r.employee_id, r.attendance_date, r.worked_shift::text as ws,
           row_number() over (partition by r.employee_id, r.attendance_date
                              -- marked_at first; worked_shift only to make a tie
                              -- deterministic, never to choose a shift on merit.
                              order by r.marked_at desc nulls last, r.worked_shift::text desc) as recency
      from over3 o
      join public.attendance_records r
        on r.employee_id = o.employee_id and r.attendance_date = o.attendance_date
     where r.worked_shift::text is distinct from r.scheduled_shift::text
       and r.status in ('present', 'double_duty'))
  select string_agg(e.full_name || ' ' || k.attendance_date || ' ' || k.ws, '; '
                    order by e.full_name, k.attendance_date)
    into v_list
    from ranked k join public.employees e on e.id = k.employee_id
   where k.recency = 1;

  with over3 as (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) filter (where status in ('present', 'double_duty')) > 2),
  ranked as (
    select r.id,
           row_number() over (partition by r.employee_id, r.attendance_date
                              order by r.marked_at desc nulls last, r.worked_shift::text desc) as recency
      from over3 o
      join public.attendance_records r
        on r.employee_id = o.employee_id and r.attendance_date = o.attendance_date
     where r.worked_shift::text is distinct from r.scheduled_shift::text
       and r.status in ('present', 'double_duty'))
  delete from public.attendance_records a
   using ranked k
   where a.id = k.id and k.recency = 1;
  get diagnostics v_del = row_count;

  if v_over > 0 then
    raise notice '0395: deleted % third-shift row(s) on % day(s): %', v_del, v_over, coalesce(v_list, '(none)');
  end if;
  if v_del <> v_over then
    raise exception
      '0395 REFUSED: % day(s) had three shifts but % row(s) were deleted. Every such day must lose exactly one.',
      v_over, v_del;
  end if;

  -- ---- Every remaining two-worked-shift day: BOTH rows say double_duty.
  with two as (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) filter (where status in ('present', 'double_duty')) = 2)
  update public.attendance_records r
     set status = 'double_duty', entry_type = 'double_duty'
    from two
   where r.employee_id = two.employee_id
     and r.attendance_date = two.attendance_date
     and r.status in ('present', 'double_duty')
     and (r.status <> 'double_duty' or r.entry_type is distinct from 'double_duty');
  get diagnostics v_relab = row_count;

  raise notice '0395 repair: % row(s) deleted from three-shift days, % row(s) relabelled to double_duty.',
    v_del, v_relab;

  -- Nothing may be left that the constraint below would refuse.
  select count(*) into v_bad from (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) filter (where status in ('present', 'double_duty')) > 2
        or (count(*) filter (where status in ('present', 'double_duty')) = 2
            and count(*) filter (where status = 'double_duty') <> 2)
        or (count(*) filter (where status in ('present', 'double_duty')) = 1
            and count(*) filter (where status = 'double_duty') = 1)) x;
  if v_bad <> 0 then
    raise exception
      '0395 REFUSED: % day(s) would still break the rule after the repair. The constraint is not installed.', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE RULE, ENFORCED — AND WHY IT IS A DEFERRED CONSTRAINT TRIGGER
-- ---------------------------------------------------------------------------
--
-- This invariant CANNOT be a BEFORE ROW trigger, and the reason is worth
-- keeping: it is a statement about the whole day, and the day passes through an
-- invalid state on its way to a valid one. The board writes a double duty as
-- two rows in one upsert. After the first row lands, the day holds exactly one
-- `double_duty` — which the rule forbids. A row-level trigger would refuse the
-- board's own correct write, halfway through.
--
-- So it is a CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED: it runs once
-- per affected row at COMMIT, when the day is whatever the transaction meant it
-- to be. PostgREST wraps each request in a transaction, so a screen's whole
-- write is one unit and is judged as one.
--
-- It covers DELETE as well, which is not symmetry for its own sake: removing
-- one row of a double duty leaves a lone `double_duty`, and "nothing less" has
-- to mean that too or half a double duty survives as a legal state.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_double_duty_is_exactly_two()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_emp    uuid;
  v_date   date;
  v_worked int;
  v_dd     int;
  v_name   text;
  v_shape  text;
begin
  if TG_OP = 'DELETE' then
    v_emp := OLD.employee_id; v_date := OLD.attendance_date;
  else
    v_emp := NEW.employee_id; v_date := NEW.attendance_date;
  end if;

  select count(*) filter (where status in ('present', 'double_duty')),
         count(*) filter (where status = 'double_duty'),
         string_agg(worked_shift::text || '=' || status, ', ' order by worked_shift::text)
    into v_worked, v_dd, v_shape
    from public.attendance_records
   where employee_id = v_emp and attendance_date = v_date;

  -- The day may have been emptied entirely; that is a clear, not a breach.
  if v_worked = 0 then
    return null;
  end if;

  if v_worked > 2 or (v_worked = 2 and v_dd <> 2) or (v_worked = 1 and v_dd = 1) then
    select full_name into v_name from public.employees where id = v_emp;
  end if;

  if v_worked > 2 then
    raise exception
      'A guard can cover at most two shifts in one day. % is recorded on % shifts on % (%).',
      coalesce(v_name, 'This guard'), v_worked, v_date, v_shape
      using errcode = '23514',
            hint = 'Clear the day and mark the two shifts actually worked.';
  end if;

  if v_worked = 2 and v_dd <> 2 then
    raise exception
      'Two shifts in one day is a double duty, and BOTH shifts are marked Double Duty — % of 2 are, on % for % (%).',
      v_dd, v_date, coalesce(v_name, 'this guard'), v_shape
      using errcode = '23514',
            hint = 'Mark the day Double Duty and pick both shifts; do not leave one of them as a plain Present.';
  end if;

  if v_worked = 1 and v_dd = 1 then
    raise exception
      'A double duty is two shifts, so one shift alone cannot be marked Double Duty — % has only % on % (%).',
      coalesce(v_name, 'this guard'), v_shape, v_date, v_shape
      using errcode = '23514',
            hint = 'Pick the second shift too, or mark the day Present if only one shift was worked.';
  end if;

  return null;
end;
$function$;

comment on function public.enforce_double_duty_is_exactly_two() is
  '0395: a double duty is EXACTLY two worked shifts in a day and BOTH rows carry status double_duty — never one, never three (Shayan, 2026-09-04). Replaces the older base-present-plus-extra-double_duty encoding, under which a double-duty day was only legible by joining each row to its scheduled_shift. Deferred to COMMIT rather than checked per row, because the board writes both rows of a double duty in one statement and the day is legitimately half-written in between; a BEFORE ROW trigger would refuse the correct write halfway through. Fires on DELETE too, so removing one leg cannot leave half a double duty behind.';

drop trigger if exists trg_double_duty_is_exactly_two on public.attendance_records;
create constraint trigger trg_double_duty_is_exactly_two
  after insert or update or delete on public.attendance_records
  deferrable initially deferred
  for each row
  execute function public.enforce_double_duty_is_exactly_two();

-- ---------------------------------------------------------------------------
-- PROVE IT.
--
-- Every refusal asserted ON ITS MESSAGE. And note arm 1: it is the arm that
-- would have failed had this been written as a BEFORE ROW trigger, so it is
-- testing the deferral and not only the rule.
-- ---------------------------------------------------------------------------
do $$
declare
  v_emp uuid; v_co uuid; v_date date; v_n int; v_left int;
begin
  perform set_config('app.ledger_maintenance', 'on', true);

  -- 0. The whole table already agrees, or the constraint is a lie about history.
  select count(*) into v_left from (
    select employee_id, attendance_date
      from public.attendance_records
     group by 1, 2
    having count(*) filter (where status in ('present', 'double_duty')) > 2
        or (count(*) filter (where status in ('present', 'double_duty')) = 2
            and count(*) filter (where status = 'double_duty') <> 2)
        or (count(*) filter (where status in ('present', 'double_duty')) = 1
            and count(*) filter (where status = 'double_duty') = 1)) x;
  if v_left <> 0 then
    raise exception '0395 FAILED: % day(s) still break the rule after the repair.', v_left;
  end if;

  select e.id, e.company_id into v_emp, v_co
    from public.employees e
   where e.lifecycle_state <> 'archived'
     and exists (select 1 from public.deployments d where d.guard_id = e.id)
   order by e.created_at limit 1;
  if v_emp is null then raise exception '0395 FAILED: no deployed employee to probe against.'; end if;
  v_date := date_trunc('month', current_date)::date + 3;
  delete from public.attendance_records where employee_id = v_emp and attendance_date = v_date;

  -- 1. TWO rows, both double_duty, written one after the other. The day is
  --    momentarily a lone DD between the two inserts and must NOT be refused —
  --    this is the whole reason the constraint is deferred.
  insert into public.attendance_records
    (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source, entry_type)
  values (v_co, v_emp, v_date, 'double_duty', 'night', 'night', 'manual', 'double_duty');
  insert into public.attendance_records
    (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source, entry_type)
  values (v_co, v_emp, v_date, 'double_duty', 'day', 'night', 'manual', 'double_duty');
  select count(*) into v_n from public.attendance_records
   where employee_id = v_emp and attendance_date = v_date;
  if v_n <> 2 then raise exception '0395 FAILED: a well-formed double duty left % row(s).', v_n; end if;

  -- 2. A THIRD shift. Deferred, so it raises at the SET CONSTRAINTS below
  --    rather than at the insert — which is exactly what has to be tested.
  begin
    insert into public.attendance_records
      (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source, entry_type)
    values (v_co, v_emp, v_date, 'double_duty', 'evening', 'night', 'manual', 'double_duty');
    set constraints public.trg_double_duty_is_exactly_two immediate;
    raise exception '0395 FAILED: a third shift was accepted.';
  exception when others then
    if sqlerrm not like '%at most two shifts%' then
      raise exception '0395 FAILED: the third shift raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;
  -- The failed sub-block rolled the constraint check back with it; re-assert
  -- the known-good day before continuing.
  delete from public.attendance_records where employee_id = v_emp and attendance_date = v_date;

  -- 3. Two worked shifts where only ONE says double_duty — the old encoding,
  --    which must now be refused.
  begin
    insert into public.attendance_records
      (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source, entry_type)
    values (v_co, v_emp, v_date, 'present', 'night', 'night', 'manual', 'normal'),
           (v_co, v_emp, v_date, 'double_duty', 'day', 'night', 'manual', 'double_duty');
    set constraints public.trg_double_duty_is_exactly_two immediate;
    raise exception '0395 FAILED: a present-plus-double_duty day was accepted.';
  exception when others then
    if sqlerrm not like '%BOTH shifts are marked Double Duty%' then
      raise exception '0395 FAILED: the mixed day raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;
  delete from public.attendance_records where employee_id = v_emp and attendance_date = v_date;

  -- 4. A LONE double duty.
  begin
    insert into public.attendance_records
      (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source, entry_type)
    values (v_co, v_emp, v_date, 'double_duty', 'night', 'night', 'manual', 'double_duty');
    set constraints public.trg_double_duty_is_exactly_two immediate;
    raise exception '0395 FAILED: a single double_duty shift was accepted.';
  exception when others then
    if sqlerrm not like '%one shift alone cannot be marked Double Duty%' then
      raise exception '0395 FAILED: the lone double duty raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;
  delete from public.attendance_records where employee_id = v_emp and attendance_date = v_date;

  -- 5. An ordinary single present is untouched by all of this.
  insert into public.attendance_records
    (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source, entry_type)
  values (v_co, v_emp, v_date, 'present', 'night', 'night', 'manual', 'normal');
  set constraints public.trg_double_duty_is_exactly_two immediate;

  raise exception
    'ROLLBACK_PROBE 0395 OK: two DD rows write across two statements (the deferral works), and a third shift, a present-plus-DD day and a lone DD are each refused by message.';
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
    raise exception '0395 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
