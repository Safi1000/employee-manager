-- 0398 — four holes in Assignments & Pay, filled from what the daily board says
--         was actually stood.
--
-- ===========================================================================
-- WHICH SOURCE GIVES WAY
-- ===========================================================================
--
-- 0397 left one case open: Gulrez Akhtar has a double duty on 24 July on a date
-- NO deployment covers. Attendance and the roster disagreed, and the roster was
-- the one missing a record — so the honest repair is to give the roster the
-- days rather than take the days off the guard.
--
-- Told to settle it either way, this settles it that way, for one reason: a
-- deployment gap costs nothing to close and closing it invents no work, while
-- deleting the attendance would remove a shift a supervisor confirmed somebody
-- stood. When two records disagree and only one of them is evidence of a person
-- being somewhere, the other is the one that is incomplete.
--
-- ===========================================================================
-- IT WAS NOT ONE GAP, IT WAS FOUR
-- ===========================================================================
--
-- Looking for the shape rather than the instance found three more. An INTERNAL
-- gap — one segment ends, the next begins later, SAME SITE — with attendance
-- inside it:
--
--   Faisal Rehman (NG)  GGS-00094  28 Jul - 09 Aug  13 days  night
--   Pervaiz Akhtar      GGS-00079  19 Jul - 31 Jul  13 days  day
--   Gulrez Akhtar       GGS-00264  23 Jul - 24 Jul   2 days  night
--   Faisal Wazir        GGS-00250  20 Jul - 21 Jul   2 days  night
--
-- Thirty days in total. Eight internal gaps exist; the four with no attendance
-- in them are left alone — an empty gap is a guard who genuinely was not posted,
-- and filling it would invent a posting.
--
-- ===========================================================================
-- WHICH SHIFT EACH FILLED SEGMENT GETS
-- ===========================================================================
--
-- From THE ATTENDANCE INSIDE THE GAP, not from the segment on either side.
--
-- That distinction is the whole care in this migration. Gulrez's preceding
-- segment is a one-day `day` posting on 22 July — itself a cover — so taking
-- "the shift before the gap" would post him to days, when the attendance in the
-- gap is two night rows and one day row: he was still a night guard, covering a
-- day shift on the 24th, and moved to days on the 25th. Copying the neighbour
-- would have recorded the changeover two days early and turned his double duty
-- inside out.
--
-- So each gap takes the shift its own attendance uses most, ties broken by
-- name so a re-run is identical. Site, client, company and contract line come
-- from the segment BEFORE the gap, which is the part the neighbour does know.
--
-- ===========================================================================
-- WHAT THIS DOES NOT TOUCH
-- ===========================================================================
--
-- 8,277 attendance rows sit on dates with no posting at all. Almost none are
-- internal gaps — they are guards whose deployment history simply starts later
-- than their attendance does, and there is no bracket to interpolate between.
-- Inventing a posting there means inventing where somebody stood, which is a
-- different act from closing a hole between two known postings at one site.
--
-- Prod holds 0 invoices, 0 payroll_runs and 0 payslips, so no billed quantity
-- or disbursed figure moves.

do $$
declare
  v_gaps int;
  v_made int;
  v_list text;
  v_left int;
