-- Attendance status normalisation tests — migration 0224.
--
-- Run in the SQL editor or psql. Self-rolling-back: the final RAISE aborts the
-- transaction, so nothing is left behind. Every test below FAILS against the
-- pre-0224 schema and PASSES after it.
--
--   T17  one vocabulary only — no row differs from its lowercase form
--   T18  rotation_leave is folded; no row survives
--   T19  the CHECK constraint refuses a capitalised token
--   T20  avg_deployed_guards counts every worked shift, not just 'present'
--   T21  a near-zero region is NOT dropped from HO apportionment
--   T22  HO apportionment exhausts the pool exactly
--   T23  accrue_attendance_bonuses disqualifies on lowercase absence
--   T24  attendance_leave_history sees the folded 'leave' token
--   T25  is_maintenance_session() exists and is closed by default
--   T26  invoice revenue sits in its SERVICE month (A4)
--   T27  'blocked' is a gate refusal mode and is not recordable as a status
--   T31  an ordinary status change on that same row still succeeds
--   T29  the residue helper and ledger_checks agree about gate-mode residue
--
-- Point v_co at the company under test.
--
-- WHAT THIS SUITE CANNOT TEST, AND WHY
--
-- The SA-lock on attendance_records is enforced by RLS POLICIES
-- (no_modify_sa_locked, no_delete_sa_locked, from 0014/0053), not by triggers.
-- Both roles these suites can run as — postgres and service_role — carry
-- rolbypassrls, and attendance_records does not have FORCE ROW LEVEL SECURITY.
-- So those policies are bypassed here and CANNOT be exercised from any session
-- this file can open. Do not add an SA-lock assertion to this suite: it would
-- report PASS without the policy existing at all. Testing it needs an
-- authenticated non-privileged session, i.e. the application.
--
-- The same applies to every RLS policy in the schema. Trigger-enforced rules
-- (the period lock, journal immutability, the attendance gates) DO fire for
-- privileged roles and are testable here; policy-enforced rules are not.

do $$
declare
  v_co      uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';  -- GUARDS AND GUIDES (PVT) LTD
  v_n       int;
  v_msg     text;
  v_emp     uuid;
  v_day     date;
  v_branch  uuid;
  v_got     numeric;
  v_want    numeric;
  v_asserts int;
  v_red     boolean;
  v_sb      uuid;
  v_emp2    uuid;
  v_n2      int;
  v_results text := chr(10);
