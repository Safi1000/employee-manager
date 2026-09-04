-- 0377 — disburse_payroll_run and payroll_run_attach assert the branch of the
--        RUN they process, and refuse a company-wide run to a regional operator.
--
-- ===========================================================================
-- THE SET-PROCESSOR RULE. This is the general finding; these two are only
-- where it was found.
-- ===========================================================================
--
--   CONVERTING A SET OPERATION TO SECURITY INVOKER TURNS AN UNAUTHORISED ACT
--   INTO A SILENTLY SMALLER RESULT.
--
-- For a SINGLE-ROW operation, invoker is a safe conversion: RLS hides the row,
-- the write affects zero rows, and (given the row-count assert this project
-- already requires) the caller is REFUSED. A refusal is a control.
--
-- For a SET operation there is no such moment. `update ... where run = $1`
-- under RLS simply touches fewer rows. The function returns a smaller count,
-- reports success, and the run looks disbursed while half of it is not. That
-- is a defect wearing success's clothes, which is the failure mode this whole
-- project exists to remove.
--
-- SO: ANY FUNCTION PROCESSING A SET BEHIND A PERMISSION BOUNDARY MUST BE
-- CHECKED FOR THIS BEFORE CONVERSION. There will be others — the two here are
-- only the two that happened to sit in 0376's list. The check is: does the
-- write touch N rows chosen by a predicate, rather than one row named by an
-- id? If so, invoker is the wrong instrument and the body must assert the
-- boundary itself, which is what this migration does.
--
-- The rule is deliberately NOT automated. Whether a write is "a set" is a
-- judgement about intent — `where id = $1` and `where run_id = $1` are the
-- same syntax — and a checker that guessed would be advisory, which CLAUDE.md
-- is explicit about not tolerating. It is written into CLAUDE.md, into
-- scripts/migration-template.sql, and onto branch_guard_gaps() itself, so a
-- reader meets it wherever they arrive from.
--
-- ===========================================================================
-- WHAT THESE TWO GET INSTEAD
-- ===========================================================================
--
-- Both take a RUN and write many payslips. payslips carries branch_scope (via
-- user_can_see_employee), so under invoker a branched operator would process
-- only their own region and be told it worked. They stay SECURITY DEFINER and
-- assert the run's own branch — the [resolved] shape of 0375.
--
-- THE NULL RUN IS THE PART WORTH READING. payroll_runs.branch_id is nullable
-- and NULL means "every region". assert_branch_writable() returns early on
-- NULL — correct for a head-office journal line, and exactly wrong here: it
-- would let a regional operator disburse the whole company. So the NULL case
-- is refused explicitly rather than left to the helper's contract. A helper's
-- NULL semantics are a property of the helper, not of every caller.
--
-- Note for whoever tests this: production holds ZERO payroll_runs today, so
-- neither arm has ever executed against real data here.

do $$
declare
  r        record;
  v_def    text;
  v_sec    boolean;
  v_hits   int;
  v_pos    int;
  v_done   int := 0;
  a_tenant text := '  if p_run_id is not null then perform public.assert_same_company((select company_id from public.payroll_runs where id = p_run_id)); end if;';
