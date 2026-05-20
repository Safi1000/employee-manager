-- ============================================================================
-- BUG FIX: infinite recursion in employee_branches <-> employees RLS policies.
-- The previous policies had direct EXISTS subqueries against the other table,
-- each of which re-evaluated the other table's policies, looping forever.
-- Replace with SECURITY DEFINER helpers that bypass RLS for the membership
-- and company lookups.
-- ============================================================================

create or replace function public.employee_in_branch(p_employee uuid, p_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.employee_branches
     where employee_id = p_employee
       and branch_id = p_branch
  );
$$;

create or replace function public.employee_company_id(p_employee uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from public.employees where id = p_employee;
$$;

grant execute on function public.employee_in_branch(uuid, uuid) to authenticated;
grant execute on function public.employee_company_id(uuid) to authenticated;

drop policy if exists "company_members" on public.employee_branches;
create policy "company_members" on public.employee_branches for all
  using (public.employee_company_id(employee_branches.employee_id) = public.current_company_id())
  with check (public.employee_company_id(employee_branches.employee_id) = public.current_company_id());

drop policy if exists "branch_scope" on public.employees;
create policy "branch_scope" on public.employees as restrictive for all
  using (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id()
    or public.employee_in_branch(employees.id, public.current_branch_id()))
  with check (not public.is_branched_user() or public.is_super_super_admin()
    or branch_id = public.current_branch_id()
    or public.employee_in_branch(employees.id, public.current_branch_id()));

create or replace function public.user_can_see_employee(p_employee uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  emp_branch uuid;
begin
  if not public.is_branched_user() or public.is_super_super_admin() then
    return true;
  end if;
  select branch_id into emp_branch from public.employees where id = p_employee;
  if emp_branch is null then
    return public.employee_in_branch(p_employee, public.current_branch_id());
  end if;
  return emp_branch = public.current_branch_id()
      or public.employee_in_branch(p_employee, public.current_branch_id());
end;
$$;
