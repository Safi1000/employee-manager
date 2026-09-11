-- 0424: profiles.employee_id — link a user account to ONE employee, and scope
-- that user's reads to that employee unless a permission says otherwise.
--
-- THE RULE, AS ASKED FOR: a linked user sees everything belonging to the one
-- employee they are linked to. If they ALSO hold the permission that governs a
-- surface, they keep the full company view of it. The link is therefore a
-- FLOOR, never a ceiling: it grants a self-view to someone with no permissions
-- at all, and takes nothing from someone who has them.
--
-- ---------------------------------------------------------------------------
-- WHAT THE POLICIES HERE ACTUALLY CHANGE, WHICH IS NOT WHAT IT LOOKS LIKE
-- ---------------------------------------------------------------------------
-- Before writing this it is worth stating what read security on this database
-- was, because it is not what the frontend implies.
--
-- On every table below the shape is: PERMISSIVE `company_members`
-- (company_id = current_company_id()) OR `ssa_all`, then RESTRICTIVE
-- `branch_scope`. `has_perm(...)` appears ONLY on the write policies
-- (perm_write_ins / perm_write_upd / perm_write_del).
--
-- So reads were, and for unlinked users remain, COMPANY-WIDE for anybody
-- holding a session — narrowed by branch and by nothing else. `payroll.view`
-- has never gated a read at the database; it gates the sidebar. Any
-- authenticated user could read every payslip in their company through the REST
-- API today.
--
-- That is why the policy added here is RESTRICTIVE and why it names the
-- permission itself. There was no permission-based read gate to widen — a
-- permissive "self" policy would have added nothing to a user who could already
-- read everything. Narrowing the linked user is the only thing that has an
-- effect, so the rule is expressed the way round that bites:
--
--     unlinked  → unchanged, entirely
--     linked + holds the permission → unchanged, entirely
--     linked + no permission → their own rows, and nothing else
--
-- NOT FIXED HERE, AND SAY SO PLAINLY: the general absence of a read gate on
-- the other ~200 tables is untouched. This file scopes the four surfaces that
-- were asked for and leaves the rest of the database exactly as permissive as
-- it found them. DEFERRED — a company-wide read-permission model is its own
-- piece of work and is not something to do halfway inside a linking feature.
--
-- ---------------------------------------------------------------------------
-- ONE USER, ONE EMPLOYEE, AND NOT ALSO A PARTNER
-- ---------------------------------------------------------------------------
-- The partner half of this already exists and is already enforced: 0314 added
-- `user_type`/`partner_scope` plus a `partner_scope` RLS policy on `partners`,
-- `partner_account_entries` and `partner_client_shares`. A partner-scoped user
-- already sees only their own partner rows. Nothing about that is re-stated
-- here; this file adds the EMPLOYEE side and a constraint keeping the two from
-- being set on the same profile, because "linked to an employee" and "is a
-- partner" are different people and a profile claiming both would be scoped by
-- two unrelated rules at once.

-- ---------------------------------------------------------------------------
-- 1. The link
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists employee_id uuid references public.employees(id) on delete set null;

comment on column public.profiles.employee_id is
  'The ONE employee this login belongs to (0424). Null for an ordinary admin account. '
  'Grants a self-view of that employee everywhere, and — where the user holds no '
  'governing permission — restricts them to it. Mutually exclusive with user_type = ''partner''.';

-- One employee cannot be two logins: "their attendance, their payroll" has to
-- name one person and one account, or an audit of who looked at what is
-- ambiguous.
create unique index if not exists profiles_employee_id_unique
  on public.profiles (employee_id)
  where employee_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and conname = 'profiles_employee_or_partner_not_both'
  ) then
    alter table public.profiles
      add constraint profiles_employee_or_partner_not_both
      check (not (employee_id is not null and user_type = 'partner'));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The helpers
-- ---------------------------------------------------------------------------
create or replace function public.current_user_employee_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select employee_id from public.profiles where id = auth.uid();
$function$;

create or replace function public.is_employee_linked()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce((select employee_id is not null from public.profiles where id = auth.uid()), false);
$function$;

-- The whole rule, in one place, so eighteen policies cannot drift apart.
--
-- `p_employee` is the employee column OF THE ROW BEING TESTED, not a lookup
-- key — the function answers "may the caller see a row belonging to this
-- person", and the only identity it reads is the caller's own. Returns a hard
-- boolean: a null p_employee (a cash_location with no custodian, an expense
-- nobody is named on) must read as FALSE for a linked user, not as null, or the
-- policy would neither admit nor refuse it.
create or replace function public.self_scope_ok(p_employee uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
           not public.is_employee_linked()
        or public.is_super_super_admin()
        or public.has_perm(p_perm)
        or p_employee = public.current_user_employee_id(),
         false);
$function$;

comment on function public.self_scope_ok(uuid, text) is
  'TENANT GUARD EXEMPT: p_employee is the employee column of the row already being '
  'filtered by RLS, not a caller-supplied lookup key — the tenant is decided by the '
  'company_members policy this one sits beside. The only identity read is the '
  'caller''s own profile, so there is nothing cross-tenant to resolve. '
  'Returns true when the caller is not employee-linked, is SSA, holds p_perm, or the '
  'row belongs to the employee they are linked to (0424).';

