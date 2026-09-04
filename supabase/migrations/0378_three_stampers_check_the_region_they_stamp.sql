-- 0378 — generate_bonus_pool, raise_alert and request_approval check the branch
--        they were handed against the caller's own.
--
-- ===========================================================================
-- THE `stamps` SHAPE
-- ===========================================================================
--
-- All three are SECURITY DEFINER, granted to `authenticated`, and take a
-- p_branch_id that decides which region the row lands in. All three already
-- call assert_branch_in_company(p_branch_id) — which checks the COMPANY and
-- not the branch, and is precisely the defect 0368 named in post_manual_journal
-- wearing a helper's name. branch_guard_covered() deliberately does not count
-- it as coverage, which is why these three were still reported.
--
-- ===========================================================================
-- WHAT THE GUARD DOES NOT CLOSE, WHICH IS THE FINDING OF THIS MIGRATION
-- ===========================================================================
--
-- alerts, approval_requests, bonus_pools and bonus_pool_allocations carry
-- `company_members` (ALL, company_id = current_company_id()) and NO branch
-- policy at all. bonus_pools additionally carries perm_write_* on
-- performance.approve. NONE of the four carries branch_scope.
--
-- SO THE TABLE IS OPEN ACROSS REGIONS EVEN AFTER THIS MIGRATION. A regional
-- user with the company key can still insert an alert or an approval request
-- naming another branch by writing the table directly, and one with
-- performance.approve can still write bonus_pools directly. What this closes
-- is the convenient path — the RPC the frontend calls — not the boundary.
--
-- That is worth stating plainly rather than letting a quiet detector imply
-- otherwise: A FUNCTION GUARD ON TOP OF AN UNGUARDED TABLE MAKES THE DETECTOR
-- GO GREEN AND LEAVES THE HOLE. The real fix is branch_scope on those tables,
-- which is a policy decision about whether the alert feed and the approval
-- queue are company-wide by design. It is logged in docs/PERMISSION_GAPS.md
-- and is NOT taken here.
--
-- ===========================================================================
-- ONE OF THE THREE IS NOT LIKE THE OTHER TWO
-- ===========================================================================
--
-- generate_bonus_pool is guarded on v_scope_branch and NOT on p_branch_id.
-- The regional arm writes p_branch_id, but the head-office arm writes
-- head_office_region() while p_branch_id is NULL — and a guard on the
-- parameter would return early on that NULL and let a regional approver
-- generate the head-office pool and its allocations. The branch the function
-- actually writes into is v_scope_branch, so that is what is asserted. Same
-- lesson as 0377's NULL run: the helper's NULL contract is a property of the
-- helper, not of every caller.
--
-- raise_alert HAS THREE IN-DATABASE CALLERS and the guard changes one of them.
-- sweep_ammo_discrepancy_alerts() loops over every discrepancy in the company
-- and raises one alert per branch; a regional caller now hits this guard on
-- the first foreign branch and the whole sweep rolls back. That is a REFUSAL
-- rather than a partial result, which is the failure mode this project
-- prefers — but it does mean a branched user can no longer run the
-- company-wide sweep at all, and that is a behaviour change, not a no-op.
-- check_deploy_guard and check_disbursement pass a branch resolved from the
-- row they are acting on, so a caller inside their own region is unaffected.
-- run_scheduled_ledger_checks is cron-only: auth.uid() is null, so
-- is_branched_user() is false and assert_branch_writable() returns early.

do $$
declare
  v_def  text;
  v_sec  boolean;
  v_hits int;
  v_pos  int;
  a_anchor text := '  v_growth := v_cur - v_prior;';
  v_ins  text := $ins$  -- 0378: branch guard [resolved]. Guards v_scope_branch and NOT p_branch_id.
  -- The head-office arm writes head_office_region() while p_branch_id is NULL,
  -- and a guard on the parameter would return early on that NULL and let a
  -- regional approver generate the head-office pool. What is asserted is the
  -- branch this function actually writes into.
  perform public.assert_branch_writable(v_scope_branch);

