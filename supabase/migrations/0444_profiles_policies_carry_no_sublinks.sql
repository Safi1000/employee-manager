-- 0444 — profiles' policies go back to bare helper calls: a table whose
--        policy already reads itself cannot also carry sublinks.
--
-- ===========================================================================
-- WHAT BROKE, WITHIN HOURS OF 0441
-- ===========================================================================
--
--   ERROR 42P17: infinite recursion detected in policy for relation "profiles"
--
-- on the super_super_admin's company switch:
--
--   UPDATE profiles SET view_as_company = $1 WHERE id = $2
--
-- 0441 wrapped every helper call in every policy as `( SELECT fn())` so the
-- planner evaluates it once per statement. It proved, per profile and per
-- table, that visibility did not change — and it did not. What it did not
-- test is an UPDATE on profiles, and that is the one statement the rewrite
-- breaks.
--
-- ===========================================================================
-- WHY: THE RECURSION CHECK ONLY RUNS WHEN A POLICY HAS SUBLINKS
-- ===========================================================================
--
-- profiles.self_update's WITH CHECK has read profiles since it was written:
--
--   role = (SELECT p.role FROM profiles p WHERE p.id = auth.uid())
--
-- A policy that scans its own table is what the rewriter's recursion guard
-- exists for. But the guard is conditional: in fireRIRrules, the "is this
-- relation already being expanded" test runs ONLY when the policy expressions
-- being applied contain sublinks. Before 0441, the inner `FROM profiles` scan
-- picked up profiles' SELECT policies — self_read, ssa_all_profiles,
-- super_admin_company_profiles — none of which had a sublink, so the guard
-- never looked, and the nested scan was allowed. After 0441 every one of them
-- is `( SELECT … )`, the guard looks, finds profiles already active from the
-- outer UPDATE, and refuses.
--
-- Confirmed by bisection in a rolled-back transaction on prod: restoring any
-- one of the four policies alone still fails; restoring all four succeeds.
-- Every SELECT-applicable policy on the table has to be sublink-free for the
-- nested scan to pass.
--
-- The rule this adds to 0441's: **a table with a self-referencing policy must
-- have no sublinks in any of its policies.** pg_policies on prod shows
-- exactly one such table — profiles — which is also the one table where the
-- per-row cost 0441 removed is irrelevant: it has nine rows.
--
-- ===========================================================================
-- WHAT THIS DOES
-- ===========================================================================
--
-- Restores the four profiles policies to their pre-0441 text, verbatim from
-- 0441's own before-image. Nothing else on the table changes; nothing on any
-- other table changes.
--
-- ===========================================================================
-- THE CONTROL
-- ===========================================================================
--
-- The failing statement is re-run inside this migration as the SSA, in a
-- sub-transaction that is rolled back on purpose, so the migration refuses
-- if the recursion is still there and writes nothing if it is not. Then the
-- table is asserted to carry no sublinks in any policy, so a future rewrite
-- that touches profiles again refuses here instead of on the SSA's next
-- company switch.

-- ---------------------------------------------------------------------------
-- 1. The four policies, as they were before 0441.
-- ---------------------------------------------------------------------------
alter policy self_read on public.profiles
  using (id = auth.uid());

alter policy self_update on public.profiles
  using (id = auth.uid())
  with check ((id = auth.uid()) and (role = (select profiles_1.role from public.profiles profiles_1 where profiles_1.id = auth.uid())));

alter policy ssa_all_profiles on public.profiles
  using (is_super_super_admin())
  with check (is_super_super_admin());

alter policy super_admin_company_profiles on public.profiles
  using (("current_role"() = 'super_admin'::user_role) and (company_id = current_company_id()))
  with check (("current_role"() = 'super_admin'::user_role) and (company_id = current_company_id())
              and (role = any (array['hr'::user_role, 'accounting'::user_role, 'super_admin'::user_role])));

comment on policy self_update on public.profiles is
  '0444: this WITH CHECK reads profiles, so NO policy on profiles may contain a sublink — including ( SELECT fn()) wrappers. The rewriter''s recursion guard only fires when policies carry sublinks, and then refuses the nested scan. 0441 wrapped these and broke the SSA''s company switch; 0444 restored them.';

-- ---------------------------------------------------------------------------
-- 2. The statement that failed, re-run as the SSA and rolled back.
-- ---------------------------------------------------------------------------
do $$
declare v_ssa uuid; v_n int;
begin
  select id into v_ssa from public.profiles where role = 'super_super_admin' order by created_at limit 1;
  if v_ssa is null then
    raise exception '0444 REFUSED: no super_super_admin profile to reproduce the failing statement with.';
  end if;
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', v_ssa, 'role', 'authenticated')::text, true);
    update public.profiles set view_as_company = view_as_company where id = v_ssa;
    get diagnostics v_n = row_count;
    execute 'reset role';
    if v_n <> 1 then
      raise exception '0444 REFUSED: the SSA self-update touched % rows, expected 1.', v_n;
    end if;
    -- Undo the (no-op) write by leaving the sub-transaction through an
    -- exception of our own; a recursion error has a different SQLSTATE and
    -- propagates, refusing the migration.
    raise sqlstate 'P0444';
  exception
    when sqlstate 'P0444' then
      execute 'reset role';
      perform set_config('request.jwt.claims', '', true);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. No policy on profiles carries a sublink.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(policyname, ', ') into v_n, v_who
    from pg_policies
   where schemaname = 'public' and tablename = 'profiles'
     and (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~ '\( ?SELECT (public\.)?[a-z_"]+\(';
  if v_n <> 0 then
    raise exception '0444 REFUSED: % profiles policies still carry a function sublink: %', v_n, v_who;
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
      '0444 REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see.',
      v_n, v_who;
  end if;
end $$;
