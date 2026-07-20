-- Guard bonuses & tasking upgrade (spec section 17).
--
-- Guard bonuses are SEPARATE from the salaried scheme:
--   * attendance bonus — auto-qualifying from attendance (zero unexcused
--     absences in the period)
--   * retention / long-service milestones
--   * referral bonus — auto-triggered when a referred guard passes probation
--     (links to the §12 recruitment pipeline)
--   * Eid bonus — for all confirmed guards
--
-- Tasking upgrade: the existing Kanban gains priority + completion timestamp
-- (assignee and due date already exist), and "tasks completed on time %" is
-- exposed as an optional KPI feeding the ownership criterion.

-- ===========================================================================
-- 1. Guard bonus ledger
-- ===========================================================================

do $$ begin
  create type public.guard_bonus_type as enum
    ('attendance', 'long_service', 'referral', 'eid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.guard_bonus_status as enum ('accrued', 'approved', 'paid', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.guard_bonuses (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  branch_id     uuid references public.branches(id),
  bonus_type    public.guard_bonus_type not null,
  period_month  date,          -- for attendance / eid; null for one-off milestones
  amount        numeric(16,2) not null default 0,
  status        public.guard_bonus_status not null default 'accrued',
  -- For referral: the guard whose probation pass triggered this bonus.
  referred_employee_id uuid references public.employees(id),
  notes         text,
  paid_payslip_id uuid references public.payslips(id),
  created_at    timestamptz not null default now(),
  -- One of each type per guard per period (a milestone with null period can
  -- recur, so those are excluded from the guard here via a partial index).
  unique (employee_id, bonus_type, period_month)
);

create index if not exists idx_gb_company on public.guard_bonuses(company_id, period_month);
create index if not exists idx_gb_employee on public.guard_bonuses(employee_id);

drop trigger if exists trg_aaa_guard_bonuses_fill_company on public.guard_bonuses;
create trigger trg_aaa_guard_bonuses_fill_company
  before insert on public.guard_bonuses
  for each row execute function public.fill_company_id();

alter table public.guard_bonuses enable row level security;
drop policy if exists "ssa_all" on public.guard_bonuses;
create policy "ssa_all" on public.guard_bonuses for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.guard_bonuses;
create policy "company_members" on public.guard_bonuses for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Region inherited from the employee, like every other guard-linked object.
create or replace function public.inherit_region_guard_bonus()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(new.branch_id, public.region_for_employee(new.employee_id),
                            public.head_office_region(new.company_id));
  return new;
end;
$$;

drop trigger if exists trg_bbb_guard_bonus_region on public.guard_bonuses;
create trigger trg_bbb_guard_bonus_region
  before insert or update of employee_id, company_id on public.guard_bonuses
  for each row execute function public.inherit_region_guard_bonus();

-- ===========================================================================
-- 2. Attendance bonus: accrue for guards with zero unexcused absences in a
--    period. "Absent" is the unexcused status; leave is excused.
-- ===========================================================================

create or replace function public.accrue_attendance_bonuses(
  p_company_id uuid, p_period date, p_amount numeric)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', p_period)::date;
  v_start date := v_month;
  v_end   date := (v_month + interval '1 month - 1 day')::date;
  v_count integer;
begin
  with qualifying as (
    select e.id as employee_id, e.company_id
      from public.employees e
     where e.company_id = p_company_id
       and e.category in ('client', 'reliever')
       and e.lifecycle_state = 'active'
       -- had attendance in the period AND no 'Absent' day
       and exists (select 1 from public.attendance_records a
                    where a.employee_id = e.id
                      and a.attendance_date between v_start and v_end)
       and not exists (select 1 from public.attendance_records a
                        where a.employee_id = e.id
                          and a.attendance_date between v_start and v_end
                          and a.status = 'Absent')
  )
  insert into public.guard_bonuses (company_id, employee_id, bonus_type, period_month, amount)
  select company_id, employee_id, 'attendance', v_month, p_amount from qualifying
  on conflict (employee_id, bonus_type, period_month) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ===========================================================================