begin
  for r in select unnest(array['disburse_payroll_run','payroll_run_attach']) as fn
  loop
    select pg_get_functiondef(p.oid), p.prosecdef into v_def, v_sec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn;
    if v_def is null then raise exception '0377 REFUSED: %() does not exist.', r.fn; end if;
    if not v_sec then
      raise exception '0377 REFUSED: %() is no longer SECURITY DEFINER. This migration assumes the body must guard itself.', r.fn;
    end if;

    if public.executable_source(v_def) ~ 'assert_branch_writable' then
      raise exception '0377 REFUSED: %() already asserts the branch.', r.fn;
    end if;
    if public.executable_source(v_def) !~ 'require_perm' then
      raise exception '0377 REFUSED: %() no longer calls require_perm; the body has changed since it was read.', r.fn;
    end if;

    v_hits := (length(v_def) - length(replace(v_def, a_tenant, ''))) / length(a_tenant);
    if v_hits <> 1 then
      raise exception '0377 REFUSED: the tenant-guard anchor appears % time(s) in %(), expected 1.', v_hits, r.fn;
    end if;
    v_pos := position(a_tenant in v_def);

    execute
      substr(v_def, 1, v_pos + length(a_tenant) - 1) || chr(10)
      || '  -- 0377: branch guard [resolved]. The branch is a property of the RUN,' || chr(10)
      || '  -- not a parameter. This function stays SECURITY DEFINER because it' || chr(10)
      || '  -- processes a SET of payslips: under invoker a regional operator would' || chr(10)
      || '  -- not be refused, they would quietly process fewer rows and be told it' || chr(10)
      || '  -- worked. See the 0377 header for the general rule.' || chr(10)
      || '  perform public.assert_branch_writable((select branch_id from public.payroll_runs where id = p_run_id));' || chr(10)
      || '  -- A run with NO branch covers every region. assert_branch_writable()' || chr(10)
      || '  -- returns early on NULL, which is right for a head-office journal line' || chr(10)
      || '  -- and wrong for a payroll run, so the case is refused here rather than' || chr(10)
      || '  -- left to the helper''s contract.' || chr(10)
      || '  if public.is_branched_user() and not public.is_super_super_admin()' || chr(10)
      || '     and (select branch_id from public.payroll_runs where id = p_run_id) is null then' || chr(10)
      || '    raise exception ''This payroll run covers every region and you are assigned to one. Nothing has been recorded.''' || chr(10)
      || '      using errcode = ''42501'';' || chr(10)
      || '  end if;' || chr(10)
      || substr(v_def, v_pos + length(a_tenant) + 1);

    v_done := v_done + 1;
  end loop;

  if v_done <> 2 then raise exception '0377 FAILED: amended %, expected 2.', v_done; end if;
  raise notice '0377: both payroll set-processors now assert the run''s branch.';
end $$;

comment on function public.branch_guard_gaps() is
  '0367/0369/0377: SECURITY DEFINER functions that cross the branch boundary. Shapes: writes (writes a branch_scope table), stamps (accepts a uuid naming a branch), reads (a stable reader taking a branch). THE SET-PROCESSOR RULE, before closing a `writes` row by converting it to SECURITY INVOKER: converting a SET operation to invoker turns an unauthorised act into a SILENTLY SMALLER RESULT, not a refusal. A single-row write is hidden by RLS, affects zero rows and refuses; a write that touches N rows chosen by a predicate simply returns a smaller count and reports success. Those must stay definer and assert the boundary in the body (see 0375, 0377). This is a judgement and not a syntax check — `where id = $1` and `where run_id = $1` look identical — so it is stated here rather than automated.';

-- ---------------------------------------------------------------------------
-- PROVE IT. The detector going quiet is not enough on its own: a dropped
-- function looks the same. So the two are asserted still-present, still
-- definer, and covered — and the resolver subquery is EXECUTED, because a
-- resolver naming a column that does not exist would raise here rather than
-- returning NULL at runtime and asserting nothing.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_sec int;
begin
  select count(*) into v_sec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.proname in ('disburse_payroll_run','payroll_run_attach');
  if v_sec <> 2 then
    raise exception '0377 FAILED: expected 2 SECURITY DEFINER functions, found %. They must NOT have been converted.', v_sec;
  end if;

  select count(*) into v_n from public.branch_guard_gaps()
   where function_name in ('disburse_payroll_run','payroll_run_attach');
  if v_n <> 0 then
    raise exception '0377 FAILED: branch_guard_gaps() still reports % row(s) for the two.', v_n;
  end if;

  perform (select r.branch_id from public.payroll_runs r limit 1);

  -- transition_record_state is the third `writes` row and is DELIBERATELY
  -- untouched here: it gates on a role literal, which is its own finding and
  -- its own decision. If it stopped being reported, the detector broke.
  select count(*) into v_n from public.branch_guard_gaps()
   where function_name = 'transition_record_state';
  if v_n < 1 then
    raise exception '0377 FAILED: transition_record_state is no longer reported and nothing here touched it.';
  end if;

  raise notice '0377: both covered, still definer, resolver executes, transition_record_state still reported.';
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
    raise exception '0377 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