revoke all on function public.current_user_employee_id() from public;
revoke all on function public.is_employee_linked() from public;
revoke all on function public.self_scope_ok(uuid, text) from public;
grant execute on function public.current_user_employee_id() to authenticated;
grant execute on function public.is_employee_linked() to authenticated;
-- RLS policy expressions run with the QUERYING user's privileges, so the
-- calling role needs EXECUTE or every scoped read fails outright.
grant execute on function public.self_scope_ok(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The policies
-- ---------------------------------------------------------------------------
-- RESTRICTIVE and SELECT-only. Restrictive because the permissive
-- `company_members` policy already admits everything and an OR cannot take that
-- back; SELECT-only because a linked account is read-only by decision — writes
-- keep the perm_write_* policies they have always had, which a user holding no
-- permissions fails anyway.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      -- Profile & HR record
      ('employees',                    'id',                     'employees.view'),
      ('employee_documents',           'employee_id',            'employees.view'),
      ('guard_documents',              'employee_id',            'employees.view'),
      ('employee_document_checklist',  'employee_id',            'employees.view'),
      ('employee_salary_history',      'employee_id',            'employees.view'),
      ('employee_code_history',        'employee_id',            'employees.view'),
      ('employee_lifecycle_events',    'employee_id',            'employees.view'),
      ('employee_approval_events',     'employee_id',            'employees.view'),
      ('employee_references',          'employee_id',            'employees.view'),
      ('employee_children',            'employee_id',            'employees.view'),
      ('employee_previous_jobs',       'employee_id',            'employees.view'),
      ('employee_training_records',    'employee_id',            'employees.view'),
      ('employee_branches',            'employee_id',            'employees.view'),
      ('guard_contacts',               'employee_id',            'employees.view'),
      ('clearance_certificates',       'employee_id',            'employees.view'),
      ('disciplinary_warnings',        'employee_id',            'employees.view'),
      ('appraisals',                   'employee_id',            'employees.view'),
      ('kpi_values',                   'employee_id',            'employees.view'),
      -- Attendance & deployment
      ('attendance_records',           'employee_id',            'attendance.view'),
      ('attendance_overrides',         'employee_id',            'attendance.view'),
      ('employee_leave_overrides',     'employee_id',            'attendance.view'),
      ('roster_assignments',           'employee_id',            'attendance.view'),
      ('no_show_events',               'employee_id',            'attendance.view'),
      ('deployments',                  'guard_id',               'attendance.view'),
      -- Payroll & money owed
      ('payslips',                     'employee_id',            'payroll.view'),
      ('advances',                     'employee_id',            'payroll.view'),
      ('guard_bonuses',                'employee_id',            'payroll.view'),
      ('bonus_pool_allocations',       'employee_id',            'payroll.view'),
      -- Cash custody & expenses
      ('cash_locations',               'custodian_employee_id',  'banks.view'),
      ('expenses',                     'expense_by',             'expenses.view')
    ) as t(tbl, col, perm)
  loop
    -- Skip anything not present rather than failing the file: this list spans
    -- four subsystems and a table missing from one install is not a reason to
    -- leave the other twenty-nine unscoped.
    if to_regclass('public.' || r.tbl) is null then
      raise notice '0424: skipping %, table not present', r.tbl;
      continue;
    end if;
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = r.tbl and column_name = r.col
    ) then
      raise exception '0424: %.% does not exist — the scope column was renamed', r.tbl, r.col;
    end if;

    execute format('drop policy if exists self_scope on public.%I', r.tbl);
    execute format(
      'create policy self_scope on public.%I as restrictive for select using (public.self_scope_ok(%I, %L))',
      r.tbl, r.col, r.perm);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Verification — assert the thing that can break, not the thing that moved
-- ---------------------------------------------------------------------------
-- The failure to guard against is a policy that did not get created, or got
-- created against the wrong column. Counting policies named self_scope proves
-- only that the loop ran. So check the COLUMN each one tests, read back from
-- the catalog.
do $$
declare
  v_missing text;
  v_n       int;
begin
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public' and policyname = 'self_scope' and permissive = 'RESTRICTIVE';
  if v_n < 30 then
    raise exception '0424: expected 30 self_scope policies, found %', v_n;
  end if;

  select string_agg(t.tbl, ', ') into v_missing
    from (values
      ('employees'), ('payslips'), ('attendance_records'), ('advances'),
      ('cash_locations'), ('expenses'), ('deployments')
    ) as t(tbl)
   where not exists (
     select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t.tbl
        and p.policyname = 'self_scope' and p.permissive = 'RESTRICTIVE'
   );
  if v_missing is not null then
    raise exception '0424: self_scope missing on %', v_missing;
  end if;

  -- employees is scoped on `id`, every other table on its own employee column.
  -- Getting this one wrong would scope the employee list by a column that does
  -- not exist on it, which is the single most likely mistake in the loop above.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'employees' and policyname = 'self_scope'
       and qual like '%(id,%'
  ) then
    raise exception '0424: employees.self_scope is not scoped on id';
  end if;
end;
$$;

-- An unlinked session must be completely unaffected. This is the assertion that
-- matters most: everything above is worthless if it narrowed the people who
-- were already working.
do $$
begin
  if public.is_employee_linked() then
    raise exception '0424: the migrating session is employee-linked, which it should not be';
  end if;
  if not public.self_scope_ok(null, 'nonexistent.permission') then
    raise exception '0424: self_scope_ok refuses an UNLINKED caller — every scoped read would fail';
  end if;
end;
$$;

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
