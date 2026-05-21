-- ============================================================================
-- Relievers fill in for regular staff on a per-day basis and can rotate
-- through different clients across the week. To attribute their cost
-- correctly in the P&L / financial reports, every Present row for a
-- reliever has to record WHICH client they worked for that day. The column
-- is nullable for everyone else (regular staff already have a primary client
-- on the employees table). Status = Absent / Leave keep it NULL.
-- ============================================================================

alter table public.attendance_records
  add column if not exists worked_for_client_id uuid
    references public.clients(id) on delete set null;

create index if not exists attendance_records_worked_for_client_idx
  on public.attendance_records(worked_for_client_id);

-- Defense-in-depth trigger: enforce that a reliever marked Present has a
-- worked_for_client_id, and that non-Present rows don't carry one (so it's
-- not stale on a status flip). For non-reliever employees the column is
-- always cleared (their cost goes to employees.client_id).
create or replace function public.attendance_records_enforce_reliever()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  emp_category text;
begin
  select category::text into emp_category
    from public.employees
   where id = new.employee_id;

  if emp_category = 'reliever' then
    if new.status = 'Present' and new.worked_for_client_id is null then
      raise exception 'Relievers marked Present must record worked_for_client_id'
        using errcode = '23514';
    end if;
    if new.status <> 'Present' then
      new.worked_for_client_id := null;
    end if;
  else
    -- Non-relievers never carry per-day client attribution.
    new.worked_for_client_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_attendance_records_enforce_reliever on public.attendance_records;
create trigger trg_attendance_records_enforce_reliever
  before insert or update on public.attendance_records
  for each row execute function public.attendance_records_enforce_reliever();
