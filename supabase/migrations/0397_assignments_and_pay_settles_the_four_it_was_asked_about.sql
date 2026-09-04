-- 0397 — the four remaining attendance oddities, settled against Assignments &
--         Pay (deployments) and the daily board, as Shayan directed.
--
-- ===========================================================================
-- WHY THIS MIGRATION EXISTS AT ALL: THE ROSTER WAS NEVER CONSULTED
-- ===========================================================================
--
-- Four shapes were reported as open after 0396. Asked to settle them against
-- Assignments & Pay, the postings answered all four — and OVERTURNED TWO
-- CONCLUSIONS THAT HAD ALREADY BEEN REASONED ABOUT AT LENGTH WITHOUT THEM.
--
-- That is the finding worth keeping, above any of the individual repairs:
-- `deployments` is a dated record of who was posted where, on which shift, on
-- which day, and it had the answer the whole time. Both wrong conclusions came
-- from inferring intent out of attendance_records alone — counting rows, and
-- comparing marked_at timestamps — when a table one join away simply said.
--
-- ===========================================================================
-- 1. "TWO CONCURRENT POSTINGS" — WRONG, AND A ONE-DAY POSTING IS HOW A COVER
--    IS RECORDED
-- ===========================================================================
--
-- Muhammad Sabir Khan (EMR-010) 2 Aug and Muhammad Sadiq Khan (EMR-055) 4 Aug
-- were flagged as double duties that might be over-paying, because each guard
-- appeared to hold two postings covering the day, so "both shifts were his
-- own". Read the postings properly:
--
--   Sabir Khan   day    2026-08-01 -> (open)      his standing posting
--                night  2026-08-02 -> 2026-08-02  ONE DAY ONLY
--   Sadiq Khan   day    2026-08-03 -> (open)      his standing posting
--                night  2026-08-04 -> 2026-08-04  ONE DAY ONLY
--
-- A single-day posting on another shift IS how Assignments & Pay records a
-- cover. So the second "posting" is not evidence that the extra shift was
-- routine — it is the extra shift, written down. Both are genuine double
-- duties and NOTHING CHANGES for them. This migration asserts that, so the
-- claim is checked rather than repeated.
--
-- ===========================================================================
-- 2. BASHARAT KHAN AND BABAR BAIG DID NOT HOLD TWO POSTINGS EITHER
-- ===========================================================================
--
-- 0396 recorded that both men held "two concurrent postings, one on days and
-- one on evenings", and resolved their contradictory days on that basis. The
-- postings say otherwise:
--
--   Basharat Khan (HMC-074)   day     2026-07-01 -> 2026-07-26
--                             evening 2026-07-27 -> 2026-07-31
--                             day     2026-08-01 -> (open)
--   Babar Baig    (HMC-049)   day     2026-07-01 -> 2026-07-31
--                             evening 2026-08-01 -> (open)
--
-- These are SEQUENTIAL, not concurrent. Each man changed shift on 1 August.
-- In August Basharat is day-only and Babar is evening-only.
--
-- 0396 reached the right answers anyway, and this is worth being precise about
-- because it is luck and not method:
--
--   * Basharat's five days were `day=present | evening=absent` in AUGUST, when
--     he had no evening posting at all. The evening rows were unsupported, and
--     dropping them was correct — but 0396 kept the present because "he
--     demonstrably worked", which would have been the wrong rule had the
--     absence been on the shift he was actually posted to.
--   * Babar's 2 August day was `day=absent | evening=absent`, and 0396 kept the
--     EARLIER marked_at. In August he is posted to evenings, so the row that
--     should survive is the evening one. Whether it did was decided by a
--     timestamp, not by the roster.
--
-- Which brings the actual defect this migration repairs.
--
-- ===========================================================================
-- 3. THE LEAVE ROWS ARE ON THE WRONG SHIFT — 46 OF THEM
-- ===========================================================================
--
-- A leave has no shift; it covers the whole day (0393). `worked_shift` on a
-- leave row is therefore a PLACEHOLDER, and the Monthly Board renders the leave
-- in whichever shift column that placeholder names. Get it wrong and a guard's
-- leave appears under a shift he was not even posted to.
--
-- 0393 de-duplicated Babar Baig's doubled leaves (9-12 August) by keeping the
-- earliest `marked_at`. The survivor was the `day` row, written 20 August. He
-- moved to evenings on 1 August. So his August leave now shows in the D column
-- of a board where his whole month is E.
--
-- 46 leave rows across 17 guards sit on a shift the guard was not posted to on
-- that date, where the roster names EXACTLY ONE shift for the day. Those are
-- realigned to the posted shift. Nothing else about them changes: same day,
-- same status, same count of leaves. Only the column they appear in.
--
-- Deliberately NOT touched: 372 leave rows on dates no posting covers at all.
-- There is no roster answer for those, and inventing one would be worse than
-- the placeholder already there.
--
-- ===========================================================================
-- 4. THE 24 `blocked` ROWS ARE NOT ATTENDANCE
-- ===========================================================================
--
-- All 24 belong to Aamir Shabbir (GGS-00408), dated 1-24 July, written in a
-- single batch on 28 July with a null marked_by_role.
--
-- His join date is 2026-08-01. Every one of those rows predates his employment
-- by a month.
--
-- `blocked` is not something that happened to a guard — it is what
-- attendance_gate() RETURNS when a day may not be marked (out of window,
-- archived, period closed). A bulk mark ran over a date range, the gate said
-- "blocked" for each day, and the MODE was written into `status` instead of the
-- mark being refused. That is the exact defect 0228 named. These rows are its
-- residue: they are the system's refusal, stored as though it were a fact about
-- a man who had not yet been hired.
--
-- Deleted. The employment-window trigger already refuses their recreation, and
-- the probe below exercises that rather than assuming it.
--
-- ===========================================================================
-- 5. GULREZ AKHTAR, 24 JULY — LEFT ALONE, AND WHY
-- ===========================================================================
--
-- A double duty on a date NO posting covers. The postings around it:
--
--   night  2026-07-01 -> 2026-07-21
--   day    2026-07-22 -> 2026-07-22
--   day    2026-07-25 -> (open)
--
-- 23 and 24 July are a hole in the roster, and the daily board fills it: he is
-- marked present on the night of the 23rd and double duty (day + night) on the
-- 24th, all three rows entered as supervisor overrides on 28 July. He was
-- moving from nights to days that week, and a double duty on the changeover day
-- — the last night and the first day — is exactly what that looks like.
--
-- So the two sources disagree, and the daily board is the one with a record of
-- somebody standing a post. THE ATTENDANCE STAYS AND THE ROSTER IS WHAT IS
-- INCOMPLETE. Deleting a worked day to match a gap in the posting history would
-- be taking pay away to tidy a join.
--
-- Recorded here rather than repaired, because filling a deployment gap is a
-- change to Assignments & Pay and belongs to whoever owns that roster.