-- 3. Referral bonus: auto-triggered when a referred guard PASSES PROBATION.
--    Probation-pass is modelled as reaching active state past the probation
--    end date; the trigger fires on that lifecycle move and credits the
--    referrer named in the §12 recruitment fields.
-- ===========================================================================

create or replace function public.trigger_referral_bonus()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_amount numeric := 0;
begin
  -- Only when a referred guard becomes/stays active past probation, and only
  -- if we know who referred them (an employee on the books).
  if new.referred_by_employee_id is null then return new; end if;
  if new.lifecycle_state <> 'active' then return new; end if;
  if new.probation_end_date is null or new.probation_end_date > current_date then return new; end if;

  -- Idempotent: one referral bonus per referred guard. The conflict target is
  -- the partial referral index (period_month is null here, so the table's
  -- (employee, type, period) unique never matches and must not be used —
  -- re-firing on a later lifecycle update would otherwise error).
  insert into public.guard_bonuses
    (company_id, employee_id, bonus_type, amount, referred_employee_id, notes)
  values (new.company_id, new.referred_by_employee_id, 'referral', v_amount, new.id,
          'Referral: ' || new.full_name || ' passed probation')
  on conflict (referred_employee_id) where bonus_type = 'referral' do nothing;
  return new;
end;
$$;

-- period_month is null for referral, so the unique (employee, type, period)
-- won't dedupe multiple referrals by the same person. Guard that separately:
create unique index if not exists idx_gb_referral_unique
  on public.guard_bonuses (referred_employee_id)
  where bonus_type = 'referral';

drop trigger if exists trg_emp_referral_bonus on public.employees;
create trigger trg_emp_referral_bonus
  after update of lifecycle_state, probation_end_date on public.employees
  for each row execute function public.trigger_referral_bonus();

-- ===========================================================================
-- 4. Eid bonus for all confirmed (active, past probation) guards.
-- ===========================================================================

create or replace function public.accrue_eid_bonuses(
  p_company_id uuid, p_eid_date date, p_amount numeric)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer; v_month date := date_trunc('month', p_eid_date)::date;
begin
  insert into public.guard_bonuses (company_id, employee_id, bonus_type, period_month, amount, notes)
  select e.company_id, e.id, 'eid', v_month, p_amount, 'Eid bonus'
    from public.employees e
   where e.company_id = p_company_id
     and e.category in ('client', 'reliever')
     and e.lifecycle_state = 'active'
     and (e.probation_end_date is null or e.probation_end_date <= current_date)
  on conflict (employee_id, bonus_type, period_month) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ===========================================================================
-- 5. Long-service milestone, weighted to turnover hotspots.
-- ===========================================================================