$ins$;
begin
  select pg_get_functiondef(p.oid), p.prosecdef into v_def, v_sec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'generate_bonus_pool';
  if v_def is null then raise exception '0378 REFUSED: generate_bonus_pool() does not exist.'; end if;
  if not v_sec then raise exception '0378 REFUSED: generate_bonus_pool() is no longer SECURITY DEFINER.'; end if;
  if public.executable_source(v_def) ~ 'assert_branch_writable' then
    raise exception '0378 REFUSED: generate_bonus_pool() already asserts the branch.';
  end if;
  if public.executable_source(v_def) !~ 'require_perm' then
    raise exception '0378 REFUSED: generate_bonus_pool() no longer calls require_perm; the body has changed.';
  end if;

  v_hits := (length(v_def) - length(replace(v_def, a_anchor, ''))) / length(a_anchor);
  if v_hits <> 1 then
    raise exception '0378 REFUSED: the anchor appears % time(s) in generate_bonus_pool(), expected 1.', v_hits;
  end if;
  v_pos := position(a_anchor in v_def);

  -- Inserted BEFORE the anchor, because v_scope_branch is only assigned by the
  -- scope if/else above it. A guard placed at the top of the body would read a
  -- NULL that has not been decided yet.
  execute substr(v_def, 1, v_pos - 1) || v_ins || substr(v_def, v_pos);
  raise notice '0378: generate_bonus_pool asserts the scope branch.';
end $$;

do $$
declare
  r      record;
  v_def  text;
  v_sec  boolean;
  v_hits int;
  v_pos  int;
  v_done int := 0;
  a_anchor text := '  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;';
  v_ins  text := $ins$
  -- 0378: branch guard [claimed]. p_branch_id names the region this row lands
  -- in and was accepted as given. assert_branch_in_company() above it checks
  -- the COMPANY, which is the tenant boundary and not the branch one.
  perform public.assert_branch_writable(p_branch_id);
$ins$;
begin
  for r in select unnest(array['raise_alert','request_approval']) as fn
  loop
    select pg_get_functiondef(p.oid), p.prosecdef into v_def, v_sec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn;
    if v_def is null then raise exception '0378 REFUSED: %() does not exist.', r.fn; end if;
    if not v_sec then raise exception '0378 REFUSED: %() is no longer SECURITY DEFINER.', r.fn; end if;
    if public.executable_source(v_def) ~ 'assert_branch_writable' then
      raise exception '0378 REFUSED: %() already asserts the branch.', r.fn;
    end if;

    v_hits := (length(v_def) - length(replace(v_def, a_anchor, ''))) / length(a_anchor);
    if v_hits <> 1 then
      raise exception '0378 REFUSED: the anchor appears % time(s) in %(), expected 1.', v_hits, r.fn;
    end if;
    v_pos := position(a_anchor in v_def);

    execute substr(v_def, 1, v_pos + length(a_anchor) - 1) || v_ins
            || substr(v_def, v_pos + length(a_anchor) + 1);
    v_done := v_done + 1;
  end loop;

  if v_done <> 2 then raise exception '0378 FAILED: amended %, expected 2.', v_done; end if;
  raise notice '0378: raise_alert and request_approval assert the branch handed in.';
end $$;

-- ---------------------------------------------------------------------------
-- PROVE IT.
--
-- Three assertions, and the third is the one that matters. A guard inserted in
-- the wrong place — before v_scope_branch is assigned, say — would still make
-- the detector go quiet, because the detector reads for the CALL and not for
-- where it sits. So generate_bonus_pool is additionally asserted to have its
-- guard AFTER the scope assignment, by position.
-- ---------------------------------------------------------------------------
do $$
declare
  v_n int; v_sec int; v_src text; v_g int; v_s int;
begin
  select count(*) into v_sec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.proname in ('generate_bonus_pool','raise_alert','request_approval');
  if v_sec <> 3 then
    raise exception '0378 FAILED: expected 3 SECURITY DEFINER functions, found %.', v_sec;
  end if;

  select count(*) into v_n from public.branch_guard_gaps()
   where function_name in ('generate_bonus_pool','raise_alert','request_approval');
  if v_n <> 0 then
    raise exception '0378 FAILED: branch_guard_gaps() still reports % row(s) for the three.', v_n;
  end if;

  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'generate_bonus_pool';
  v_g := position('assert_branch_writable(v_scope_branch)' in v_src);
  v_s := position('v_scope_branch := v_ho;' in v_src);
  if v_g = 0 then
    raise exception '0378 FAILED: generate_bonus_pool does not assert v_scope_branch.';
  end if;
  if v_s = 0 or v_g < v_s then
    raise exception
      '0378 FAILED: the guard in generate_bonus_pool sits at % and the scope assignment at %. A guard that runs before the scope is decided reads NULL and asserts nothing, while still reading as covered.', v_g, v_s;
  end if;

  raise notice '0378: three stampers covered, and the bonus guard runs after the scope is decided.';
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0378 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
