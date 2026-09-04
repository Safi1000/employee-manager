-- 0402 — the canary counts the check 0400 added.
--
-- 0400 wired monthly_ledger_run_is_current into ledger_checks and did not bump
-- expected_check_count. real_checks went from 35 to 36; the literal stayed at
-- 35; checks_evaluated has been red since, on every company. It was green
-- before — there is no alert row for it in public.alerts — so this is a false
-- red that 0400 created and that tonight's 05:00 run would raise.
--
-- ── HOW IT GOT PAST 0400'S OWN VERIFICATION, WHICH IS THE PART WORTH KEEPING ──
--
-- 0400 asserted this, and the assertion passed:
--
--     select count(*) into v_after from public.ledger_checks(v_co);
--     if v_after <> v_before + 1 then raise ...
--
-- Both counts INCLUDE the canary row, so adding one check moves both by one and
-- the assertion is satisfied whether or not the canary agrees with itself. It
-- measured that a row had been added. It did not measure the only thing that
-- could go wrong. That is the same shape as every defect this suite exists to
-- catch — a control that reports its own input — committed inside the migration
-- that was adding a control.
--
-- The right assertion is the one below: the canary row's own `passed`.
--
-- ── AND THE COMMENT THAT MADE IT EASY ────────────────────────────────────────
--
-- 0347 added a check at the same anchor and left this note:
--
--     -- The canary literal inside ledger_checks_base counts the checks it
--     -- evaluates. The new check lives in ledger_checks, not the base, so
--     -- rows_before_canary is deliberately NOT touched
--
-- That was true when it was written and is not true now: 0302 moved the canary
-- OUT of ledger_checks_base and into ledger_checks, where it counts the
-- `real_checks` CTE — which is exactly where 0347's check and 0400's check both
-- landed. A note describing a layout that has since changed reads as current,
-- because nothing about it announces its own age. Following it was still my
-- error: the canary's verdict was one query away and 0400 did not run it.
--
-- BUMPED BECAUSE A CHECK WAS ADDED, NEVER TO MAKE THE ROW GREEN. The canary's
-- own comment draws that line and this migration stays on the right side of it:
-- it asserts the real count is 36 BEFORE writing 36, so the literal is a record
-- of a counted fact rather than a number chosen to end an argument.

do $$
declare
  v_def    text;
  v_anchor text := 'from (select 35::numeric n) e (n);   -- expected_check_count';
  v_new    text;
  v_hits   int;
  v_co     uuid;
  v_real   int;
  v_passed boolean;
begin
  select id into v_co from public.companies where active and archived_at is null
   order by created_at limit 1;
  if v_co is null then
    raise exception '0402 REFUSED: no company to count against, so the new literal could not be verified before being written.';
  end if;

  -- THE COUNT FIRST. Write what was counted, not what would make it pass.
  select count(*) into v_real from public.ledger_checks(v_co)
   where check_name <> 'checks_evaluated';
  if v_real <> 36 then
    raise exception
      '0402 REFUSED: ledger_checks evaluates % real checks, not the 36 this migration was written to record. Somebody added or removed one in between. Count again and write THAT number — do not let this file decide.', v_real;
  end if;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks';
  if v_def is null then raise exception '0402 REFUSED: public.ledger_checks does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      '0402 REFUSED: the expected_check_count literal "35" appears % time(s), expected 1. If it is 0 the canary has already been bumped by somebody else and this migration would be wrong; if it is 2 the number has been duplicated, which is the defect 0302 removed. Do not widen the anchor.', v_hits;
  end if;

  v_new := replace(v_def, v_anchor,
    'from (select 36::numeric n) e (n);   -- expected_check_count');
  execute v_new;

  -- THE ASSERTION 0400 SHOULD HAVE MADE. Not "a row was added" — the canary's
  -- own verdict, which is the one thing a miscounted bump can break.
  select passed into v_passed from public.ledger_checks(v_co)
   where check_name = 'checks_evaluated';
  if v_passed is not true then
    raise exception '0402 FAILED: checks_evaluated is still not passing after the bump.';
  end if;

  raise notice '0402: expected_check_count 35 -> 36; checks_evaluated green.';
end $$;

-- ---------------------------------------------------------------------------
-- TENANT GUARD ASSERTION NOT APPLICABLE — but run anyway, and here is why.
--
-- This migration adds no function and no parameter, so it cannot open a guard
-- gap of its own. The assertion is kept because it is CHEAP AND IT IS A READING
-- OF LIVE STATE, not a restatement of this file's intent: if it fires, a gap
-- exists that something else opened and this migration is the first thing to
-- look at it. An assertion skipped because "it obviously does not apply" is how
-- the four regressions the template names got through.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0402 REFUSED: tenant_guard_gaps() reports % gap(s): %. This migration did not open them — something before it did, and it is now visible.',
      v_n, v_who;
  end if;
end $$;
