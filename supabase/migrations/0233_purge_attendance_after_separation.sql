-- 0233: Recover `purge_attendance_after_separation` and its trigger.
--
-- Applied to production but never committed — the same pattern
-- docs/MIGRATION_DIVERGENCE.md describes. It was the one function still missing
-- when the repo was replayed into an empty database: prod carries 271 functions
-- in `public`, the repo produced 270.
--
-- What it does: when an employee's last working day or termination date is set
-- or moved, attendance marked after that date is deleted. It deliberately spares
-- any month that is already closed (accounting_periods) or already verified
-- (attendance_month_verifications), so a separation entered late cannot rewrite
-- a signed-off month.
--
-- Reproduced verbatim from production.

create or replace function public.purge_attendance_after_separation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare cutoff date;
begin
  cutoff := least(
    coalesce(new.last_working_day, 'infinity'::date),
    coalesce(new.termination_date - 1, 'infinity'::date)
  );
  if cutoff = 'infinity'::date then return new; end if;
  if coalesce(old.last_working_day,'infinity'::date) = coalesce(new.last_working_day,'infinity'::date)
     and coalesce(old.termination_date,'infinity'::date) = coalesce(new.termination_date,'infinity'::date)
  then return new; end if;

  delete from attendance_records a
  where a.employee_id = new.id
    and a.attendance_date > cutoff
    and not exists (select 1 from accounting_periods ap
                    where ap.company_id = new.company_id
                      and ap.period_month = date_trunc('month', a.attendance_date)::date)
    and not exists (select 1 from attendance_month_verifications v
                    where v.period_month = date_trunc('month', a.attendance_date)::date
                      and (v.client_id = new.client_id
                           or (v.category is not null and v.category = new.category::text)));
  return new;
end $function$;

drop trigger if exists trg_purge_attendance_after_separation on public.employees;
create trigger trg_purge_attendance_after_separation
  after update of last_working_day, termination_date on public.employees
  for each row execute function public.purge_attendance_after_separation();
