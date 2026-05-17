-- ============================================================================
-- ADDITIVE migration.
-- employees.branch_id stays as the PRIMARY branch (cost/payroll routing).
-- New employee_branches junction holds ADDITIONAL visibility-only branches.
-- A branched user can see an employee if it's the primary OR appears in the
-- junction. P&L / cashflow / per-record routing keep using primary.
-- ============================================================================

create table if not exists public.employee_branches (
  employee_id uuid not null references public.employees(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (employee_id, branch_id)
);

create index if not exists employee_branches_branch_idx on public.employee_branches(branch_id);

alter table public.employee_branches enable row level security;

drop policy if exists "ssa_all" on public.employee_branches;
create policy "ssa_all" on public.employee_branches for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.employee_branches;
create policy "company_members" on public.employee_branches for all
  using (exists (
    select 1 from public.employees e
     where e.id = employee_branches.employee_id
       and e.company_id = public.current_company_id()
  ))
  with check (exists (
    select 1 from public.employees e
     where e.id = employee_branches.employee_id
       and e.company_id = public.current_company_id()
  ));

-- Branched users can manage junction rows only for branches they belong to.
drop policy if exists "branch_scope" on public.employee_branches;
create policy "branch_scope" on public.employee_branches as restrictive for all
  using (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id())
  with check (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id());

-- Extend branch_scope on employees: visible if primary == current OR
-- junction has a row for current_branch.
drop policy if exists "branch_scope" on public.employees;
create policy "branch_scope" on public.employees as restrictive for all
  using (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id()
    or exists (
      select 1 from public.employee_branches eb
       where eb.employee_id = employees.id
         and eb.branch_id = public.current_branch_id()
    ))
  with check (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id()
    or exists (
      select 1 from public.employee_branches eb
       where eb.employee_id = employees.id
         and eb.branch_id = public.current_branch_id()
    ));

-- Helper: does the current branched user have access to a given employee?
create or replace function public.user_can_see_employee(p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not public.is_branched_user()
      or public.is_super_super_admin()
      or exists (
        select 1 from public.employees e
         where e.id = p_employee
           and (e.branch_id = public.current_branch_id()
                or exists (
                  select 1 from public.employee_branches eb
                   where eb.employee_id = e.id
                     and eb.branch_id = public.current_branch_id()
                ))
      );
$$;

-- Update the attendance_records / employee_documents / payslips / advances
-- branch_scope to use the helper (visible if employee accessible).
do $$
declare t text;
begin
  foreach t in array array['attendance_records', 'employee_documents', 'payslips']
  loop
    execute format('drop policy if exists "branch_scope" on public.%I', t);
    execute format(
      'create policy "branch_scope" on public.%I as restrictive for all
         using (not public.is_branched_user() or public.is_super_super_admin()
                or public.user_can_see_employee(%I.employee_id))
         with check (not public.is_branched_user() or public.is_super_super_admin()
                or public.user_can_see_employee(%I.employee_id))',
      t, t, t);
  end loop;
end $$;

-- Advances: extend the existing branch_scope (which also has branch_id column)
-- to additionally allow when the employee is visible.
drop policy if exists "branch_scope" on public.advances;
create policy "branch_scope" on public.advances as restrictive for all
  using (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id()
    or public.user_can_see_employee(advances.employee_id))
  with check (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id()
    or public.user_can_see_employee(advances.employee_id));
