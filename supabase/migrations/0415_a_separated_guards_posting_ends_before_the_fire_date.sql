-- 0415 — a separated guard's posting ends the day BEFORE the fire date, and the
--        last working day is the day before it. One-time backfill.
--
-- THE RULE (Shayan, 2026-09-10). "Last working day = fire date − 1." The date a
-- user enters when firing is the EFFECTIVE (fire) date — termination_date, the
-- day the separation takes effect and the post falls vacant. The guard's last
-- working day is the day before it, and the slot is free FROM the fire date on,
-- so a replacement can start that very day.
--
-- THE DEFECT, in two shapes, both of which keep a fired guard occupying the slot
-- on (and sometimes long past) the fire date, so the next hire is refused by
-- enforce_deployment_slot_free (0408):
--
--   A. EQUAL DATES. The old Fire modal stored the picked date as BOTH
--      last_working_day AND termination_date, and record_separation closes the
--      posting at end_date = last_working_day. So the posting covers the fire
--      date itself. (219 guards; none of them have a worked attendance mark on
--      that date — the date was the fire date, not a day worked.)
--
--   B. POSTING RAN PAST SEPARATION. Editing a guard's separation dates on
--      Assignment & Pay AFTER firing does not re-close the posting, so end_date
--      is left wherever it was — e.g. GGS-00511 Muhammad Adnan, fired 23 Aug,
--      last present 21 Aug, posting still ending 21 SEP. This one already fixed
--      by hand to unblock a hire; the backfill re-asserts it.
--
-- The forward fix is already in the app (FireGuardModal now passes fire_date−1
-- as last_working_day), so this is a one-time correction of history.
--
-- SCOPE. Every separated guard (fired/left/absconded) with a termination_date,
-- EXCEPT the 7 who carry a worked attendance mark (present/double_duty/
-- relief_cover) on or after their own termination_date. Those are the backdated-
-- fire / un-fire→mark→re-fire anomalies 0413 is about; moving their cutoff would
-- strand real work, so they are left for that path and NOT touched here.
--
-- For each in-scope guard, target last working day = termination_date − 1:
--   • last_working_day        → target                                 (217)
--   • posting end_date, where it is open or reaches the fire date, and
--     the posting started on or before target                          (185)
--   • posting DELETED, where it would invert (start_date > target — the
--     guard was deployed and fired the same day and never worked it)     (16)
-- A historical closed segment (end_date already before the fire date) is left
-- alone.
--
-- NO ATTENDANCE MOVES. termination_date is unchanged, and the in-scope guards
-- have zero attendance rows on/after it (verified against
-- purge_attendance_after_separation's own predicate), so the purge trigger that
-- fires on the last_working_day update deletes nothing.
--
-- REVERSIBLE. Every old value is copied to public.deployment_dates_backup_0415
-- first — old last_working_day, old end_date, and the full row of each deleted
-- posting. Do not drop it without asking.
do $$
declare
  v_emp int; v_dep_upd int; v_dep_del int; v_bad_cover int; v_inverted int;
begin
  -- Resolve the in-scope set ONCE so backup, update and delete cannot disagree.
  create temporary table t0415 on commit drop as
  select e.id, e.company_id, e.termination_date, (e.termination_date - 1) as target_lwd
  from public.employees e
  where e.lifecycle_state in ('fired','left','absconded')
    and e.termination_date is not null
    and not exists (
      select 1 from public.attendance_records ar
      where ar.employee_id = e.id
        and ar.attendance_date >= e.termination_date
        and lower(ar.status) in ('present','double_duty','relief_cover'));

  create table if not exists public.deployment_dates_backup_0415 (
    kind text, row_id uuid, old_json jsonb, backed_up_at timestamptz default now());

  insert into public.deployment_dates_backup_0415(kind,row_id,old_json)
  select 'emp_lwd', e.id, jsonb_build_object('last_working_day', e.last_working_day)
  from public.employees e join t0415 t on t.id = e.id
  where e.last_working_day is distinct from t.target_lwd;

  insert into public.deployment_dates_backup_0415(kind,row_id,old_json)
  select 'dep_end', d.id, jsonb_build_object('end_date', d.end_date)
  from public.deployments d join t0415 t on t.id = d.guard_id
  where (d.end_date is null or d.end_date >= t.termination_date)
    and d.start_date <= t.target_lwd;

  insert into public.deployment_dates_backup_0415(kind,row_id,old_json)
  select 'dep_deleted', d.id, to_jsonb(d)
  from public.deployments d join t0415 t on t.id = d.guard_id
  where (d.end_date is null or d.end_date >= t.termination_date)
    and d.start_date > t.target_lwd;

  -- 1. last working day = fire date − 1
  update public.employees e set last_working_day = t.target_lwd
  from t0415 t
  where t.id = e.id and e.last_working_day is distinct from t.target_lwd;
  get diagnostics v_emp = row_count;

  -- 2. postings open or reaching the fire date, that started before target: end
  --    them the day before the fire date.
  update public.deployments d set end_date = t.target_lwd
  from t0415 t
  where t.id = d.guard_id
    and (d.end_date is null or d.end_date >= t.termination_date)
    and d.start_date <= t.target_lwd;
  get diagnostics v_dep_upd = row_count;

  -- 3. zero-day postings that would invert: the guard never worked a day here.
  delete from public.deployments d
  using t0415 t
  where t.id = d.guard_id
    and (d.end_date is null or d.end_date >= t.termination_date)
    and d.start_date > t.target_lwd;
  get diagnostics v_dep_del = row_count;

  -- Assert the thing that can break: no in-scope guard's posting still covers
  -- their own fire date. (Not "N rows changed" — that was never in doubt.)
  select count(*) into v_bad_cover
  from public.deployments d join t0415 t on t.id = d.guard_id
  where d.start_date <= t.termination_date
    and (d.end_date is null or d.end_date >= t.termination_date);
  if v_bad_cover <> 0 then
    raise exception '0415 REFUSED: % separated-guard posting(s) still cover the fire date.', v_bad_cover;
  end if;

  select count(*) into v_inverted from public.deployments where end_date < start_date;
  if v_inverted <> 0 then
    raise exception '0415 REFUSED: % inverted deployment segment(s) after the repair.', v_inverted;
  end if;

  raise notice '0415: % employee last-working-days corrected, % postings shortened, % zero-day postings deleted.',
    v_emp, v_dep_upd, v_dep_del;
end $$;

-- The tenant guard assertion required of every migration. This file adds no
-- function and no parameter, so it opens no gap of its own; a green run here is
-- evidence about the database.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0415 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
