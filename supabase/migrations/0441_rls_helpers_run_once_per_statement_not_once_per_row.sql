-- 0441 — RLS helper functions run once per statement, not once per row.
--
-- ===========================================================================
-- WHAT WAS WRONG
-- ===========================================================================
--
-- Every policy in this schema calls session helpers — current_company_id(),
-- is_ssa_unscoped(), has_perm('x'), is_branched_user() … — as bare function
-- calls. Postgres evaluates a bare call inside a policy predicate ONCE PER
-- ROW, and each helper is a SECURITY DEFINER lookup on profiles. Worse, the
-- restrictive self_scope_ok(employee_id, 'x.view') takes the row's own column
-- as an argument, so it cannot be hoisted at all, and it performs FOUR profile
-- lookups per call. user_can_see_employee(employee_id) does three plus a read
-- of employees.
--
-- Measured on prod (crm-design), 2026-09-14, as the super_admin profile:
--
--   select employee_id, status from attendance_records
--    where attendance_date between '2026-08-01' and '2026-08-31'
--   -> 10,751 rows, 2,211 ms, 49,591 shared buffer hits.
--   The index scan alone is ~5 ms. The remaining 2.2 s is the policy filter.
--
--   attendance_period_counts('2026-08-01','2026-08-31')  2,178 ms  (invoker)
--   employees, full list                                    137 ms
--
-- The data is small (569 employees, 42k attendance rows). Payroll fires ~22
-- such queries per load; under a small PostgREST pool they serialise, which
-- is how "one month of attendance" becomes a 15–20 s page.
--
-- The same three attendance_records policies, rewritten as below and measured
-- on dev inside a rolled-back transaction: 1,371 ms -> 10 ms on identical
-- rows. That is the whole of this migration: same predicates, evaluated once.
--
-- ===========================================================================
-- WHAT CHANGES, AND WHY EACH CHANGE IS THE SAME PREDICATE
-- ===========================================================================
--
-- Two mechanisms, both standard Postgres planner behaviour:
--
--   (a) A scalar subquery with no outer reference — `( SELECT fn())` — is an
--       InitPlan: evaluated once per statement, its value reused for every
--       row. A bare `fn()` is re-evaluated per row even when STABLE.
--
--   (b) A set-returning SECURITY DEFINER function used as `col IN (SELECT
--       fn())` becomes a hashed SubPlan: the set is materialised once and each
--       row is a hash probe.
--
-- The rewrites, applied mechanically to the text of every policy in public:
--
--   1. self_scope_ok(<col>, '<perm>'::text)
--      -> ((NOT is_employee_linked()) OR is_super_super_admin()
--          OR has_perm('<perm>'::text) OR (<col> = current_user_employee_id()))
--      This is self_scope_ok's own body inlined, minus the coalesce(…, false):
--      a NULL predicate denies exactly as false does in a policy.
--
--   2. user_can_see_employee(<col>)
--      -> ((NOT is_branched_user()) OR is_super_super_admin()
--          OR (<col> IN (SELECT branch_scoped_employee_ids())))
--      The function returned true when the employee's branch_id equalled the
--      user's branch OR the employee had an employee_branches row for it (and
--      only the second when branch_id was null). The union in
--      branch_scoped_employee_ids() is that disjunction as a set.
--
--   3. employee_in_branch(<col>, current_branch_id())
--      -> (<col> IN (SELECT branch_member_employee_ids()))
--      Same EXISTS over employee_branches, as a set.
--
--   4. employee_company_id(<col>) = current_company_id()
--      -> (<col> IN (SELECT company_employee_ids()))
--      A missing employee gave NULL = x -> NULL -> deny; now it is simply not
--      in the set -> false -> deny.
--
--   5. Every remaining zero-argument helper, has_perm('lit'), "current_role"()
--      and auth.uid() is wrapped as `( SELECT … )`. Existing wraps are removed
--      first so the file is idempotent and never produces a double wrap.
--
-- The three set functions are SECURITY DEFINER for the same reason the
-- scalar helpers are: a policy on employees that reads employee_branches would
-- otherwise recurse into employee_branches' own policies (the dev EXPLAIN
-- showed exactly that SubPlan). They take no parameters, so tenant_guard_gaps()
-- has nothing to say about them; they scope themselves to the caller's own
-- branch / company inside the body.
--
-- ===========================================================================
-- THE CONTROL: VISIBILITY IS SNAPSHOTTED BEFORE AND AFTER, PER PROFILE
-- ===========================================================================
--
-- A policy rewrite is a security change and "it reads the same" is not a
-- test. For every profile and every table that carried a per-row helper
-- (rewrites 1–4), the number of rows that profile can SELECT is counted under
-- the OLD policies, then again under the NEW ones, in this same transaction.
-- Any difference refuses the migration. attendance_records is probed on a
-- 14-day window because the old policies make a full count of it cost ~8 s
-- per profile; the window is the same before and after, which is what matters.
--
-- Rewrite 5 is not separately snapshotted: an InitPlan of a STABLE function
-- returns the value the per-row call would have returned, by definition.
-- The post-condition below instead asserts, over the whole schema, that no
-- helper call survives unwrapped and no per-row helper survives at all.
--
-- ===========================================================================
-- WHAT THIS DOES NOT DO
-- ===========================================================================
--
-- It does not drop self_scope_ok, user_can_see_employee, employee_in_branch or
-- employee_company_id. Functions and triggers still call them; they are simply
-- no longer referenced by any policy. It does not touch RPC bodies:
-- attendance_payroll (definer, 1.2 s) and attendance_leave_history (definer,
-- 0.5 s) are slow on their own and are Phase 2.