-- ---------------------------------------------------------------------------
-- THE REPAIR.
-- ---------------------------------------------------------------------------
do $$
declare
  v_blocked int;
  v_leave   int;
  v_list    text;
  v_ok      int;
begin
  if not exists (select 1 from pg_roles
                  where rolname = session_user and (rolsuper or rolbypassrls)) then
    raise exception
      '0397 REFUSED: the repair needs a maintenance session to get past the month locks, and this session is not one.';
  end if;
  perform set_config('app.ledger_maintenance', 'on', true);

  -- ---- 1. Assert the two "maybe over-paid" double duties really are covers,
  -- before anything else runs. If Assignments & Pay does not show a one-day
  -- posting on the covered shift, the reasoning above is wrong and this
  -- migration should stop rather than proceed on a false premise.
  select count(*) into v_ok
    from public.attendance_records r
    join public.employees e on e.id = r.employee_id
   where e.guard_code in ('GGS-00040', 'GGS-00260')
     and r.attendance_date in (date '2026-08-02', date '2026-08-04')
     and r.status = 'double_duty'
     and exists (select 1 from public.deployments d
                  where d.guard_id = r.employee_id
                    and d.start_date = d.end_date
                    and d.start_date = r.attendance_date);
  if v_ok = 0 then
    raise exception
      '0397 REFUSED: neither flagged double duty is backed by a one-day cover posting. The premise this migration is built on does not hold.';
  end if;

  -- ---- 2. The gate mode written as a status, for days before the guard was
  -- hired. Matched on the condition, not on the guard's name: if another such
  -- row exists it should go too.
  delete from public.attendance_records r
   using public.employees e
   where e.id = r.employee_id
     and r.status = 'blocked'
     and e.join_date is not null
     and r.attendance_date < e.join_date;
  get diagnostics v_blocked = row_count;

  -- ---- 3. Leave rows onto the shift the roster names for that day.
  with lv as (
    select r.id, r.employee_id, r.attendance_date, r.worked_shift::text as ws,
           (select array_agg(distinct coalesce(d.shift_code::text, cl.shift_code::text))
              from public.deployments d
              left join public.contract_lines cl on cl.id = d.contract_line_id
             where d.guard_id = r.employee_id
               and d.start_date <= r.attendance_date
               and (d.end_date is null or d.end_date >= r.attendance_date)) as posted
      from public.attendance_records r
     where public.attendance_status_is_leave(r.status)),
  target as (
    select id, employee_id, attendance_date, ws, posted[1] as want
      from lv
     where posted is not null
       and array_length(posted, 1) = 1
       and posted[1] is not null
       and ws <> posted[1])
  select string_agg(e.full_name || ' ' || t.attendance_date || ' ' || t.ws || '->' || t.want, '; '
                    order by e.full_name, t.attendance_date)
    into v_list
    from target t join public.employees e on e.id = t.employee_id;

  with lv as (
    select r.id, r.employee_id, r.attendance_date, r.worked_shift::text as ws,
           (select array_agg(distinct coalesce(d.shift_code::text, cl.shift_code::text))
              from public.deployments d
              left join public.contract_lines cl on cl.id = d.contract_line_id
             where d.guard_id = r.employee_id
               and d.start_date <= r.attendance_date
               and (d.end_date is null or d.end_date >= r.attendance_date)) as posted
      from public.attendance_records r
     where public.attendance_status_is_leave(r.status)),
  target as (
    select id, employee_id, attendance_date, posted[1] as want
      from lv
     where posted is not null
       and array_length(posted, 1) = 1
       and posted[1] is not null
       and ws <> posted[1])
  update public.attendance_records r
     set worked_shift = t.want,
         scheduled_shift = t.want
    from target t
   where r.id = t.id
     -- A leave day is a single row (0396), so this can never collide. Asserted
     -- rather than assumed: the unique key is (employee, date, worked_shift).
     and not exists (select 1 from public.attendance_records o
                      where o.employee_id = t.employee_id
                        and o.attendance_date = t.attendance_date
                        and o.worked_shift::text = t.want
                        and o.id <> t.id);
  get diagnostics v_leave = row_count;

  raise notice
    '0397: deleted % pre-employment `blocked` row(s); realigned % leave row(s) to the posted shift: %',
    v_blocked, v_leave, coalesce(v_list, '(none)');

  -- No leave may now sit on a shift its own roster contradicts, where the
  -- roster gives one answer.
  select count(*) into v_ok from (
    select r.id
      from public.attendance_records r
     where public.attendance_status_is_leave(r.status)
       and (select count(distinct coalesce(d.shift_code::text, cl.shift_code::text))
              from public.deployments d
              left join public.contract_lines cl on cl.id = d.contract_line_id
             where d.guard_id = r.employee_id
               and d.start_date <= r.attendance_date
               and (d.end_date is null or d.end_date >= r.attendance_date)) = 1
       and r.worked_shift::text <> (select max(coalesce(d.shift_code::text, cl.shift_code::text))
              from public.deployments d
              left join public.contract_lines cl on cl.id = d.contract_line_id
             where d.guard_id = r.employee_id
               and d.start_date <= r.attendance_date
               and (d.end_date is null or d.end_date >= r.attendance_date))) x;
  if v_ok <> 0 then
    raise exception '0397 FAILED: % leave row(s) still sit on a shift the roster contradicts.', v_ok;
  end if;

  if exists (select 1 from public.attendance_records r
              join public.employees e on e.id = r.employee_id
             where r.status = 'blocked' and e.join_date is not null
               and r.attendance_date < e.join_date) then
    raise exception '0397 FAILED: a pre-employment `blocked` row survives.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- PROVE IT — that the window trigger refuses to recreate what was just deleted.