create or replace function public.accrue_long_service_bonus(
  p_employee_id uuid, p_amount numeric, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_company uuid;
begin
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;
  insert into public.guard_bonuses (company_id, employee_id, bonus_type, amount, notes)
  values (v_company, p_employee_id, 'long_service', p_amount,
          coalesce(p_notes, 'Long-service milestone'))
  returning id into v_id;
  return v_id;
end;
$$;

-- ===========================================================================
-- 6. Tasking upgrade: priority + completion timestamp (assignee & due already
--    exist). Completion time is stamped automatically when status hits done.
-- ===========================================================================

do $$ begin
  create type public.task_priority as enum ('low', 'medium', 'high', 'urgent');
exception when duplicate_object then null; end $$;

alter table public.tasks
  add column if not exists priority     public.task_priority not null default 'medium',
  add column if not exists completed_at  timestamptz;

create or replace function public.stamp_task_completion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Stamp when moving into a done/completed status; clear if reopened.
  if lower(coalesce(new.status,'')) in ('done', 'completed', 'complete') then
    if new.completed_at is null then new.completed_at := now(); end if;
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_task_completion on public.tasks;
create trigger trg_task_completion
  before insert or update of status on public.tasks
  for each row execute function public.stamp_task_completion();

-- "Tasks completed on time %" — optional KPI feeding the ownership criterion.
-- Of an assignee's tasks due in the period, the share completed on or before
-- their due date.
create or replace function public.tasks_on_time_pct(p_assignee_id uuid, p_period date)
returns numeric language sql stable security definer set search_path = public as $$
  with due as (
    select t.* from public.tasks t
     where t.assignee_id = p_assignee_id
       and t.due_date is not null
       and date_trunc('month', t.due_date) = date_trunc('month', p_period)
  )
  select case when count(*) = 0 then null
              else round(100.0 * count(*) filter (
                     where completed_at is not null
                       and completed_at::date <= due_date) / count(*), 1) end
    from due;
$$;

-- Teach the auto dispatcher the tasks_on_time metric (per-assignee, not
-- regional), then register it as an auto KPI in the regional_admin seat. It
-- feeds the ownership criterion at appraisal time.
create or replace function public.compute_kpi_value(
  p_employee_id uuid, p_kpi_definition_id uuid, p_period date)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare
  d        record;
  e        record;
  v_start  date := date_trunc('month', p_period)::date;
  v_end    date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_val    numeric;
begin
  select * into d from public.kpi_definitions where id = p_kpi_definition_id;
  select * into e from public.employees where id = p_employee_id;
  if d.auto_source is null then return null; end if;

  if d.kpi_key = 'vetting_pct' then
    select case when count(*) = 0 then null
                else round(100.0 * count(*) filter (
                       where police_verification_status = 'cleared'
                         and nadra_verisys_status = 'cleared') / count(*), 1) end
      into v_val
      from public.employees g
     where g.company_id = e.company_id
       and (e.branch_id is null or g.branch_id = e.branch_id)
       and g.category in ('client','reliever')
       and g.lifecycle_state in ('active','on_leave');

  elsif d.kpi_key = 'records_completeness' then
    select case when count(*) = 0 then null
                else round(100.0 * count(*) filter (where dc.received) / count(*), 1) end
      into v_val
      from public.employee_document_checklist dc
      join public.employees g on g.id = dc.employee_id
     where g.company_id = e.company_id
       and (e.branch_id is null or g.branch_id = e.branch_id);

  elsif d.kpi_key = 'days_to_invoice' then
    select round(avg(greatest(i.invoice_date - i.period_end, 0)), 1)
      into v_val
      from public.invoices i
     where i.company_id = e.company_id
       and (e.branch_id is null or i.branch_id = e.branch_id)
       and i.invoice_date between v_start and v_end
       and i.period_end is not null;

  elsif d.kpi_key = 'renewal_rate' then
    select case when count(*) = 0 then null
                else round(100.0 * count(*) filter (where c.status = 'active') / count(*), 1) end
      into v_val
      from public.contracts c
      join public.clients cl on cl.id = c.client_id
     where c.company_id = e.company_id
       and (e.branch_id is null or cl.branch_id = e.branch_id);

  elsif d.kpi_key = 'tasks_on_time' then
    v_val := public.tasks_on_time_pct(p_employee_id, p_period);
  end if;

  return v_val;
end;
$$;

insert into public.kpi_definitions
  (company_id, seat, kpi_key, name, unit, direction, target, green_threshold, amber_threshold, auto_source)
select c.id, 'regional_admin', 'tasks_on_time', 'Tasks completed on time', '%',
       'higher_better', 90, 90, 75, 'tasks_on_time'
  from public.companies c
 where not exists (
   select 1 from public.kpi_definitions d
    where d.company_id = c.id and d.seat = 'regional_admin' and d.kpi_key = 'tasks_on_time'
 );
