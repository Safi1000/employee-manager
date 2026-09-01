-- 0318 — the two checks 0286 and 0288 dropped on the floor come back.
--
-- WHAT HAPPENED, AND IT WAS NOT A MERGE CONFLICT
--
-- 0313 added check 19, total_due_not_read_as_a_balance. 0316 added check 20,
-- no_invoice_time_withholding. Both were written in the same session as the
-- guard stream, and both wired themselves into ledger_checks by RESTATING the
-- whole function.
--
-- 0286 and 0288 also restate ledger_checks — and they were written EARLIER,
-- against a nineteen-then-eighteen-check list. Applying them after 0313/0316,
-- which is the order the deployment plan requires, replaced the current list
-- with an older one. Both detector functions survived untouched. Both still
-- answer 0. Nothing read them.
--
-- Neither detector is company-scoped in the way the others are, so no figure
-- moved and no check went red. The suite simply got shorter, and the canary
-- was restated along with it, so it agreed with the shorter suite. A control
-- that disappears while every number stays consistent is the quietest failure
-- in this project's catalogue, and the ONLY reason it was noticed is that the
-- deletion was made by the same hand that had just written them.
--
-- Nothing in the database can detect this. That is stated plainly because it
-- is the actual finding: see the section below.
--
-- WHY uninvoked_controls() DID NOT CATCH IT
--
-- It is the obvious candidate — its entire job is finding controls nothing
-- calls — and it never saw either function. Its function arm considers only
-- names matching:
--
--   gap|check|drift|residue|blocker|completeness|missing|breach|discrepanc|
--   orphan|mismatch|unposted|over_allocated|negative_|invalid|stale|
--   unbalanced|anomal
--
--   ... or a set-returning name ending _rows|_balances|_held_|_review
--
--   total_due_read_as_a_balance          'a_balance', not '_balances'. No match.
--   withholding_written_after_cutover    no token at all.  No match.
--
-- Both are named after THE CONDITION THEY DETECT rather than after the word
-- "check". That is better naming, and it is exactly what a name-shaped
-- predicate cannot see. This is the third time a detector's own predicate has
-- been the defect (0288b: comments counted as callers; 0290: guard names
-- credited to comments).
--
-- SHOULD THE PREDICATE BE WIDENED? MEASURED, AND THE ANSWER IS NO.
--
-- The tempting widening is to drop the name test for set-returning functions
-- and report any that nothing calls. Measured on crm-design before writing
-- this:
--
--   set-returning public functions with no caller at all      21
--   of those, NOT matched by the current name predicate       20
--
-- and those twenty are almost entirely application-facing report RPCs —
-- partner_ledger, attendance_payroll, client_service_report,
-- payroll_cost_by_client, regional_pl and thirteen more. This check cannot see
-- src/, so every one of them would need an exempt-map entry saying "the
-- application calls it". An eighteen-entry map of non-problems is how a check
-- earns being ignored, which is 9.11 and the reason 0296 declined to wire
-- check_deploy_guard.
--
-- Adding the two literal names to the token list is worse: it fixes these two
-- and teaches nothing, and the NEXT detector will be named after its own
-- condition too.
--
-- So the predicate stays. What closes the class is not a better substring:
--
--   1. A migration that adds a detector wires it in the SAME migration, and
--      the canary's expected count moves with it. Since 0302 that count is one
--      number, so an addition that forgets to bump it goes red immediately.
--   2. A migration that RESTATES ledger_checks must be replayed against the
--      current definition, not the one it was written against. That is what
--      0289/0299/0300/0302 do with surgery instead of restatement, and it is
--      why this migration does surgery too.
--
-- Both are process, and process is what this is: there is no query that
-- distinguishes a detector from a report by shape.
--
-- WHY 23 AND NOT 22
--
-- Two checks are restored, on top of the twenty-one 0302 left. The count is a
-- single value since 0302, so this is one edit.

do $restore$
declare
  v_oid oid; v_src text; v_new text; v_def text; v_hdr text; v_rest text;
  p1 int; p2 int;
