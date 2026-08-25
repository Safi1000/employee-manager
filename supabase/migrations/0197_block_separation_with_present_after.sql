-- 0197: a separation can't predate days the guard was actually present.
--
-- Firing on the 15th while the guard is marked PRESENT on the 16th–31st is a
-- contradiction — he clearly worked past the "last working day". Block it at the
-- source (record_separation, used by every fire/resign/abscond flow) so no caller
-- can create that state. Present here means a WORKED day (present / double_duty /
-- relief_cover, either vocabulary). Leave or Absent after the date is fine — those
-- aren't worked days — and present ON the last working day itself is fine (that IS
-- his last day). Only present STRICTLY AFTER the last working day is rejected.
create or replace function public.record_separation(p_guard uuid, p_reason separation_reason, p_last_working_day date, p_termination_date date, p_rehire_eligible boolean, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  e public.employees%rowtype;
  v_new_state employee_lifecycle_state;
  v_present_after date;
begin
  select * into e from public.employees where id = p_guard for update;
  if e.id is null then raise exception 'Guard % not found', p_guard; end if;
  if p_last_working_day is null then raise exception 'Last working day is required'; end if;
  if coalesce(trim(p_note),'') = '' then raise exception 'A separation reason/note is required'; end if;

  -- Reject a last working day that leaves worked (present) attendance after it.
  select min(ar.attendance_date) into v_present_after
    from public.attendance_records ar
   where ar.employee_id = p_guard
     and ar.attendance_date > p_last_working_day
     and lower(ar.status) in ('present','double_duty','relief_cover');
  if v_present_after is not null then
    raise exception 'Cannot separate on %: this employee is marked present on % (and possibly later). He worked past that date, so change those days to leave/absent or unmark them, or pick a later last working day.',
      p_last_working_day, v_present_after;
  end if;

  v_new_state := case
    when p_reason = 'absconded' then 'absconded'
    when p_reason in ('termination_misconduct','termination_performance') then 'fired'
    else 'left'
  end::employee_lifecycle_state;

  update public.employees set
    separation_reason   = p_reason,
    last_working_day    = p_last_working_day,
    termination_date    = p_termination_date,
    eligible_for_rehire = p_rehire_eligible,
    exit_reason         = p_note,
    exit_date           = coalesce(p_termination_date, p_last_working_day),
    lifecycle_state     = v_new_state,
    updated_at          = now()
  where id = p_guard;

  insert into public.deployments_overlap_backup_0183
  select d.*, now(), 'posting began after last working day - record_separation'
    from public.deployments d
   where d.guard_id = p_guard and d.end_date is null and d.start_date > p_last_working_day;

  delete from public.deployments
   where guard_id = p_guard and end_date is null and start_date > p_last_working_day;

  update public.deployments
     set end_date = p_last_working_day, reason = 'separation', updated_at = now()
   where guard_id = p_guard and end_date is null;

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, eligible_for_rehire, changed_by, notes)
  values
    (e.company_id, p_guard, e.lifecycle_state, v_new_state,
     'Separation: ' || p_reason::text, p_rehire_eligible, auth.uid(), p_note);
end $function$;