-- ---------------------------------------------------------------------------
-- The three set helpers.
-- ---------------------------------------------------------------------------

create or replace function public.branch_member_employee_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select eb.employee_id
    from public.employee_branches eb
   where eb.branch_id = public.current_branch_id();
$$;
comment on function public.branch_member_employee_ids() is
  '0441: employees with an employee_branches row for the caller''s branch. Set form of employee_in_branch(col, current_branch_id()) for use as col IN (SELECT …) inside policies, so it is hashed once per statement.';

create or replace function public.branch_scoped_employee_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select e.id
    from public.employees e
   where e.branch_id = public.current_branch_id()
  union
  select eb.employee_id
    from public.employee_branches eb
   where eb.branch_id = public.current_branch_id();
$$;
comment on function public.branch_scoped_employee_ids() is
  '0441: every employee a branched user may see — own-branch employees plus employee_branches members. Set form of user_can_see_employee(col).';

create or replace function public.company_employee_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select e.id
    from public.employees e
   where e.company_id = public.current_company_id();
$$;
comment on function public.company_employee_ids() is
  '0441: employees of the caller''s current company. Set form of employee_company_id(col) = current_company_id().';

-- ---------------------------------------------------------------------------
-- Snapshot, rewrite, snapshot, compare.
-- ---------------------------------------------------------------------------

create temp table if not exists rls_0441_snapshot (
  phase   text not null,
  profile uuid not null,
  tbl     text not null,
  n       bigint not null
) on commit drop;

create or replace function pg_temp.rls_0441_probe(p_phase text) returns void
language plpgsql as $$
declare
  v_profiles uuid[];
  v_profile uuid;
  v_tbl text;
  v_n bigint;
  v_tables text[] := array[
    'advances','appraisals','attendance_overrides','attendance_records',
    'bonus_pool_allocations','cash_locations','clearance_certificates',
    'deployments','disciplinary_warnings','employee_approval_events',
    'employee_branches','employee_children','employee_code_history',
    'employee_document_checklist','employee_documents','employee_leave_overrides',
    'employee_lifecycle_events','employee_previous_jobs','employee_references',
    'employee_salary_history','employee_training_records','employees','expenses',
    'guard_bonuses','guard_contacts','guard_documents','kpi_values',
    'no_show_events','payslips','roster_assignments'
  ];
begin
  -- Materialised first: the loop below switches role, and a cursor over
  -- profiles must not be fetched under it.
  select array_agg(id order by id) into v_profiles from public.profiles;
  foreach v_profile in array v_profiles loop
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_profile, 'role', 'authenticated')::text, true);
    foreach v_tbl in array v_tables loop
      if v_tbl = 'attendance_records' then
        execute 'select count(*) from public.attendance_records where attendance_date >= current_date - 14'
           into v_n;
      else
        execute format('select count(*) from public.%I', v_tbl) into v_n;
      end if;
      execute 'reset role';
      insert into rls_0441_snapshot values (p_phase, v_profile, v_tbl, v_n);
      execute 'set local role authenticated';
    end loop;
    execute 'reset role';
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;

select pg_temp.rls_0441_probe('before');