begin
  select p.oid, p.prosrc into v_oid, v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks';

  if v_src ~ 'total_due_read_as_a_balance' and v_src ~ 'withholding_written_after_cutover' then
    raise notice '0318: both checks are already wired, nothing to do';
    return;                                    -- idempotent replay
  end if;

  -- The anchor is 0300's arm, which is the last one in real_checks. Anchoring
  -- on the CTE's closing paren alone would match the wrong paren if the shape
  -- ever changes; anchoring on a named arm fails loudly instead.
  v_new := replace(
    v_src,
    E'      from public.alert_delivery_gaps(p_company_id)\n  )',
    E'      from public.alert_delivery_gaps(p_company_id)\n'
    || E'    union all\n'
    || E'    -- Company-independent by nature: it reads the catalogue, not the\n'
    || E'    -- data. It lives here anyway because this is the surface anyone\n'
    || E'    -- actually calls, and a detector nothing calls is the defect 0288\n'
    || E'    -- exists to find. Restored by 0318 after 0286/0288 replaced this\n'
    || E'    -- list with an older one.\n'
    || E'    select ''total_due_not_read_as_a_balance''::text,\n'
    || E'           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0\n'
    || E'      from public.total_due_read_as_a_balance()\n'
    || E'    union all\n'
    || E'    -- Restored by 0318, same reason.\n'
    || E'    select ''no_invoice_time_withholding''::text,\n'
    || E'           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0\n'
    || E'      from public.withholding_written_after_cutover(p_company_id)\n'
    || E'  )');

  if v_new = v_src then
    raise exception '0318 FAILED: the alert_delivery_gaps arm was not found — ledger_checks has changed shape, do not guess';
  end if;

  -- The expected count is ONE number since 0302. If that is no longer true,
  -- stop: bumping one of several copies is precisely the defect 0302 fixed.
  if v_new !~ 'select 21::numeric n\) e \(n\)' then
    raise exception '0318 FAILED: the single expected_check_count of 21 was not found — do not adjust the canary blindly';
  end if;
  v_new := replace(v_new, 'select 21::numeric n) e (n)', 'select 23::numeric n) e (n)');

  v_def  := pg_get_functiondef(v_oid);
  p1     := strpos(v_def, '$function$');
  v_rest := substr(v_def, p1 + 10);
  p2     := strpos(v_rest, '$function$');
  v_hdr  := left(v_def, p1 - 1);

  execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest, p2 + 10);