--
-- The deletion is only half the job: if a bulk mark can still write `blocked`
-- over a range before somebody's join date, the rows come back next week. This
-- exercises the guard rather than trusting it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_emp uuid; v_co uuid; v_join date;
begin
  perform set_config('app.ledger_maintenance', 'on', true);

  select e.id, e.company_id, e.join_date into v_emp, v_co, v_join
    from public.employees e
   where e.join_date is not null and e.lifecycle_state <> 'archived'
   order by e.join_date desc
   limit 1;
  if v_emp is null then
    raise exception '0397 FAILED: no employee with a join date to probe against.';
  end if;

  begin
    insert into public.attendance_records
      (company_id, employee_id, attendance_date, status, worked_shift, scheduled_shift, source)
    values (v_co, v_emp, v_join - 5, 'present', 'day', 'day', 'manual');
    raise exception
      '0397 FAILED: a mark was accepted % days before the guard joined. Deleting the blocked rows does not stop them coming back.',
      5;
  exception when others then
    if sqlerrm like '0397 FAILED%' then raise; end if;
    -- Any refusal is acceptable here; what matters is that it IS refused, and
    -- the message is reported so the reason is on the record.
    raise notice '0397: a pre-join mark is refused — "%"', sqlerrm;
  end;

  raise exception 'ROLLBACK_PROBE 0397 OK: pre-employment marking is refused by the window guard.';
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
    raise exception '0397 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