create or replace function pg_temp.rls_0441_rewrite(p text) returns text
language plpgsql as $f$
declare
  x text := p;
  c_fns constant text :=
    'is_branched_user|is_super_super_admin|current_company_id|is_ssa_unscoped|'
    'current_branch_id|is_partner_scoped|'
    'is_employee_linked|current_user_employee_id';
begin
  if x is null then return null; end if;

  -- 0. Unwrap anything already wrapped, so re-running is a no-op. Postgres
  --    re-renders `( SELECT fn())` as `( SELECT fn() AS fn)`, hence the
  --    optional alias in each pattern.
  x := regexp_replace(x, '\( SELECT (public\.)?(' || c_fns || ')\(\)( AS [a-z_]+)?\)', '\2()', 'g');
  x := regexp_replace(x, '\( SELECT (public\.)?has_perm\((''[^'']*''::text)\)( AS has_perm)?\)', 'has_perm(\2)', 'g');
  x := regexp_replace(x, '\( SELECT (public\.)?"current_role"\(\)( AS "current_role")?\)', '"current_role"()', 'g');
  x := regexp_replace(x, '\( SELECT auth\.uid\(\)( AS uid)?\)', 'auth.uid()', 'g');
  x := regexp_replace(x, '\( SELECT (public\.)?current_partner_scope\(\)( AS current_partner_scope)?\)::uuid\[\]', 'current_partner_scope()', 'g');

  -- 1. self_scope_ok(col, 'perm'::text)  -> its body, inlined.
  x := regexp_replace(x,
    'self_scope_ok\(([a-z_]+), (''[^'']*''::text)\)',
    '((NOT is_employee_linked()) OR is_super_super_admin() OR has_perm(\2) OR (\1 = current_user_employee_id()))',
    'g');

  -- 2. user_can_see_employee(col) -> branch check as a set.
  x := regexp_replace(x,
    'user_can_see_employee\(([a-z_]+)\)',
    '((NOT is_branched_user()) OR is_super_super_admin() OR (\1 IN ( SELECT branch_scoped_employee_ids())))',
    'g');

  -- 3. employee_in_branch(col, current_branch_id()) -> membership as a set.
  x := regexp_replace(x,
    'employee_in_branch\(([a-z_]+), current_branch_id\(\)\)',
    '(\1 IN ( SELECT branch_member_employee_ids()))',
    'g');

  -- 4. employee_company_id(col) = current_company_id() -> company set.
  x := regexp_replace(x,
    '\(employee_company_id\(([a-z_]+)\) = current_company_id\(\)\)',
    '(\1 IN ( SELECT company_employee_ids()))',
    'g');

  -- 5. Wrap every scalar helper as an InitPlan. The leading class refuses a
  --    preceding '.' or identifier character so a qualified or longer name
  --    is never matched in the middle.
  x := regexp_replace(x, '(^|[^.a-z_])(public\.)?(' || c_fns || ')\(\)', '\1( SELECT \3())', 'g');
  x := regexp_replace(x, '(^|[^.a-z_])(public\.)?has_perm\((''[^'']*''::text)\)', '\1( SELECT has_perm(\3))', 'g');
  x := regexp_replace(x, '(^|[^.a-z_])(public\.)?"current_role"\(\)', '\1( SELECT "current_role"())', 'g');
  x := regexp_replace(x, '(^|[^.a-z_])auth\.uid\(\)', '\1( SELECT auth.uid())', 'g');
  -- current_partner_scope() returns uuid[] and is only ever used as
  -- `col = ANY (…)`. `= ANY ((SELECT fn()))` parses as a subquery comparison
  -- (uuid = uuid[] fails), so the InitPlan is cast back to an array. The cast
  -- is emitted without extra parentheses because that is how Postgres renders
  -- it back, and the round-trip assertion below compares text.
  x := regexp_replace(x, '(^|[^.a-z_])(public\.)?current_partner_scope\(\)', '\1( SELECT current_partner_scope())::uuid[]', 'g');
  return x;
end $f$;

-- Postgres renders `( SELECT fn())` back as `( SELECT fn() AS fn)`. "Changed"
-- is judged with the alias stripped, so a re-run rewrites nothing.
create or replace function pg_temp.rls_0441_norm(p text) returns text
language sql immutable as $$
  select regexp_replace(p, ' AS "?[a-z_]+"?\)', ')', 'g');
$$;

do $$
declare
  r record;
  v_q text;
  v_w text;
  v_sql text;
  v_rewritten int := 0;
