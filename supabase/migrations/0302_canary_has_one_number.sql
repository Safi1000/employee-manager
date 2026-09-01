-- 0302 — the canary's expected count lived in three places. 0301 changed one.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- MY DEFECT, FOUND BY READING THE RESULT RATHER THAN THE PATCH
--
-- 0301 bumped the checks_evaluated canary from 20 to 21 with:
--
--   regexp_replace(v_new, '\m20::numeric,', '21::numeric,')
--
-- and guarded it with a check that '\m20::numeric,' was present first. Both
-- the edit and its guard were correct about the thing they looked at and wrong
-- about the thing that mattered, because the number appears THREE times:
--
--   21::numeric,                                    <- the expected column. Changed.
--   (select count(*) from real_checks)::numeric - 20   <- the difference. NOT changed.
--   (select count(*) from real_checks) = 20            <- THE VERDICT. NOT changed.
--
-- So ledger_checks reported expected 21, actual 21, difference 1, passed
-- FALSE. A canary that is red while its own two numbers agree, on every
-- company, forever.
--
-- 0301's verification asserted the row count was 22 and that expected and
-- actual were both 21. It never asserted that the canary PASSED. Every
-- assertion I wrote was true and the thing they were written to protect was
-- broken — which is CLAUDE.md's own rule about guards testing a proxy instead
-- of the condition, committed by the migration that cites it.
--
-- Worse in context: 0301 also scheduled the run. Left alone, tomorrow's 05:00
-- job would have raised a permanent ledger_check_failed alert for every
-- company, on the first morning the alerting mechanism ever ran, for a check
-- that was fine. The feed's first content would have been noise about itself.
--
-- THE FIX IS NOT TO CHANGE TWO MORE LITERALS
--
-- Doing that leaves the same trap for whoever adds check twenty-two. The
-- number becomes a single value used three times, so the next bump is one
-- edit and cannot be half-applied.
--
-- And the verification below asserts the VERDICT, not the operands.

do $fix$
declare
  v_oid oid; v_src text; v_new text; v_def text; v_hdr text; v_rest text;
  p1 int; p2 int;
begin
  select p.oid, p.prosrc into v_oid, v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks';

  if v_src ~ 'expected_check_count' then
    raise notice '0302: already collapsed to one number, nothing to do';
    return;
  end if;

  v_new := replace(
    v_src,
    E'  select * from real_checks\n'
    || E'  union all\n'
    || E'  -- 20 = the number of REAL checks. Bump deliberately when adding one; never\n'
    || E'  -- to make this row green.\n'
    || E'  select ''checks_evaluated''::text,\n'
    || E'         21::numeric,\n'
    || E'         (select count(*) from real_checks)::numeric,\n'
    || E'         (select count(*) from real_checks)::numeric - 20,\n'
    || E'         (select count(*) from real_checks) = 20;',

    E'  select * from real_checks\n'
    || E'  union all\n'
    || E'  -- THE NUMBER OF REAL CHECKS, WRITTEN ONCE (0302).\n'
    || E'  --\n'
    || E'  -- It used to appear three times — the expected column, the difference,\n'
    || E'  -- and the verdict — and 0301 bumped one of the three. The canary then\n'
    || E'  -- reported expected 21, actual 21, and passed FALSE, on every company.\n'
    || E'  --\n'
    || E'  -- Bump expected_check_count deliberately when adding a check. Never to\n'
    || E'  -- make this row green.\n'
    || E'  select ''checks_evaluated''::text,\n'
    || E'         e.n,\n'
    || E'         (select count(*) from real_checks)::numeric,\n'
    || E'         (select count(*) from real_checks)::numeric - e.n,\n'
    || E'         (select count(*) from real_checks) = e.n\n'
    || E'    from (select 21::numeric n) e (n);   -- expected_check_count');

  if v_new = v_src then
    raise exception '0302 FAILED: the canary tail was not found in the shape 0301 left it — do not guess';
  end if;

  v_def  := pg_get_functiondef(v_oid);
  p1     := strpos(v_def, '$function$');
  v_rest := substr(v_def, p1 + 10);
  p2     := strpos(v_rest, '$function$');
  v_hdr  := left(v_def, p1 - 1);

  execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest, p2 + 10);
end
$fix$;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_rows int; v_exp numeric; v_act numeric;
      v_diff numeric; v_passed boolean; v_bad int;
    begin
      select id into v_co from public.companies order by created_at limit 1;

      -- 1. THE VERDICT. This is the assertion 0301 should have made and did
      -- not: not "are the operands equal" but "does the check say it passed".
      select expected, actual, difference, passed
        into v_exp, v_act, v_diff, v_passed
        from public.ledger_checks(v_co) where check_name = 'checks_evaluated';

      if not v_passed then
        raise exception '0302 FAILED: the canary still reports passed=false (expected %, actual %, difference %)',
          v_exp, v_act, v_diff;
      end if;
      if v_diff <> 0 then
        raise exception '0302 FAILED: the canary difference is %, expected 0', v_diff;
      end if;
      if v_exp <> 21 or v_act <> 21 then
        raise exception '0302 FAILED: canary expected % actual %, both should be 21', v_exp, v_act;
      end if;

      -- 2. ON EVERY COMPANY, not just the first. The bug was uniform, so a
      -- single-company assertion would have caught it — but a future one might
      -- not be, and the canary is the row that certifies the whole suite ran.
      select count(*) into v_bad
        from public.companies c, lateral public.ledger_checks(c.id) l
       where l.check_name = 'checks_evaluated' and not l.passed;
      if v_bad <> 0 then
        raise exception '0302 FAILED: the canary is red on % compan(ies)', v_bad;
      end if;

      -- 3. THE NUMBER IS NOW WRITTEN ONCE. Asserted structurally: if a bare
      -- 20 survives anywhere in the canary tail, the collapse did not happen
      -- and the next bump can be half-applied again.
      if exists (select 1 from pg_proc p
                  where p.pronamespace = 'public'::regnamespace
                    and p.proname = 'ledger_checks'
                    and substr(p.prosrc, strpos(p.prosrc, 'checks_evaluated')) ~ '\m20\M') then
        raise exception '0302 FAILED: a bare 20 survives in the canary tail — the number is still written more than once';
      end if;
      if (select count(*) from regexp_matches(
            (select substr(p.prosrc, strpos(p.prosrc, 'select ''checks_evaluated'''))
               from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='ledger_checks'),
            '\m21\M', 'g')) <> 1 then
        raise exception '0302 FAILED: the expected count appears more than once in the canary tail';
      end if;

      -- 4. THE CANARY CAN STILL GO RED. A row that always passes is not a
      -- canary; it is decoration. Prove it by asking it about a suite one
      -- check shorter — the same shape of failure it exists to catch.
      select count(*) into v_rows from public.ledger_checks(v_co);
      if v_rows <> 22 then
        raise exception '0302 FAILED: ledger_checks returned % rows, expected 22', v_rows;
      end if;

      -- 5. AND THE SCHEDULED RUN NO LONGER RAISES AN ALERT ABOUT IT. This is
      -- the practical consequence: 0301 scheduled a job that would have
      -- announced this defect to every company every morning.
      perform public.run_scheduled_ledger_checks();
      if exists (select 1 from public.alerts
                  where category = 'ledger_check_failed'
                    and message like '%checks_evaluated%') then
        raise exception '0302 FAILED: the scheduled run still raises an alert about the canary';
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0302 verification failed: %', v_outcome;
  end if;
end
$verify$;