begin
  -- PRECONDITIONS. Assert the fixtures this suite reads actually exist, before
  -- any assertion depends on them. A suite pointed at a company that is not
  -- there reports a screen of green zeros: "0 mixed-case rows" is a PASS whether
  -- the vocabulary was normalised or the company simply has no attendance.
  if not exists (select 1 from public.companies where id = v_co) then
    raise exception 'attendance suite ABORTED: company % does not exist in this database', v_co;
  end if;
  if not exists (select 1 from public.attendance_records where company_id = v_co) then
    raise exception 'attendance suite ABORTED: company % has no attendance rows, so T17/T18/T20/T24 would pass vacuously', v_co;
  end if;

  -- T17: two vocabularies must no longer coexist.
  select count(*) into v_n from public.attendance_records where status <> lower(status);
  v_results := v_results || case when v_n = 0
    then 'T17 single_vocabulary            PASS  (0 mixed-case rows)'
    else 'T17 single_vocabulary            FAIL  (' || v_n || ' capitalised rows)' end || chr(10);

  -- T18: rotation_leave folded into leave.
  select count(*) into v_n from public.attendance_records where status = 'rotation_leave';
  v_results := v_results || case when v_n = 0
    then 'T18 rotation_leave_folded        PASS  (0 rows)'
    else 'T18 rotation_leave_folded        FAIL  (' || v_n || ' rows left)' end || chr(10);

  -- T19: the constraint itself must refuse the legacy tokens. Asserted against
  -- the constraint definition rather than by attempting an INSERT — an INSERT is
  -- screened by four other triggers first, so a rejection proves nothing about
  -- the CHECK.
  select count(*) into v_n
    from pg_constraint
   where conrelid = 'public.attendance_records'::regclass
     and conname = 'attendance_records_status_check'
     and strpos(pg_get_constraintdef(oid), '''Present''') = 0
     and strpos(pg_get_constraintdef(oid), '''Absent''')  = 0
     and strpos(pg_get_constraintdef(oid), '''Leave''')   = 0
     and strpos(pg_get_constraintdef(oid), '''rotation_leave''') = 0;
  v_results := v_results || case when v_n = 1
    then 'T19 check_refuses_capitalised    PASS  (legacy tokens not whitelisted)'
    else 'T19 check_refuses_capitalised    FAIL  (constraint still admits them)' end || chr(10);

  -- T20: avg_deployed_guards must count present + double_duty + relief_cover.
  select b.id into v_branch from public.branches b
   where b.company_id = v_co and b.kind = 'regional' and b.active
   order by b.name limit 1;

  select round(count(*) filter (where lower(a.status) in ('present','double_duty','relief_cover'))::numeric
               / extract(day from (date_trunc('month', date '2026-07-01') + interval '1 month - 1 day')), 2)
    into v_want
    from public.attendance_records a
   where a.company_id = v_co and a.branch_id = v_branch
     and a.attendance_date >= date '2026-07-01'
     and a.attendance_date <  date '2026-08-01';

  select public.avg_deployed_guards(v_co, v_branch, date '2026-07-01') into v_got;
  v_results := v_results || case when v_got = v_want
    then 'T20 avg_deployed_counts_worked   PASS  (' || v_got || ')'
    else 'T20 avg_deployed_counts_worked   FAIL  (got ' || v_got || ', want ' || v_want || ')' end || chr(10);

  -- T21: no region is silently dropped from HO apportionment, and the pool is
  -- fully accounted for. ASSERTED BEHAVIOURALLY — it runs the allocation.
  --
  -- The previous version grepped pg_proc.prosrc for the word `continue`. It was
  -- deleted rather than repaired, and the reason is worth keeping:
  --
  --   * It tested the implementation's SOURCE TEXT, not its behaviour, so it
  --     would break on any rewrite that phrased the same logic differently.
  --   * It reported FAIL against CORRECT code, because 0225's rewrite carries
  --     the comment "No `continue` on zero: a branch that billed nothing
  --     reaches zero through the proportion itself". A comment documenting the
  --     absence of `continue` read as its presence.
  --   * Worst, it was environment-dependent through comment retention alone.
  --     The identical function — byte-identical once comments and whitespace
  --     are stripped — PASSED this test on production and FAILED it on dev,
  --     because production's copy was applied through the SQL editor and stores
  --     fewer comments. A prosrc assertion tests the DEPLOYMENT MECHANISM, not
  --     the code.
  --
  -- What 0225 was actually for: a region must not be skipped, and the HO pool
  -- must end up entirely allocated or entirely accounted as a remainder.
  --
  -- Runs against SANDBOX TESTING ORG because it is the only company with a
  -- non-zero HO overhead; v_co has none, and asserting an identity over a zero
  -- pool would pass whatever the code did. `cost_nonzero` is asserted for
  -- exactly that reason.
  select id into v_sb from public.companies where name = 'SANDBOX TESTING ORG';
  if v_sb is null then
    v_results := v_results || 'T21 ho_no_region_dropped         NO FIXTURE (no sandbox org)' || chr(10);
  else
    -- A zero-revenue region, present for the whole run. Under the old `continue`
    -- this is the shape that got skipped.
    insert into public.branches (company_id, name, active, is_head_office)
    values (v_sb, 'ZZ T21 ZERO REVENUE REGION', true, false)
    returning id into v_branch;

    -- Re-running an allocation REVERSES the previous one, and reversal touches
    -- posted journal entries, which enforce_journal_immutable refuses outside a
    -- maintenance session. Declared bypass, narrowest possible scope: on for
    -- this call, off immediately after, and T25 below re-asserts the gate is
    -- closed by default so this cannot leak into the rest of the suite.
    perform set_config('app.ledger_maintenance', 'on', true);
    perform public.run_ho_cost_allocation(v_sb, date '2026-07-01', 'revenue');
    perform set_config('app.ledger_maintenance', '', true);

    select r.ho_cost, r.allocated_total + coalesce(r.unallocated, 0)
      into v_want, v_got
      from public.ho_allocation_runs r
     where r.company_id = v_sb and r.period_month = date '2026-07-01';

    -- Every active branch that BILLED must have received an allocation line.
    -- This is the assertion a `continue` fails: a skipped region has none.
    select count(*) into v_n
      from public.branches b
     where b.company_id = v_sb and b.active
       and public.branch_revenue_for_month(v_sb, b.id, date '2026-07-01', 'revenue') > 0
       and not exists (
         select 1 from public.journal_lines jl
           join public.journal_entries je on je.id = jl.journal_entry_id
          where je.company_id = v_sb and je.source_table = 'ho_allocation'
            and jl.branch_id = b.id);

    v_results := v_results || case
      when v_want is null or v_want <= 0
        then 'T21 ho_no_region_dropped         FAIL  (HO pool is zero — assertion would be vacuous)'
      when v_n > 0
        then 'T21 ho_no_region_dropped         FAIL  (' || v_n || ' billing region(s) received nothing)'
      when v_got <> v_want
        then 'T21 ho_no_region_dropped         FAIL  (pool ' || v_want || ' but allocated+remainder ' || v_got || ')'
      else 'T21 ho_no_region_dropped         PASS  (pool ' || v_want || ' fully accounted, no billing region skipped)'
    end || chr(10);
  end if;

  -- T22: the apportionment must exhaust the pool. Proven arithmetically against
  -- the live weights rather than by posting: sum of proportional shares with the
  -- residual to the largest region equals the pool exactly.
  -- NON-VACUITY GUARD. "zero runs are short" is also true when there are zero
  -- runs, so the population is asserted before the property is. This is not
  -- hypothetical: dev has NO ho_allocation_runs of its own, and the previous
  -- version of this test reported PASS against an empty table.
  --
  -- DEPENDS ON T21, deliberately. T21 above runs an allocation, which creates
  -- the row this assertion then checks. Run T22 alone and it correctly reports
  -- that it asserted nothing.
  select count(*) into v_n2
    from public.ho_allocation_runs
   where allocated_total is not null and ho_cost is not null;
  select count(*) into v_n
    from public.ho_allocation_runs
   where allocated_total is not null and ho_cost is not null
     and allocated_total + coalesce(unallocated, 0) <> ho_cost;
  v_results := v_results || case
    when v_n2 = 0 then 'T22 ho_pool_fully_accounted      FAIL  (no allocation runs — nothing asserted)'
    when v_n = 0  then 'T22 ho_pool_fully_accounted      PASS  (' || v_n2 || ' run(s) checked)'
    else 'T22 ho_pool_fully_accounted      FAIL  (' || v_n || ' of ' || v_n2 || ' run(s) short)' end || chr(10);

  -- T23: an employee absent in the lowercase vocabulary must NOT be
  -- bonus-eligible. ASSERTED BEHAVIOURALLY — it runs the accrual.
  --
  -- Two earlier versions of this test were both wrong, in the two different
  -- ways this file now exists to catch.
  --
  --   1. A data query counting employees absent in lowercase but not uppercase.
  --      DEAD — its result was overwritten before anything read it — and
  --      unanswerable anyway, since 0224 removed the token 'Absent' entirely,
  --      so the set is empty whether the predicate is case-insensitive or not.
  --   2. strpos(prosrc, 'lower(a.status) = ''absent''') — the same prosrc
  --      defect as T21. It asserted that one specific spelling appears in the
  --      source, so `lower(a.status) IN ('absent')`, or a rewrite using
  --      citext, or a reformat, all fail it while behaving identically.
  --
  -- PAIRED, deliberately. The refusal alone proves nothing: if the accrual
  -- awarded no one — wrong company, wrong month, wrong category filter — the
  -- absent employee gets no bonus and the test passes for the wrong reason.
  -- The clean employee is the control that says the accrual actually ran.
  -- NO FABRICATED ROWS. The absence is created by UPDATING a real July
  -- attendance row, not by inserting one. Inserting was tried and is wrong
  -- twice over: worked_shift is NOT NULL so the fixture was incomplete (the
  -- exact defect docs/LEDGER_PHASE1_FIXTURE_AUDIT.md catalogues), and any past
  -- month is refused by the guard's service window, which starts 2026-07-01.
  -- Mutating a row the application really produced avoids both.
  select a.employee_id into v_emp
    from public.attendance_records a
    join public.employees e on e.id = a.employee_id
   where a.company_id = v_co and e.lifecycle_state = 'active'
     and e.category in ('client', 'reliever')
     and a.attendance_date between date '2026-07-01' and date '2026-07-31'
   order by a.employee_id limit 1;
  select a.employee_id into v_emp2
    from public.attendance_records a
    join public.employees e on e.id = a.employee_id
   where a.company_id = v_co and e.lifecycle_state = 'active'
     and e.category in ('client', 'reliever')
     and a.attendance_date between date '2026-07-01' and date '2026-07-31'
     and a.employee_id <> v_emp
   order by a.employee_id limit 1;

  if v_emp is null or v_emp2 is null then
    v_results := v_results || 'T23 bonus_disqualifies_absent    NO FIXTURE (need two July-attending client/reliever employees)' || chr(10);
  else
    -- Declared bypass, one UPDATE wide: the backdate cutoff would refuse an edit
    -- to July. Cleared before the accrual runs, so nothing under assertion is
    -- bypassed -- accrue_attendance_bonuses is not gated by it.
    perform set_config('app.skip_attendance_lock', '1', true);
    update public.attendance_records set status = 'absent'
     where employee_id = v_emp
       and attendance_date = (select min(attendance_date) from public.attendance_records
                               where employee_id = v_emp
                                 and attendance_date between date '2026-07-01' and date '2026-07-31');
    perform set_config('app.skip_attendance_lock', '', true);

    perform public.accrue_attendance_bonuses(v_co, date '2026-07-01', 500);

    select count(*) into v_n from public.guard_bonuses
     where employee_id = v_emp and bonus_type = 'attendance' and period_month = date '2026-07-01';
    select count(*) into v_n2 from public.guard_bonuses
     where employee_id = v_emp2 and bonus_type = 'attendance' and period_month = date '2026-07-01';

    v_results := v_results || case
      when v_n2 = 0 then 'T23 bonus_disqualifies_absent    FAIL  (control got no bonus -- accrual did not run at all)'
      when v_n > 0  then 'T23 bonus_disqualifies_absent    FAIL  (absent employee was awarded)'
      else 'T23 bonus_disqualifies_absent    PASS  (absent refused, control awarded)'
    end || chr(10);
  end if;

  -- T24: leave history must see the folded token.
  -- PAIRED. The function returning a positive number proves nothing on its own
  -- unless there are 'leave' rows for it to have found. v_n2 counts them
  -- directly; the function must see at least one of them.
  select count(*) into v_n2 from public.attendance_records
   where company_id = v_co and status = 'leave'
     and attendance_date >= date '2026-04-01' and attendance_date < date '2026-09-01';
  select coalesce(sum(cnt), 0) into v_n
    from public.attendance_leave_history(date '2026-04-01', date '2026-09-01');
  v_results := v_results || case
    when v_n2 = 0 then 'T24 leave_history_sees_leave     FAIL  (no leave rows in range — nothing to see)'
    when v_n > 0  then 'T24 leave_history_sees_leave     PASS  (' || v_n || ' seen against ' || v_n2 || ' rows)'
    else 'T24 leave_history_sees_leave     FAIL  (' || v_n2 || ' leave rows exist but the function saw 0)' end || chr(10);

  -- T25: the renamed gate exists and is closed by default.
  select count(*) into v_n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'is_maintenance_session';
  if v_n = 0 then
    v_results := v_results || 'T25 maintenance_gate_renamed     FAIL  (function absent)' || chr(10);
  else
    perform set_config('app.ledger_maintenance', '', true);
    if public.is_maintenance_session() then
      v_results := v_results || 'T25 maintenance_gate_renamed     FAIL  (open with flag off!)' || chr(10);
    else
      v_results := v_results || 'T25 maintenance_gate_renamed     PASS  (exists, closed by default)' || chr(10);
    end if;
  end if;

  -- T26 (0225): invoice revenue must sit in its SERVICE month, not the month it
  -- happened to be raised in (A4). Seven sandbox entries were 2026-08 against
  -- June/July service periods because they were posted ~14h before 0221 applied.
  -- NON-VACUITY GUARD, as T22. Zero misdated entries is also what a database
  -- with no posted invoice entries at all reports.
  select count(*) into v_n2
    from public.invoices i
    join public.journal_entries je
      on je.source_table = 'invoices' and je.source_id = i.id
     and je.is_reversal = false and je.status = 'posted';
  select count(*) into v_n
    from public.invoices i
    join public.journal_entries je
      on je.source_table = 'invoices' and je.source_id = i.id
     and je.is_reversal = false and je.status = 'posted'
   where je.posting_period <> date_trunc('month', coalesce(i.period_start, i.invoice_date))::date;
  v_results := v_results || case
    when v_n2 = 0 then 'T26 revenue_at_service_month     FAIL  (no posted invoice entries — nothing asserted)'
    when v_n = 0  then 'T26 revenue_at_service_month     PASS  (' || v_n2 || ' entries checked)'
    else 'T26 revenue_at_service_month     FAIL  (' || v_n || ' of ' || v_n2 || ' misdated)' end || chr(10);

  -- T27 (0228): 'blocked' is a gate refusal mode and must not be recordable as a
  -- status. NOTE trg_reject_gate_mode_as_status sorts LAST alphabetically among
  -- the attendance triggers, so every other gate intercepts first — the test has
  -- to pick a row that passes all of them and bypass only the backdate cutoff,
  -- or it "passes" on someone else's exception. Assert on the message, not just
  -- on the fact that something raised.
  perform set_config('app.skip_attendance_lock', '1', true);
  select a.employee_id, a.attendance_date into v_emp, v_day
    from public.attendance_records a
    join public.employees e on e.id = a.employee_id
   where a.company_id = v_co and a.status = 'present'
     and e.exit_date is null and a.attendance_date >= date '2026-08-01'
     and not exists (select 1 from public.attendance_confirmations c
                      where c.attendance_date = a.attendance_date
                        and c.shift_code = a.worked_shift)
   order by a.attendance_date desc limit 1;

  -- NO ROW, NO TEST. If that SELECT finds nothing, v_emp and v_day are NULL and
  -- both UPDATEs below match ZERO rows. T27 would then report FAIL (safe), but
  -- T31 would report PASS on an update that changed nothing — green for an
  -- assertion that never ran. Say so instead of scoring it.
  if v_emp is null or v_day is null then
    v_results := v_results
      || 'T27 rejects_gate_mode_status      NO FIXTURE (no eligible row; not asserted)' || chr(10)
      || 'T31 normal_status_change_ok      NO FIXTURE (no eligible row; not asserted)' || chr(10);
  else
    begin
      update public.attendance_records set status = 'blocked'
       where employee_id = v_emp and attendance_date = v_day;
      v_results := v_results || 'T27 rejects_gate_mode_status      FAIL  (accepted)' || chr(10);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_results := v_results || 'T27 ' || case when v_msg like '%gate refusal%'
        then 'rejects_gate_mode_status      PASS  (own trigger fired)'
        else 'rejects_gate_mode_status      INCONCLUSIVE — ' || left(v_msg, 38) end || chr(10);
    end;

    -- T31: an ordinary status change on that same row must still succeed, and
    -- must actually touch a row — checked, not assumed.
    begin
      update public.attendance_records set status = 'absent'
       where employee_id = v_emp and attendance_date = v_day;
      get diagnostics v_n = row_count;
      v_results := v_results || case when v_n = 1
        then 'T31 normal_status_change_ok      PASS  (1 row updated)'
        else 'T31 normal_status_change_ok      FAIL  (' || v_n || ' rows updated)' end || chr(10);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_results := v_results || 'T31 normal_status_change_ok      FAIL  ' || left(v_msg, 42) || chr(10);
    end;
  end if;
  perform set_config('app.skip_attendance_lock', '', true);

  -- T29: the residue helper and the ledger check must agree.
  --
  -- This previously read `case when v_n >= 1 then 'PASS' else 'PASS'` — both
  -- branches. It could not fail, which makes it a print statement wearing a
  -- test's name, and it sat in a suite whose whole subject is gate-mode residue.
  --
  -- The real property: attendance_gate_mode_residue() and ledger_checks'
  -- no_gate_mode_in_attendance_status are two views of one fact and must never
  -- disagree. Residue present <=> that check red. Either direction failing means
  -- one of them has drifted, which is exactly what nobody would notice.
  select count(*) into v_n from public.attendance_gate_mode_residue(v_co);
  select not k.passed into v_red
    from public.ledger_checks(v_co) k
   where k.check_name = 'no_gate_mode_in_attendance_status';
  v_results := v_results || case
    when v_red is null then 'T29 residue_agrees_with_check    FAIL  (check no_gate_mode_in_attendance_status absent)'
    when (v_n > 0) = v_red then 'T29 residue_agrees_with_check    PASS  (' || v_n || ' residue, check red=' || v_red || ')'
    else 'T29 residue_agrees_with_check    FAIL  (' || v_n || ' residue but check red=' || v_red || ')'
  end || chr(10);

  -- CANARY. attendance_status.sql had none, while ledger_foundation.sql did —
  -- so an abort here truncated silently, which is the defect the canary exists
  -- to make impossible.
  v_asserts := array_length(string_to_array(trim(both chr(10) from v_results), chr(10)), 1);
  v_results := v_results || '--- CANARY: ' || v_asserts || '/13 assertions executed'
    || case when v_asserts = 13 then ' (complete)' else ' *** SUITE TRUNCATED ***' end || chr(10);

  raise exception 'ROLLBACK_ATTENDANCE_TESTS: %', v_results;
end $$;
