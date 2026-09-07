-- 0342 — "Clear Marks" on the Monthly Board: revert a day (or a whole month for
-- one employee) to the true UNMARKED state by DELETING its attendance_records
-- rows, with an audit trail. Unmarked = no row (there is no blank status), so
-- clearing is a delete, not a status change.
--
-- The Monthly Board only shows CONFIRMED, month-ended marks, and
-- enforce_confirmed_month_end_lock refuses a plain DELETE of exactly those
-- (it hard-codes override=false for deletes). Override gets past it by upserting
-- supervisor_override=true; a delete can't carry a flag. So the clear RPCs set a
-- transaction-local marker `app.attendance_clear` and that lock is taught to
-- honour it — the same sanctioned authority Override already has.
--
-- The OPS-VERIFIED lock (enforce_attendance_month_lock) is deliberately NOT
-- bypassed: clearing a verified month still requires Un-verify first, exactly
-- like Override.

-- 1) Teach the confirmed-month-end lock to allow a sanctioned clear. Restated
-- from the live definition (fetched 2026-09) with ONLY the extra bypass clause
-- added, so no prior edit is lost.
create or replace function public.enforce_confirmed_month_end_lock()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_emp uuid; v_date date; v_shift text; v_client uuid; v_cat text; v_override boolean;
begin
  if public.is_maintenance_session()
     or coalesce(current_setting('app.attendance_clear', true), '') = 'on' then
    return case when TG_OP='DELETE' then OLD else NEW end;
  end if;
  if TG_OP='DELETE' then
    v_emp:=OLD.employee_id; v_date:=OLD.attendance_date; v_shift:=OLD.worked_shift; v_override:=false;
  else
    v_emp:=NEW.employee_id; v_date:=NEW.attendance_date; v_shift:=NEW.worked_shift;
    v_override:=coalesce(NEW.supervisor_override,false);
  end if;
  if v_override then return case when TG_OP='DELETE' then OLD else NEW end; end if;
  if (date_trunc('month', v_date) + interval '1 month')::date > current_date then
    return case when TG_OP='DELETE' then OLD else NEW end;
  end if;
  select client_id, category into v_client, v_cat from public.employees where id=v_emp;
  if exists (
    select 1 from public.attendance_confirmations c
    where c.attendance_date=v_date and c.shift_code=v_shift
      and ((v_client is not null and c.client_id=v_client)
           or (v_client is null and v_cat is not null and c.category=v_cat))
  ) then
    raise exception 'This shift is confirmed and the month has ended — locked. Edit it via Override on the Monthly Board.';
  end if;
  return case when TG_OP='DELETE' then OLD else NEW end;
end;
$function$;

-- 2) Clear a whole DAY (all shifts, so a double-duty pair goes together and the
-- "exactly two" DD constraints are never left half-satisfied). Audits each row.
create or replace function public.clear_attendance_day(
  p_employee uuid, p_date date, p_reason text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_deleted int; v_client uuid; v_cat text; v_company uuid; r record;
begin
  perform public.require_perm('attendance.edit');
  -- Tenant guard: the employee must belong to the caller's company (SECURITY
  -- DEFINER bypasses RLS, so p_employee is otherwise unscoped). Raises if not.
  perform public.assert_same_company((select company_id from public.employees where id = p_employee));
  perform set_config('app.attendance_clear', 'on', true);  -- tx-local bypass
  select client_id, category, company_id into v_client, v_cat, v_company
    from public.employees where id = p_employee;
  for r in
    select worked_shift, status from public.attendance_records
     where employee_id = p_employee and attendance_date = p_date
  loop
    insert into public.attendance_overrides
      (company_id, client_id, category, employee_id, attendance_date, reason, before_value, after_value, created_by)
    values
      (v_company, v_client, v_cat, p_employee, p_date,
       coalesce(nullif(btrim(p_reason), ''), 'Cleared'), r.status, 'cleared', auth.uid());
  end loop;
  delete from public.attendance_records
   where employee_id = p_employee and attendance_date = p_date;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

-- 3) Clear an employee's WHOLE month.
create or replace function public.clear_attendance_month(
  p_employee uuid, p_month text, p_reason text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_deleted int; v_client uuid; v_cat text; v_company uuid; v_start date; v_end date; r record;
begin
  perform public.require_perm('attendance.edit');
  -- Tenant guard: the employee must belong to the caller's company.
  perform public.assert_same_company((select company_id from public.employees where id = p_employee));
  v_start := (p_month || '-01')::date;
  v_end := (date_trunc('month', v_start) + interval '1 month' - interval '1 day')::date;
  perform set_config('app.attendance_clear', 'on', true);
  select client_id, category, company_id into v_client, v_cat, v_company
    from public.employees where id = p_employee;
  for r in
    select attendance_date, status from public.attendance_records
     where employee_id = p_employee and attendance_date between v_start and v_end
  loop
    insert into public.attendance_overrides
      (company_id, client_id, category, employee_id, attendance_date, reason, before_value, after_value, created_by)
    values
      (v_company, v_client, v_cat, p_employee, r.attendance_date,
       coalesce(nullif(btrim(p_reason), ''), 'Cleared (whole month)'), r.status, 'cleared', auth.uid());
  end loop;
  delete from public.attendance_records
   where employee_id = p_employee and attendance_date between v_start and v_end;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

grant execute on function public.clear_attendance_day(uuid, date, text) to authenticated;
grant execute on function public.clear_attendance_month(uuid, text, text) to authenticated;

-- The clear RPCs scope every read/write by employee_id (a company-scoped key) and
-- resolve company_id from the employee row itself; they never take a company_id
-- from the caller. The detector must still be able to read them: assert clean.
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
