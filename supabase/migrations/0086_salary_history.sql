-- Salary history as a first-class record (spec section 13).
--
-- "Salary history becomes first-class: every change stored with effective date
-- & reason; increments apply by date."
--
-- Today an employee's salary is a single mutable pair (base_salary, allowance)
-- with no memory of what it was or when it changed. This adds an effective-
-- dated history and makes it the source of truth: a payroll run for a given
-- month reads the salary that was in force THAT month, so a mid-year increment
-- applies from its effective date rather than retroactively to closed periods.

create table if not exists public.employee_salary_history (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  employee_id    uuid not null references public.employees(id) on delete cascade,
  effective_date date not null,
  base_salary    numeric(16,2),
  allowance      numeric(16,2) not null default 0,
  per_day_salary numeric(16,2),
  reason         text,
  changed_by     uuid,
  created_at     timestamptz not null default now(),
  -- One salary record per employee per effective date; a correction replaces
  -- rather than stacks.
  unique (employee_id, effective_date)
);

create index if not exists idx_esh_employee on public.employee_salary_history(employee_id, effective_date);

drop trigger if exists trg_aaa_esh_fill_company on public.employee_salary_history;
create trigger trg_aaa_esh_fill_company
  before insert on public.employee_salary_history
  for each row execute function public.fill_company_id();

alter table public.employee_salary_history enable row level security;
drop policy if exists "ssa_all" on public.employee_salary_history;
create policy "ssa_all" on public.employee_salary_history for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.employee_salary_history;
create policy "company_members" on public.employee_salary_history for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- Seed one baseline row per employee from the current salary. Effective from
-- the join date (or, failing that, the record's creation) so history covers
-- the whole tenure.
-- ---------------------------------------------------------------------------

insert into public.employee_salary_history
  (company_id, employee_id, effective_date, base_salary, allowance, per_day_salary, reason)
select e.company_id, e.id,
       coalesce(e.join_date, e.created_at::date),
       e.base_salary, coalesce(e.allowance, 0), e.per_day_salary,
       'Baseline (migrated from current salary)'
  from public.employees e
 where not exists (
   select 1 from public.employee_salary_history h where h.employee_id = e.id
 );

-- ---------------------------------------------------------------------------
-- The salary in force on a given date: the latest record effective on or
-- before it. This is what a payroll run consults for its period.
-- ---------------------------------------------------------------------------

create or replace function public.effective_salary(p_employee_id uuid, p_as_of date)
returns table (base_salary numeric, allowance numeric, per_day_salary numeric, effective_date date)
language sql stable security definer set search_path = public as $$
  select h.base_salary, h.allowance, h.per_day_salary, h.effective_date
    from public.employee_salary_history h
   where h.employee_id = p_employee_id
     and h.effective_date <= p_as_of
   order by h.effective_date desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- The blessed way to change pay: records history AND, when the change takes
-- effect on or before today, updates the live employee row. A future-dated
-- increment is stored but does not touch current pay until its date arrives
-- (a scheduled run would apply it, or the next call on/after the date).
-- ---------------------------------------------------------------------------

create or replace function public.set_employee_salary(
  p_employee_id    uuid,
  p_effective_date date,
  p_base_salary    numeric,
  p_allowance      numeric default 0,
  p_per_day_salary numeric default null,
  p_reason         text default null
)
returns void language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  insert into public.employee_salary_history
    (company_id, employee_id, effective_date, base_salary, allowance, per_day_salary, reason, changed_by)
  values
    (v_company, p_employee_id, p_effective_date, p_base_salary,
     coalesce(p_allowance, 0), p_per_day_salary, p_reason, auth.uid())
  on conflict (employee_id, effective_date) do update set
    base_salary = excluded.base_salary,
    allowance   = excluded.allowance,
    per_day_salary = excluded.per_day_salary,
    reason      = excluded.reason,
    changed_by  = excluded.changed_by;

  -- Only apply to the live row if this change is already in effect and it is
  -- the most recent effective change (a back-dated correction before a later
  -- raise must not clobber the current, higher, salary).
  if p_effective_date <= current_date
     and p_effective_date = (
       select max(effective_date) from public.employee_salary_history
        where employee_id = p_employee_id and effective_date <= current_date
     ) then
    update public.employees set
      base_salary = p_base_salary,
      allowance   = coalesce(p_allowance, 0),
      per_day_salary = coalesce(p_per_day_salary, per_day_salary),
      updated_at = now()
    where id = p_employee_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Safety net: a direct edit to base_salary/allowance still leaves a history
-- trail, so the record can never silently diverge from the employee row even
-- when someone bypasses set_employee_salary.
-- ---------------------------------------------------------------------------

create or replace function public.capture_salary_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare eff record;
begin
  if tg_op <> 'UPDATE'
     or (new.base_salary is not distinct from old.base_salary
         and new.allowance is not distinct from old.allowance
         and new.per_day_salary is not distinct from old.per_day_salary) then
    return new;
  end if;

  -- If history already carries this exact salary as the one in force today,
  -- the change came through set_employee_salary (which records history first).
  -- Don't stamp a redundant today-dated row over a possibly back-dated one.
  select * into eff from public.effective_salary(new.id, current_date);
  if found
     and eff.base_salary is not distinct from new.base_salary
     and eff.allowance   is not distinct from coalesce(new.allowance, 0)
     and eff.per_day_salary is not distinct from new.per_day_salary then
    return new;
  end if;

  -- Otherwise this was a direct edit that bypassed set_employee_salary; keep
  -- the trail so history can never silently diverge from the employee row.
  insert into public.employee_salary_history
    (company_id, employee_id, effective_date, base_salary, allowance, per_day_salary, reason, changed_by)
  values
    (new.company_id, new.id, current_date, new.base_salary, coalesce(new.allowance, 0),
     new.per_day_salary, 'Direct edit', auth.uid())
  on conflict (employee_id, effective_date) do update set
    base_salary = excluded.base_salary,
    allowance   = excluded.allowance,
    per_day_salary = excluded.per_day_salary;
  return new;
end;
$$;

drop trigger if exists trg_emp_capture_salary on public.employees;
create trigger trg_emp_capture_salary
  after update of base_salary, allowance, per_day_salary on public.employees
  for each row execute function public.capture_salary_change();