begin
  for r in
    select schemaname, tablename, policyname, cmd, qual, with_check
      from pg_policies
     where schemaname = 'public'
     order by tablename, policyname
  loop
    v_q := pg_temp.rls_0441_rewrite(r.qual);
    v_w := pg_temp.rls_0441_rewrite(r.with_check);
    if pg_temp.rls_0441_norm(v_q) is not distinct from pg_temp.rls_0441_norm(r.qual)
       and pg_temp.rls_0441_norm(v_w) is not distinct from pg_temp.rls_0441_norm(r.with_check) then
      continue;
    end if;
    v_sql := format('alter policy %I on public.%I', r.policyname, r.tablename);
    if v_q is not null then v_sql := v_sql || format(' using (%s)', v_q); end if;
    if v_w is not null then v_sql := v_sql || format(' with check (%s)', v_w); end if;
    execute v_sql;
    v_rewritten := v_rewritten + 1;
  end loop;
  raise notice '0441: rewrote % policies', v_rewritten;
  if v_rewritten = 0 then
    raise exception '0441 REFUSED: no policy changed. Either already applied or the rewrite matched nothing.';
  end if;
end $$;

select pg_temp.rls_0441_probe('after');

-- The comparison. Any profile/table pair whose visible count moved is a
-- semantic change, and this migration promised none.
do $$
declare v_diff int; v_who text; v_probes int;
begin
  select count(*) into v_probes from rls_0441_snapshot where phase = 'before';
  if v_probes = 0 then
    raise exception '0441 REFUSED: the before-snapshot is empty; the probe did not run.';
  end if;

  select count(*), string_agg(format('%s/%s %s->%s', b.profile, b.tbl, b.n, a.n), '; ')
    into v_diff, v_who
    from rls_0441_snapshot b
    full join rls_0441_snapshot a
      on a.phase = 'after' and a.profile = b.profile and a.tbl = b.tbl
   where b.phase = 'before'
     and a.n is distinct from b.n;

  if v_diff <> 0 then
    raise exception '0441 REFUSED: visibility changed for % profile/table pair(s): %', v_diff, v_who;
  end if;
  raise notice '0441: % probes, visibility identical before and after', v_probes;
end $$;

-- Post-conditions over the whole schema.
do $$
declare
  v_perrow int;
  v_total int;
  v_wrapped int;
  v_second int;
  c_fns constant text :=
    'is_branched_user|is_super_super_admin|current_company_id|is_ssa_unscoped|'
    'current_branch_id|is_partner_scoped|current_partner_scope|'
    'is_employee_linked|current_user_employee_id|has_perm|"current_role"|auth\.uid';
begin
  select count(*) into v_perrow
    from pg_policies
   where schemaname = 'public'
     and (coalesce(qual,'') || coalesce(with_check,''))
         ~ '\m(self_scope_ok|user_can_see_employee|employee_in_branch|employee_company_id)\(';
  if v_perrow <> 0 then
    raise exception '0441 REFUSED: % policies still call a per-row helper.', v_perrow;
  end if;

  with e as (
    select coalesce(qual,'') || ' ' || coalesce(with_check,'') x
      from pg_policies where schemaname = 'public'
  )
  select
    (select count(*) from e, regexp_matches(e.x, '(' || c_fns || ')\(', 'g')),
    (select count(*) from e, regexp_matches(e.x, 'SELECT (public\.)?(' || c_fns || ')\(', 'g'))
    into v_total, v_wrapped;

  if v_total = 0 or v_total <> v_wrapped then
    raise exception '0441 REFUSED: % helper calls in policies, % wrapped as InitPlans.', v_total, v_wrapped;
  end if;
  raise notice '0441: % helper calls, all % wrapped', v_total, v_wrapped;

  -- Idempotency is asserted, not assumed: a second pass of the rewrite over
  -- the policies as Postgres now renders them must change nothing.
  select count(*) into v_second
    from pg_policies
   where schemaname = 'public'
     and (pg_temp.rls_0441_norm(pg_temp.rls_0441_rewrite(qual))
            is distinct from pg_temp.rls_0441_norm(qual)
          or pg_temp.rls_0441_norm(pg_temp.rls_0441_rewrite(with_check))
            is distinct from pg_temp.rls_0441_norm(with_check));
  if v_second <> 0 then
    raise exception '0441 REFUSED: a second rewrite pass would change % policies; the unwrap step does not round-trip.', v_second;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. THE TENANT GUARD ASSERTION.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0441 REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see.',
      v_n, v_who;
  end if;
end $$;
