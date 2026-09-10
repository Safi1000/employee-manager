-- 0416: put back the August 2026 attendance 0413 deleted, except the rows that
-- were marked while a fire already stood on the record.
--
-- 0413 deleted 88 August rows for eighteen separated guards and copied every one
-- of them into `attendance_deleted_0413_backup` first, saying so in its header:
-- "REVERSIBLE. Restoring is an insert from that table under the same maintenance
-- flag." This is that insert. The scope 0413 took was wider than its own defect
-- and was chosen deliberately; the user has now narrowed it.
--
-- THE LINE, and it is a different one from 0413's. 0413 keyed on the DATE the
-- row carries against the cutoff the employee now holds. That is the wrong
-- question, because the cutoff is the thing that moved. The question asked here
-- is whether a separation stood on the record at the moment the mark was
-- WRITTEN — `employee_lifecycle_events.changed_at <= attendance_records.marked_at`:
--
--   * marked while the guard was on the books, fire recorded afterwards and
--     backdated on top of it — the mark was legal, the cutoff moved backwards
--     onto it, and 0413's own header calls this the defect. 70 rows. RESTORED.
--   * marked when a fire was already recorded. 18 rows across three guards.
--     NOT restored:
--       GGS-00469 Mumtaz Hussain 13 — fired 4 Aug, un-fired 12 Aug, marked
--         12-15 Aug, re-fired 22 Aug back to 1 Aug;
--       GGS-00507 Shahid Ullah 4 — fired 08:30, marked 08:32-08:37, rehired
--         08:37:59, re-fired 08:38, all on 6 Aug inside eight minutes;
--       GGS-00464 Gul Nawaz 1 — fired 25 Aug, the 3 Aug row marked 9 Sep.
--
-- Mumtaz is the case the line has to be drawn through rather than around. He was
-- ACTIVE at every one of his thirteen marks, so a state-at-the-instant test
-- keeps them; a fire nonetheless stood on his record before they existed. Put to
-- the user with both readings and their row counts named. DECIDED: he goes with
-- the other two. The predicate below is therefore "any prior separation event",
-- not "separated at marked_at", and those are not the same predicate — the
-- difference is exactly his thirteen rows.
--
-- `enforce_attendance_window` HAS NO MAINTENANCE BYPASS, and the other locks do.
-- `enforce_attendance_month_lock`, `enforce_confirmed_month_end_lock` and
-- `enforce_attendance_backfill` all return early for `is_maintenance_session()`;
-- the window trigger calls `attendance_window_block_reason` unconditionally. So
-- the flag 0413 used to step past the month locks does nothing here, and 29 of
-- the 70 rows sit on or after the cutoff their guard now carries and would be
-- refused one at a time. The trigger is disabled for this transaction instead —
-- ACCESS EXCLUSIVE, rolled back whole if anything below raises.
--
-- `trg_attendance_stamp` is disabled for the same span and for a different
-- reason: it overwrites `marked_by_user_id` and `marked_by_role` from the
-- CURRENT session on every insert. Left on, it would stamp all 88 rows with this
-- migration's identity and destroy the provenance the predicate above is read
-- from. A restore has to reinstate the row that was deleted, not a new row that
-- resembles it. Every other trigger stays live and validates the insert.
--
-- CONSEQUENCE, stated because nothing else will state it: those 29 rows are
-- being put back ON OR AFTER their guard's `termination_date`. That is the exact
-- shape 0413 removed, and it is the user's decision — the rows are wanted, the
-- cutoffs are what is wrong. DEFERRED: whether the cutoffs should move forward
-- to match the attendance, or the attendance is right and the window trigger
-- should read the fire's recorded date rather than its effective one. Neither
-- question is answered here and the 29 rows stand until one of them is.
--
-- NOT FIXED HERE, still: the gate 0413 deferred. A separation write cannot see
-- the attendance it strands, so this can happen again tomorrow.
--
-- The backup table is NOT dropped. It is the only copy of the 18 rows this
-- migration declines to restore.
do $$
declare
  v_backup   int;
  v_clash    int;
  v_drop     int;
  v_guards   int;
  v_inserted int;
  v_deleted  int;
  v_left     int;
  v_keepers  int;
  v_stamped  int;