begin
  if not exists (select 1 from pg_roles
                  where rolname = session_user and (rolsuper or rolbypassrls)) then
    raise exception '0398 REFUSED: this repair needs a maintenance session and this session is not one.';
  end if;
  perform set_config('app.ledger_maintenance', 'on', true);

  create temporary table _gap_fill on commit drop as
  with seg as (
    select guard_id, site_id, client_id, company_id, contract_line_id, post_id,
           start_date, end_date,
           lead(start_date) over (partition by guard_id order by start_date) as next_start,
           lead(site_id)    over (partition by guard_id order by start_date) as next_site
      from public.deployments),
  gap as (
    select guard_id, site_id, client_id, company_id, contract_line_id, post_id,
           end_date + 1 as gap_from,
           next_start - 1 as gap_to
      from seg
     where end_date is not null
       and next_start is not null
       and next_start > end_date + 1
       -- Same site on both sides: this is a hole in one posting, not a move.
       and site_id is not distinct from next_site)
  select g.*,
         (select r.worked_shift
            from public.attendance_records r
           where r.employee_id = g.guard_id
             and r.attendance_date between g.gap_from and g.gap_to
             and r.worked_shift is not null
           group by r.worked_shift
           order by count(*) desc, r.worked_shift
           limit 1) as fill_shift
    from gap g
   where exists (select 1 from public.attendance_records r
                  where r.employee_id = g.guard_id
                    and r.attendance_date between g.gap_from and g.gap_to);

  select count(*) into v_gaps from _gap_fill;
  if v_gaps = 0 then
    raise notice '0398: no internal deployment gap carries attendance — nothing to fill.';
    return;
  end if;

  -- A gap whose attendance names no shift has nothing to post him to, and
  -- guessing one would be the invention this migration is avoiding.
  if exists (select 1 from _gap_fill where fill_shift is null) then
    raise exception '0398 REFUSED: a gap with attendance has no shift on any of its rows.';
  end if;

  select string_agg(e.full_name || ' ' || g.gap_from || '..' || g.gap_to || ' ' || g.fill_shift, '; '
                    order by e.full_name)
    into v_list
    from _gap_fill g join public.employees e on e.id = g.guard_id;

  insert into public.deployments
    (company_id, guard_id, client_id, contract_line_id, site_id, post_id,
     start_date, end_date, shift_code, reason)
  select g.company_id, g.guard_id, g.client_id, g.contract_line_id, g.site_id, g.post_id,
         g.gap_from, g.gap_to, g.fill_shift, 'shift_change'
    from _gap_fill g;
  get diagnostics v_made = row_count;

  raise notice '0398: filled % deployment gap(s) from the attendance inside them: %', v_made, coalesce(v_list, '(none)');

  if v_made <> v_gaps then
    raise exception '0398 FAILED: % gap(s) needed filling and % segment(s) were written.', v_gaps, v_made;
  end if;

  -- Every day that had attendance in a gap is now covered by a posting. This is
  -- the assertion that matters: the repair is judged by whether the hole is
  -- closed, not by whether the insert ran.
  select count(*) into v_left
    from _gap_fill g
    join public.attendance_records r
      on r.employee_id = g.guard_id
     and r.attendance_date between g.gap_from and g.gap_to
   where not exists (select 1 from public.deployments d
                      where d.guard_id = r.employee_id
                        and d.start_date <= r.attendance_date
                        and (d.end_date is null or d.end_date >= r.attendance_date));
  if v_left <> 0 then
    raise exception '0398 FAILED: % attendance row(s) in the filled gaps still have no posting.', v_left;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- PROVE IT, on the case that prompted this.
--
-- Gulrez Akhtar's 24 July double duty is the reason 0397 left something open.
-- It is asserted by name: the night leg is now on a posted shift, the day leg
-- is the cover, and the changeover to days still happens on the 25th and not
-- earlier — which is what copying the neighbouring segment would have done.
-- ---------------------------------------------------------------------------
do $$
declare v_night int; v_day int; v_25 text;
begin
  select count(*) into v_night
    from public.attendance_records r
    join public.employees e on e.id = r.employee_id
   where e.guard_code = 'GGS-00264'
     and r.attendance_date = date '2026-07-24'
     and r.worked_shift = 'night'
     and exists (select 1 from public.deployments d
                  where d.guard_id = r.employee_id
                    and d.shift_code = 'night'
                    and d.start_date <= r.attendance_date
                    and (d.end_date is null or d.end_date >= r.attendance_date));
  if v_night <> 1 then
    raise exception '0398 FAILED: Gulrez Akhtar 24 July has no posted night shift under it.';
  end if;

  select count(*) into v_day
    from public.attendance_records r
    join public.employees e on e.id = r.employee_id
   where e.guard_code = 'GGS-00264'
     and r.attendance_date = date '2026-07-24'
     and r.status = 'double_duty';
  if v_day <> 2 then
    raise exception '0398 FAILED: Gulrez Akhtar 24 July is no longer a two-row double duty (% row(s)).', v_day;
  end if;

  -- The changeover is not moved. If the gap had been filled from the preceding
  -- one-day `day` cover instead, he would read as a day guard from the 23rd.
  select string_agg(distinct d.shift_code, ',') into v_25
    from public.deployments d join public.employees e on e.id = d.guard_id
   where e.guard_code = 'GGS-00264'
     and d.start_date <= date '2026-07-23'
     and (d.end_date is null or d.end_date >= date '2026-07-23');
  if v_25 is distinct from 'night' then
    raise exception '0398 FAILED: on 23 July Gulrez Akhtar is posted to "%", expected night.', v_25;
  end if;

  raise notice '0398 OK: Gulrez Akhtar 24 July is a double duty on a posted night shift, and the move to days still begins on the 25th.';
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
    raise exception '0398 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
