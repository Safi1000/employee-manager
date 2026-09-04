-- 0386 — branch_guard_gaps() joins ledger_checks, on the two shapes that are
--         settled at zero.
--
-- ===========================================================================
-- IT WAS BUILT AND NEVER ASKED
-- ===========================================================================
--
-- 0367 built the branch detector, 0369 refined it, and 0377–0385 took it from
-- 47 rows to 9. Nothing ever called it. `uninvoked_controls()` says so in
-- exactly those words — "no function, view, policy, constraint, index,
-- default, trigger or cron job CALLS it" — and has been saying it since 0367.
--
-- A control nobody invokes is a control that reports nothing. tenant_guard_gaps
-- has been asked nightly since it was written; its sibling has been asked by
-- hand, in whichever session happened to remember.
--
-- ===========================================================================
-- WRITES AND STAMPS ONLY, AND WHY THAT IS NOT A CARVE-OUT
-- ===========================================================================
--
-- The arm counts `writes` and `stamps`. It does NOT count `reads`, which is
-- where all 9 remaining rows are.
--
-- Those nine are an OPEN DECISION and not a defect: eight are scalar readers of
-- another region's financial aggregates, two of which feed regional_scorecard
-- and cash_entitlements — views whose whole purpose is regions side by side —
-- and the ninth, employee_in_branch, is a policy helper that MUST NOT be
-- guarded, because the branch_scope predicate on payslips calls it with
-- current_branch_id() and a guard would have it refuse to answer the question
-- it exists to answer. All of that is §6d of docs/PERMISSION_GAPS.md, awaiting
-- a decision on whether those views are company-wide by design.
--
-- Including them would make this check RED on the day it was added, with no
-- action available to anybody that would clear it. A permanently red check
-- teaches the next reader that red is normal, which costs more than the check
-- is worth. THAT is the reasoning — not that reads matter less.
--
-- So the check asserts the property that IS settled: no SECURITY DEFINER
-- function writes a branch-scoped table, or accepts a branch it never checks,
-- without a guard. Both are at zero as of 0385, and this is what keeps them
-- there. When the reads decision lands, widen the arm rather than adding a
-- second one.

do $$
declare
  v_def   text;
  v_new   text;
  v_hits  int;
  v_co    uuid;
  v_before int;
  v_after  int;
  v_gaps   int;
  a_arm   text := '      from public.permission_key_gaps()' || chr(10) || '  )';
  a_cnry  text := '(select 34::numeric n) e (n);   -- expected_check_count';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks';
  if v_def is null then raise exception '0386 REFUSED: ledger_checks() does not exist.'; end if;
  if public.executable_source(v_def) ~ 'branch_guard_gaps' then
    raise exception '0386 REFUSED: ledger_checks already carries the branch arm.';
  end if;

  v_hits := (length(v_def) - length(replace(v_def, a_arm, ''))) / length(a_arm);
  if v_hits <> 1 then
    raise exception '0386 REFUSED: the arm anchor appears % time(s), expected 1.', v_hits;
  end if;
  v_hits := (length(v_def) - length(replace(v_def, a_cnry, ''))) / length(a_cnry);
  if v_hits <> 1 then
    raise exception '0386 REFUSED: the canary anchor appears % time(s), expected 1.', v_hits;
  end if;

  -- The arm must be green the moment it exists, or it is a red light nobody
  -- can turn off. Asserted BEFORE the edit, so a non-zero count refuses the
  -- migration instead of shipping a check that fails on arrival.
  select count(*) into v_gaps from public.branch_guard_gaps()
   where shape in ('writes', 'stamps');
  if v_gaps <> 0 then
    raise exception
      '0386 REFUSED: branch_guard_gaps() reports % write/stamp row(s): %. Close them before wiring the check, or it goes red on the day it is added.',
      v_gaps,
      (select string_agg(g.function_name, ', ') from public.branch_guard_gaps() g
        where g.shape in ('writes', 'stamps'));
  end if;

  select id into v_co from public.companies order by created_at limit 1;
  select count(*) into v_before from public.ledger_checks(v_co);

  v_new := replace(v_def, a_arm,
    '      from public.permission_key_gaps()' || chr(10) ||
    '    union all' || chr(10) ||
    '    -- 0386. Does any SECURITY DEFINER function write a branch-scoped table,' || chr(10) ||
    '    -- or accept a branch it never checks, without a guard? Built in 0367 and' || chr(10) ||
    '    -- asked by hand until now. WRITES AND STAMPS ONLY: the `reads` shape is' || chr(10) ||
    '    -- an open policy decision (PERMISSION_GAPS 6d), and a check that is red' || chr(10) ||
    '    -- on arrival with no action available teaches people that red is normal.' || chr(10) ||
    '    select ''no_definer_function_crosses_a_branch''::text,' || chr(10) ||
    '           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0' || chr(10) ||
    '      from public.branch_guard_gaps() b where b.shape in (''writes'', ''stamps'')' || chr(10) ||
    '  )');
  v_new := replace(v_new, a_cnry, '(select 35::numeric n) e (n);   -- expected_check_count');
  execute v_new;

  select count(*) into v_after from public.ledger_checks(v_co);
  if v_after <> v_before + 1 then
    raise exception '0386 FAILED: ledger_checks returned % rows, expected %.', v_after, v_before + 1;
  end if;
  if exists (select 1 from public.ledger_checks(v_co) c
              where c.check_name = 'checks_evaluated' and not c.passed) then
    raise exception '0386 FAILED: the canary disagrees with itself after the bump.';
  end if;
  if exists (select 1 from public.ledger_checks(v_co) c
              where c.check_name = 'no_definer_function_crosses_a_branch' and not c.passed) then
    raise exception '0386 FAILED: the new arm is red on arrival.';
  end if;

  -- And the reason this migration exists: the control must no longer be
  -- reported as uninvoked.
  if exists (select 1 from public.uninvoked_controls() u
              where u.object_name = 'branch_guard_gaps') then
    raise exception
      '0386 FAILED: uninvoked_controls() still reports branch_guard_gaps. Wiring it into ledger_checks was the whole point.';
  end if;

  raise notice '0386: ledger_checks evaluates % checks, the branch arm is green, and the detector is no longer uninvoked.', v_after - 1;
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
    raise exception '0386 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