end
$restore$;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_rows int; v_bad int; v_n numeric;
      v_def_td text; v_def_wh text; v_red numeric;
    begin
      select id into v_co from public.companies order by created_at limit 1;

      -- 1. BOTH CHECKS ARE BACK, AND THE SUITE GREW BY EXACTLY TWO.
      select count(*) into v_rows from public.ledger_checks(v_co);
      if v_rows <> 24 then
        raise exception '0318 FAILED: ledger_checks returned % rows, expected 24 (23 checks + canary)', v_rows;
      end if;
      if not exists (select 1 from public.ledger_checks(v_co)
                      where check_name = 'total_due_not_read_as_a_balance') then
        raise exception '0318 FAILED: total_due_not_read_as_a_balance is not in the suite';
      end if;
      if not exists (select 1 from public.ledger_checks(v_co)
                      where check_name = 'no_invoice_time_withholding') then
        raise exception '0318 FAILED: no_invoice_time_withholding is not in the suite';
      end if;

      -- 2. THE CANARY AGREES, ON EVERY COMPANY. 0302's lesson: assert the
      -- VERDICT, not that the two operands happen to match.
      select count(*) into v_bad
        from public.companies c, lateral public.ledger_checks(c.id) l
       where l.check_name = 'checks_evaluated' and not l.passed;
      if v_bad <> 0 then
        raise exception '0318 FAILED: the canary is red on % compan(ies) after the restore', v_bad;
      end if;

      -- 3. BOTH ARE GREEN, which is the state they were in when they were
      -- lost. Green is recorded here as a MEASUREMENT, not as the proof —
      -- see (4), which is the proof.
      select actual into v_n from public.ledger_checks(v_co)
       where check_name = 'total_due_not_read_as_a_balance';
      if v_n <> 0 then
        raise exception '0318: % database object(s) read total_due as a balance', v_n;
      end if;
      select actual into v_n from public.ledger_checks(v_co)
       where check_name = 'no_invoice_time_withholding';
      if v_n <> 0 then
        raise exception '0318: % invoice(s) carry post-cutover invoice-time withholding', v_n;
      end if;

      -- 4. THE SUITE ACTUALLY READS THEM. A check wired to a detector that
      -- ledger_checks does not really consult would show exactly the zeros
      -- above. Stub each detector to report one row, require the suite to go
      -- red, restore, require it green again. Restored BEFORE the verdict is
      -- judged, so a failure cannot leave a stub behind.
      v_def_td := pg_get_functiondef('public.total_due_read_as_a_balance()'::regprocedure);
      v_def_wh := pg_get_functiondef('public.withholding_written_after_cutover(uuid)'::regprocedure);

      execute 'create or replace function public.total_due_read_as_a_balance()
               returns table(kind text, object_name text)
               language sql stable security definer set search_path to ''public''
               as $s$ select ''view''::text, ''zz_0318_probe''::text $s$';

      select actual into v_red from public.ledger_checks(v_co)
       where check_name = 'total_due_not_read_as_a_balance';
      execute v_def_td;

      if coalesce(v_red, 0) = 0 then
        raise exception 'PROBE INSENSITIVE: total_due_read_as_a_balance was stubbed to report a row and the suite still read %', v_red;
      end if;

      execute 'create or replace function public.withholding_written_after_cutover(p_company_id uuid)
               returns table(invoice_id uuid, invoice_number text, created_at timestamptz, withholding_tax numeric)
               language sql stable security definer set search_path to ''public''
               as $s$ select gen_random_uuid(), ''ZZ-0318''::text, now(), 1::numeric $s$';

      select actual into v_red from public.ledger_checks(v_co)
       where check_name = 'no_invoice_time_withholding';
      execute v_def_wh;

      if coalesce(v_red, 0) = 0 then
        raise exception 'PROBE INSENSITIVE: withholding_written_after_cutover was stubbed to report a row and the suite still read %', v_red;
      end if;

      -- Both restored: the zeros must be back, or the restore did not take.
      select count(*) into v_bad
        from public.ledger_checks(v_co) l
       where l.check_name in ('total_due_not_read_as_a_balance', 'no_invoice_time_withholding')
         and l.actual <> 0;
      if v_bad <> 0 then
        raise exception 'PROBE DID NOT RESTORE: % of the two checks still reports a stubbed row', v_bad;
      end if;

      -- 5. AND THE FINDING ITSELF, ASSERTED RATHER THAN NARRATED: neither
      -- detector is visible to uninvoked_controls()'s name predicate. If a
      -- later migration widens it, this fails and the header's argument gets
      -- re-read rather than silently outlived.
      if exists (
        select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname in ('total_due_read_as_a_balance', 'withholding_written_after_cutover')
           and (p.proname::text ~ '(gap|check|drift|residue|blocker|completeness|missing|breach|discrepanc|orphan|mismatch|unposted|over_allocated|negative_|invalid|stale|unbalanced|anomal)'
                or (p.proretset and p.proname::text ~ '(_rows|_balances|_held_|_review)'))
      ) then
        raise exception '0318: uninvoked_controls() now matches one of these two by name — the header says it cannot; re-read it before changing this';
      end if;

      -- 6. THE TENANT GUARDS SURVIVED THE STUB-AND-RESTORE. 0316b's guard
      -- lives inside withholding_written_after_cutover, and the stub above
      -- deliberately did not carry it.
      select count(*) into v_bad from public.tenant_guard_gaps();
      if v_bad <> 0 then
        raise exception '0318 FAILED: tenant_guard_gaps() reports % gap(s) — the stubbed function was not fully restored', v_bad;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0318 verification failed: %', v_outcome;
  end if;
end
$verify$;
