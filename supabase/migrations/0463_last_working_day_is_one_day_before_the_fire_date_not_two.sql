-- 0463 — a separated guard's last working day is fire date − 1, not − 2.
--        One-time backfill, plus one named correction (GGS-00304).
--
-- THE DEFECT. FireGuardModal computed "fire date − 1" as
--   new Date(date + "T00:00:00")  → LOCAL midnight
--   .setDate(getDate() - 1)
--   .toISOString().slice(0, 10)   → read back in UTC
-- In Pakistan (UTC+5) local midnight on the 8th is 19:00 UTC on the 7th, so
-- "fired on the 9th" sent p_last_working_day = the 7th. record_separation stores
-- it verbatim and closes the posting at it, so the 8th — a day the guard was
-- still employed — could not be marked. The app now does the arithmetic in UTC.
--
-- SCOPE. Every separated guard whose last_working_day is EXACTLY
-- termination_date − 2 — the bug's signature (17 on prod, fired 1 Aug – 19 Sep).
-- The 10 older rows with last_working_day = termination_date are the 0413/0415
-- anomalies and are NOT this defect; they are left alone.
--
-- For each: last_working_day → termination_date − 1, and the posting that the
-- separation closed at the old last working day is extended to the new one.
-- Extending an end date re-runs neither enforce_deployment_slot_free (it skips an
-- update whose start did not move earlier) nor raise_vacancy_on_posting_close
-- (null → date only). The purge trigger's cutoff moves LATER, so it deletes
-- nothing; asserted below anyway.
--
-- GGS-00304 Ali Asghar (legacy MIU-019). Recorded as fired but ineligible for
-- rehire, which is what makes the app label him "Terminated". Per the user
-- (2026-09-21): that was wrong — he is fired, and eligible for rehire.
do $$
declare
  v_emp int; v_dep int; v_bad int; v_att_before int; v_att_after int; v_ali int;
begin
  create temporary table t0463 on commit drop as
  select e.id, e.last_working_day as old_lwd, (e.termination_date - 1) as new_lwd
  from public.employees e
  where e.lifecycle_state in ('fired','left','absconded','terminated')
    and e.termination_date is not null
    and e.last_working_day = e.termination_date - 2;

  select count(*) into v_att_before
    from public.attendance_records ar join t0463 t on t.id = ar.employee_id;

  update public.deployments d set end_date = t.new_lwd
  from t0463 t
  where d.guard_id = t.id and d.end_date = t.old_lwd;
  get diagnostics v_dep = row_count;

  update public.employees e set last_working_day = t.new_lwd
  from t0463 t
  where e.id = t.id;
  get diagnostics v_emp = row_count;

  -- The thing that can break: a guard still two days short, or a posting still
  -- ending at the old day.
  select count(*) into v_bad
    from public.employees e join t0463 t on t.id = e.id
   where e.last_working_day <> e.termination_date - 1
      or exists (select 1 from public.deployments d where d.guard_id = t.id and d.end_date = t.old_lwd);
  if v_bad <> 0 then
    raise exception '0463 REFUSED: % guard(s) still end before fire date − 1.', v_bad;
  end if;

  select count(*) into v_att_after
    from public.attendance_records ar join t0463 t on t.id = ar.employee_id;
  if v_att_after <> v_att_before then
    raise exception '0463 REFUSED: attendance rows changed (% → %).', v_att_before, v_att_after;
  end if;

  update public.employees set eligible_for_rehire = true, updated_at = now()
   where employee_code = 'GGS-00304' and legacy_code = 'MIU-019'
     and lifecycle_state = 'fired' and eligible_for_rehire = false;
  get diagnostics v_ali = row_count;
  -- Replay-safe: already corrected counts as done.
  if v_ali <> 1 and not exists (select 1 from public.employees
       where employee_code = 'GGS-00304' and lifecycle_state = 'fired' and eligible_for_rehire) then
    raise exception '0463 REFUSED: expected to correct exactly 1 row for GGS-00304, got %.', v_ali;
  end if;

  raise notice '0463: % last working days moved to fire date − 1, % postings extended; GGS-00304 made rehire-eligible.',
    v_emp, v_dep;
end $$;

-- The tenant guard assertion required of every migration.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0463 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
