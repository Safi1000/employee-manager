-- 0452 — Stage A of the money-movement pass: gate employee_salary_history.
--
-- Its only non-trigger writer is set_employee_salary (SECURITY INVOKER), so a
-- restrictive write gate falls on the caller — which is what we want: the caller
-- must hold pay authority. capture_salary_change is a DEFINER trigger and bypasses
-- (it fires inside a statement the caller already passed RLS to make).
--
-- The key follows the FIELD authority, not page reachability. The salary edit
-- control is authorised by assignments.accounts OR employees.edit in BOTH callers:
--   - EmployeeAssignments: the pay inputs are gated on canAccounts
--     (assignments.accounts OR employees.edit) — the 0343 Accounts/HR split, where
--     HR posts a guard and only Accounts sets pay.
--   - EmployeeManagement SalaryHistoryPanel: gated on employees.edit.
-- has_perm() is key-specific (it does NOT treat employees.edit as a superset of
-- assignments.accounts the way the frontend does), so the honest gate is the OR of
-- the two keys. DECIDED with Shayan 2026-09-16: assignments.accounts OR
-- employees.edit. super_admin/SSA bypass has_perm regardless.

create policy perm_write_ins on public.employee_salary_history as restrictive for insert
  with check ((select public.has_perm('assignments.accounts')) or (select public.has_perm('employees.edit')));
create policy perm_write_upd on public.employee_salary_history as restrictive for update
  using ((select public.has_perm('assignments.accounts')) or (select public.has_perm('employees.edit')))
  with check ((select public.has_perm('assignments.accounts')) or (select public.has_perm('employees.edit')));
create policy perm_write_del on public.employee_salary_history as restrictive for delete
  using ((select public.has_perm('assignments.accounts')) or (select public.has_perm('employees.edit')));

-- ── verification ───────────────────────────────────────────────────────────────
do $mig$
declare v_n int;
begin
  if not exists (select 1 from public.permission_keys where key = 'assignments.accounts')
   or not exists (select 1 from public.permission_keys where key = 'employees.edit') then
    raise exception '0452 FAILED: assignments.accounts / employees.edit missing from permission_keys.';
  end if;
  select count(*) into v_n from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'employee_salary_history' and p.polname like 'perm_write_%';
  if v_n <> 3 then
    raise exception '0452 FAILED: expected 3 perm_write policies on employee_salary_history, found %.', v_n;
  end if;
end $mig$;

-- No functions added, so the tenant-guard surface is unchanged; asserted anyway.
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0452 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
