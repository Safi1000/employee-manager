-- 0461 — The Next Day Task becomes a LIST, and each task can be assigned.
--
-- 0460 stored one free-text Next Day Task per (company, day). The ask that
-- followed: several tasks a day, each either GENERAL (nobody named) or
-- ASSIGNED to one employee — and assignable ONLY to active office staff.
--
-- daily_report_tasks holds one row per task. `assignee_employee_id` null means
-- general. The office-staff rule is enforced at the row, not only by what the
-- picker offers: a picker that lists office staff is a convenience; a trigger
-- that refuses a guard is the rule. Same reason 0279 moved the partner opening
-- lock out of a disabled input.
--
-- "Active office staff" = employees.category = 'office_staff' AND
-- lifecycle_state = 'active'. On-leave staff are not offered and not accepted;
-- if that turns out to be wrong the change is one IN-list in the trigger below.
--
-- The check fires when the assignee is SET or CHANGED, not on every update: a
-- task assigned to someone who later leaves stays a record of who it was given
-- to, and editing its wording must not be refused for that.
--
-- 0460's daily_report_day_notes.next_day_task is carried across as a general
-- task per day (at most one day of data exists) and the table is left in place,
-- no longer written by the screen. DEFERRED: drop daily_report_day_notes once
-- nothing reads it — the screen stops reading it in this same change.

create table if not exists public.daily_report_tasks (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id) on delete cascade,
  report_date          date not null default current_date,
  title                text not null check (length(btrim(title)) > 0),
  assignee_employee_id uuid references public.employees(id) on delete set null,
  sort_order           integer not null default 0,
  updated_by           uuid references auth.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.daily_report_tasks is
  'Next Day Tasks for a daily report: several per (company, day). assignee_employee_id '
  'null = a general task; otherwise an ACTIVE OFFICE STAFF employee, enforced by '
  'trg_bbb_daily_report_tasks_assignee.';

create index if not exists daily_report_tasks_day_idx
  on public.daily_report_tasks (company_id, report_date, sort_order);

alter table public.daily_report_tasks enable row level security;

drop policy if exists company_members on public.daily_report_tasks;
create policy company_members on public.daily_report_tasks
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

drop policy if exists ssa_all on public.daily_report_tasks;
create policy ssa_all on public.daily_report_tasks
  for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());

-- Writing the day's report is roster.edit, as for every other Daily Reports table (0313, 0460).
drop policy if exists perm_write_ins on public.daily_report_tasks;
drop policy if exists perm_write_upd on public.daily_report_tasks;
drop policy if exists perm_write_del on public.daily_report_tasks;
create policy perm_write_ins on public.daily_report_tasks
  as restrictive for insert to authenticated with check (public.has_perm('roster.edit'));
create policy perm_write_upd on public.daily_report_tasks
  as restrictive for update to authenticated
  using (public.has_perm('roster.edit')) with check (public.has_perm('roster.edit'));
create policy perm_write_del on public.daily_report_tasks
  as restrictive for delete to authenticated using (public.has_perm('roster.edit'));

-- The assignee rule. SECURITY DEFINER so the check reads the employee row even
-- for a report writer who cannot view staff records — otherwise RLS would hide
-- the row and every assignment would be refused as "does not exist". It writes
-- nothing, and it compares the employee's company to the task's, so it cannot
-- be used to reach across tenants.
create or replace function public.daily_report_task_assignee_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_company uuid;
  v_category text;
  v_state text;
begin
  if new.assignee_employee_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.assignee_employee_id is not distinct from old.assignee_employee_id then
    return new;
  end if;

  select e.company_id, e.category::text, e.lifecycle_state::text
    into v_company, v_category, v_state
    from public.employees e
   where e.id = new.assignee_employee_id;

  if not found or v_company is distinct from new.company_id then
    raise exception 'Task assignee is not an employee of this company. [daily_report_tasks]'
      using errcode = '23503';
  end if;
  if v_category is distinct from 'office_staff' then
    raise exception 'Next Day Tasks can only be assigned to office staff. [daily_report_tasks]'
      using errcode = '23514';
  end if;
  if v_state is distinct from 'active' then
    raise exception 'Next Day Tasks can only be assigned to ACTIVE office staff (this employee is %). [daily_report_tasks]', v_state
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

-- aaa fills company_id, bbb reads it, zzz audits last.
drop trigger if exists trg_aaa_daily_report_tasks_fill_company on public.daily_report_tasks;
create trigger trg_aaa_daily_report_tasks_fill_company
before insert on public.daily_report_tasks
for each row execute function public.fill_company_id();

drop trigger if exists trg_bbb_daily_report_tasks_assignee on public.daily_report_tasks;
create trigger trg_bbb_daily_report_tasks_assignee
before insert or update on public.daily_report_tasks
for each row execute function public.daily_report_task_assignee_guard();

drop trigger if exists trg_daily_report_tasks_updated_at on public.daily_report_tasks;
create trigger trg_daily_report_tasks_updated_at
before update on public.daily_report_tasks
for each row execute function public.touch_updated_at();

drop trigger if exists trg_zzz_daily_report_tasks_audit on public.daily_report_tasks;
create trigger trg_zzz_daily_report_tasks_audit
after insert or update or delete on public.daily_report_tasks
for each row execute function public.log_audit_change();

-- Carry 0460's single note across as a general task. Guarded by NOT EXISTS so a
-- replay does not duplicate it.
insert into public.daily_report_tasks (company_id, report_date, title, sort_order, updated_by)
select n.company_id, n.report_date, btrim(n.next_day_task), 0, n.updated_by
  from public.daily_report_day_notes n
 where length(btrim(coalesce(n.next_day_task, ''))) > 0
   and not exists (
     select 1 from public.daily_report_tasks t
      where t.company_id = n.company_id and t.report_date = n.report_date
   );

comment on table public.daily_report_day_notes is
  'SUPERSEDED by daily_report_tasks (0461); no longer written or read by the screen. '
  'DEFERRED: drop once confirmed unused.';

-- Tail of scripts/migration-template.sql.
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