begin
  select count(*) into v_backup from public.attendance_deleted_0413_backup;
  if v_backup <> 88 then
    raise exception '0416: backup holds % rows, expected the 88 0413 saved — re-audit before restoring', v_backup;
  end if;

  -- Nothing may already occupy these rows. Checked on the primary key AND on
  -- (employee_id, attendance_date), because the table carries no unique index on
  -- the pair: a same-day row inserted since 0413 would not collide on insert, it
  -- would silently double the day.
  select count(*) into v_clash
  from public.attendance_records a
  join public.attendance_deleted_0413_backup b
    on b.id = a.id or (b.employee_id = a.employee_id and b.attendance_date = a.attendance_date);
  if v_clash <> 0 then
    raise exception '0416: % row(s) already stand where the backup would land — refusing to double a day', v_clash;
  end if;

  -- The eighteen not to restore, resolved ONCE so the insert, the delete and the
  -- assertions cannot disagree about who is in.
  create temporary table t0416_fired_before_mark on commit drop as
  select b.id, b.employee_id
  from public.attendance_deleted_0413_backup b
  where exists (
    select 1 from public.employee_lifecycle_events le
    where le.employee_id = b.employee_id
      and le.to_state::text in ('terminated','fired','left','absconded')
      and le.changed_at <= b.marked_at);

  select count(*), count(distinct employee_id) into v_drop, v_guards
  from t0416_fired_before_mark;
  if v_drop <> 18 or v_guards <> 3 then
    raise exception '0416: fired-before-mark resolves to % row(s) across % guard(s), expected 18 across 3', v_drop, v_guards;
  end if;

  perform set_config('app.ledger_maintenance', 'on', true);
  alter table public.attendance_records disable trigger trg_attendance_window;
  alter table public.attendance_records disable trigger trg_attendance_stamp;

  insert into public.attendance_records
  select b.* from public.attendance_deleted_0413_backup b;
  get diagnostics v_inserted = row_count;

  -- `trg_one_status_per_day` and `trg_double_duty_is_exactly_two` are DEFERRABLE
  -- INITIALLY DEFERRED, so the insert leaves 88 pending trigger events and
  -- ALTER TABLE refuses to run while any stand (55006). Firing them here is not
  -- a workaround for that error: it is the only point at which the two checks
  -- can be OBSERVED to pass, because at commit their verdict arrives after every
  -- assertion below has already reported success.
  set constraints all immediate;

  alter table public.attendance_records enable trigger trg_attendance_stamp;
  alter table public.attendance_records enable trigger trg_attendance_window;

  if v_inserted <> v_backup then
    raise exception '0416: inserted % of % backed-up rows', v_inserted, v_backup;
  end if;

  delete from public.attendance_records a
  using t0416_fired_before_mark t
  where t.id = a.id;
  get diagnostics v_deleted = row_count;

  if v_deleted <> v_drop then
    raise exception '0416: removed % of the % fired-before-mark rows', v_deleted, v_drop;
  end if;

  -- Assert on the things that can break, not on the count that obviously moved.
  --
  -- One: that the 70 standing are the 70 intended and NOT the 18 — a net of 70
  -- is also what restoring 70 of the wrong rows would report.
  select count(*) into v_keepers
  from public.attendance_records a
  join public.attendance_deleted_0413_backup b on b.id = a.id
  where not exists (select 1 from t0416_fired_before_mark t where t.id = a.id);
  if v_keepers <> 70 then
    raise exception '0416: % of the 70 keepers are standing', v_keepers;
  end if;

  select count(*) into v_left
  from public.attendance_records a
  join t0416_fired_before_mark t on t.id = a.id;
  if v_left <> 0 then
    raise exception '0416: % fired-before-mark row(s) still stand', v_left;
  end if;

  -- Two: that the restore reinstated the rows rather than re-authored them. If
  -- trg_attendance_stamp had been live, marked_by_user_id and marked_by_role
  -- would carry this session's identity and the count below would be 70.
  select count(*) into v_stamped
  from public.attendance_records a
  join public.attendance_deleted_0413_backup b on b.id = a.id
  where a.marked_at is distinct from b.marked_at
     or a.marked_by_user_id is distinct from b.marked_by_user_id
     or a.marked_by_role is distinct from b.marked_by_role;
  if v_stamped <> 0 then
    raise exception '0416: % restored row(s) lost their original marker — the stamp trigger fired', v_stamped;
  end if;

  raise notice '0416: restored % rows, withheld % marked after a standing fire', v_keepers, v_drop;
end $$;

-- Both triggers must be back on. Asserted separately from the block that
-- re-enables them: a disabled control that nothing checks is the failure this
-- project exists to remove, and `tgenabled` is one catalogue read away.
do $$
declare v_off text;
begin
  select string_agg(tgname, ', ') into v_off
  from pg_trigger
  where tgrelid = 'public.attendance_records'::regclass
    and not tgisinternal and tgenabled = 'D';
  if v_off is not null then
    raise exception 'REFUSED: attendance_records left with disabled trigger(s): %', v_off;
  end if;
end $$;

-- TENANT GUARD ASSERTION NOT APPLICABLE: this migration defines no function and
-- adds no parameter, so it introduces no guard to gap. The detector is asserted
-- anyway — a green run is evidence about the database, not only about this file.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
