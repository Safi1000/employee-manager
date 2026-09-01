create or replace function public.enforce_attendance_backfill()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  e  record;
  lb date;
  ub date;
begin
  if public.is_maintenance_session() then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  select em.join_date, em.exit_date, c.start_date as c_start, c.end_date as c_end
    into e
    from public.employees em
    left join public.contracts c on c.id = em.contract_id
   where em.id = new.employee_id;

  lb := greatest(e.join_date, e.c_start);
  ub := least(e.c_end, e.exit_date);

  if lb is not null and new.attendance_date < lb then
    raise exception
      'attendance for % is before this guard''s service window (starts %)', new.attendance_date, lb
      using errcode = '23514';
  end if;
  if ub is not null and new.attendance_date > ub then
    raise exception
      'attendance for % is after this guard''s service window (ends %)', new.attendance_date, ub
      using errcode = '23514';
  end if;

  -- An explicit supervisor override (Confirm / Monthly Board override) is an
  -- authorised late entry — it clears the backdate lock without the permission.
  if coalesce(new.supervisor_override, false) then
    return new;
  end if;

  if coalesce(current_setting('app.skip_attendance_lock', true), '') = '1' then
    return new;
  end if;

  if public.is_attendance_locked(new.company_id, new.attendance_date)
     and not public.has_perm('attendance.backdate') then
    raise exception
      'backdating attendance to % requires the Backdate Attendance permission', new.attendance_date
      using errcode = '23514';
  end if;

  return new;
end;
$function$;