-- 0413: remove August 2026 attendance for the eighteen guards whose separation
-- date was moved back on top of it.
--
-- The defect. `attendance_window_block_reason` refuses a mark on or after
-- `termination_date`, and it works — every row deleted here was LEGAL when it
-- was written. What nothing checks is the other direction: a write to
-- `employees` that moves the cutoff BACKWARDS is never tested against the
-- attendance already recorded past the new date. Two ways it happened:
--
--   • a backdated fire — marked present, then fired with a date days earlier
--     (the Nova Group batch of ten, all fired 2026-08-01 in one sitting on the
--     5th; Dolmen's two, fired 90 seconds apart the same afternoon);
--   • un-fire → mark → re-fire (GGS-00469 Mumtaz Hussain, un-fired 12 Aug with
--     all three dates cleared, marked for 13 days, re-fired 22 Aug back to
--     2026-08-01; GGS-00507 Shahid Ullah, the same cycle inside eight minutes).
--
-- The rows are then invisible where they would be corrected and countable where
-- they become money: `hiddenFromAttendance` (src/app/lib/employmentWindow.ts)
-- drops the guard off the Monthly Board from the cutoff onward, while Payroll's
-- roster filter keys only on `present_days > 0` and puts them on the Fired tab.
--
-- SCOPE — decided by the user, and wider than the defect. Every attendance row
-- from 2026-08-01 onward for these eighteen, not only the 46 rows on or after
-- each person's own cutoff. The extra 42 belong to five guards fired mid-month
-- who did work earlier in August:
--   GGS-00464 Gul Nawaz 12, GGS-00441 Rafaqat Khan 12, GGS-00485 Muhammad
--   Israr 10, GGS-00245 Khan Zeb 5, GGS-00328 Muhammad Zakeer 3.
-- Those five end August with no attendance at all. This was put to the user with
-- those counts named and chosen deliberately; it is recorded here because the
-- row counts alone would otherwise read as a bug in the predicate.
--
-- REVERSIBLE. Every deleted row is copied whole into
-- `attendance_deleted_0413_backup` first. Restoring is an insert from that
-- table under the same maintenance flag. Do not drop it without asking.
--
-- LOCKS. August has ended, so two controls refuse these deletes and both are
-- stepped past deliberately:
--   • enforce_confirmed_month_end_lock — the shifts are confirmed;
--   • enforce_attendance_month_lock — Dolmen City, HMC Taxila, MIU, Emaar DHA
--     ISB and AWT are OPS-verified for 2026-08.
-- `app.ledger_maintenance` clears both, and is gated on the session role being
-- superuser/bypassrls, so it cannot be set from an app session.
--
-- NOT FIXED HERE: the gate itself. A separation write still cannot see the
-- attendance it strands, so this list can grow again tomorrow. DEFERRED — the
-- check belongs on `employees`, refusing a cutoff that would orphan recorded
-- attendance, and it is owed before the next backdated fire.
do $$
declare
  v_expected int;
  v_backed   int;
  v_deleted  int;
  v_left     int;
begin
  -- The eighteen: separated, cutoff in August 2026 or later, and holding at
  -- least one attendance row on or after their own cutoff. Resolved ONCE into a
  -- temp table so the delete and the backup cannot disagree about who is in.
  create temporary table t0413_targets on commit drop as
  select e.id
  from public.employees e
  where e.lifecycle_state::text in ('terminated','fired','left','absconded')
    and coalesce(e.termination_date, e.last_working_day, e.exit_date) >= date '2026-08-01'
    and exists (
      select 1 from public.attendance_records a
      where a.employee_id = e.id
        and a.attendance_date >= coalesce(e.termination_date, e.last_working_day, e.exit_date)
        and a.attendance_date >= date '2026-08-01');

  select count(*) into v_expected
  from public.attendance_records a
  join t0413_targets t on t.id = a.employee_id
  where a.attendance_date >= date '2026-08-01';

  if v_expected <> 88 then
    raise exception '0413: expected 88 rows to delete, found % — the data moved since this was written; re-audit before applying', v_expected;
  end if;

  create table if not exists public.attendance_deleted_0413_backup
    (like public.attendance_records including defaults);

  insert into public.attendance_deleted_0413_backup
  select a.* from public.attendance_records a
  join t0413_targets t on t.id = a.employee_id
  where a.attendance_date >= date '2026-08-01';
  get diagnostics v_backed = row_count;

  if v_backed <> v_expected then
    raise exception '0413: backed up % of % rows — refusing to delete what is not saved', v_backed, v_expected;
  end if;

  -- Both month locks bypass only for a maintenance session; see the header.
  perform set_config('app.ledger_maintenance', 'on', true);

  delete from public.attendance_records a
  using t0413_targets t
  where t.id = a.employee_id
    and a.attendance_date >= date '2026-08-01';
  get diagnostics v_deleted = row_count;

  if v_deleted <> v_expected then
    raise exception '0413: deleted % of % rows', v_deleted, v_expected;
  end if;

  -- Assert the thing that can break: that NOTHING is left, not merely that rows
  -- went away. A count that moved by 88 says nothing about what remains.
  select count(*) into v_left
  from public.attendance_records a
  join t0413_targets t on t.id = a.employee_id
  where a.attendance_date >= date '2026-08-01';

  if v_left <> 0 then
    raise exception '0413: % August rows still stand for the targeted guards', v_left;
  end if;

  raise notice '0413: deleted % rows, backed up to attendance_deleted_0413_backup', v_deleted;
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
