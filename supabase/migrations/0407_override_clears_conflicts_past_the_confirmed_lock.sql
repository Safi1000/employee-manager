-- 0407 — the Monthly Board Override could not clear a confirmed day.
--
-- An Override marks a cell by DELETING whatever contradicts the new mark and then
-- upserting the mark with supervisor_override=true. The upsert bypasses
-- enforce_confirmed_month_end_lock (it reads NEW.supervisor_override); the DELETE
-- does not — that trigger hard-codes override=false for DELETE, because a bare
-- delete carries no flag. So overriding a confirmed, month-ended day TO Leave
-- (which deletes the confirmed worked row) — or overriding when a confirmed leave
-- row must be cleared first — was refused with the very lock message the operator
-- was using Override to get past.
--
-- The sanctioned way past that lock already exists: the tx-local marker
-- app.attendance_clear that 0405's clear RPCs set. A browser cannot set it across
-- a separate PostgREST DELETE, so the Override's conflict-clear moves server-side
-- into this RPC, which carries the same authority. Only the Override flow calls
-- it; plain Bulk/Board marking keeps deleting directly and stays correctly locked.
--
-- Mirrors clearConflictingDayRows (src/app/lib/attendanceDay.ts): p_leave_only
-- deletes only leave rows (a worked/double-duty override must not disturb a DD
-- sibling); otherwise the whole day goes (a leave admits no company). Leave-ness
-- is attendance_status_is_leave(), the one definition the board already uses.
-- Does NOT bypass the OPS-verified lock: a verified month still needs Un-verify.
create or replace function public.clear_attendance_conflicts(
  p_employee uuid, p_date date, p_leave_only boolean, p_reason text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_deleted int; v_client uuid; v_cat text; v_company uuid; r record;
begin
  perform public.require_perm('attendance.edit');
  -- Tenant guard: the employee must belong to the caller's company.
  perform public.assert_same_company((select company_id from public.employees where id = p_employee));
  perform set_config('app.attendance_clear', 'on', true);  -- tx-local bypass
  select client_id, category, company_id into v_client, v_cat, v_company
    from public.employees where id = p_employee;
  for r in
    select worked_shift, status from public.attendance_records
     where employee_id = p_employee and attendance_date = p_date
       and (not p_leave_only or public.attendance_status_is_leave(status))
  loop
    insert into public.attendance_overrides
      (company_id, client_id, category, employee_id, attendance_date, reason, before_value, after_value, created_by)
    values
      (v_company, v_client, v_cat, p_employee, p_date,
       coalesce(nullif(btrim(p_reason), ''), 'Cleared for override'), r.status, 'cleared', auth.uid());
  end loop;
  delete from public.attendance_records
   where employee_id = p_employee and attendance_date = p_date
     and (not p_leave_only or public.attendance_status_is_leave(status));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

grant execute on function public.clear_attendance_conflicts(uuid, date, boolean, text) to authenticated;

-- Same tenant-guard assertion every migration carries; the new RPC is guarded by
-- assert_same_company on its p_employee, so the detector must read clean.
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
