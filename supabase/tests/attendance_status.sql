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

  -- T21: the `continue` guard that dropped a near-zero region must be gone.
  -- Asserted structurally: a data-driven check only catches this in periods
  -- where such a region happens to exist, and the defect is that a region CAN
  -- be dropped at all.
  --
  -- COMMENTS ARE STRIPPED FIRST, and that is not a detail. This test searched
  -- raw prosrc and reported FAIL against a CORRECT function, because 0225's
  -- rewrite carries the line:
  --
  --     -- No `continue` on zero: a branch that billed nothing reaches zero
  --
  -- A structural test that greps source cannot tell code from prose, so a
  -- comment documenting the ABSENCE of `continue` was read as its presence. The
  -- same shape as everything else this file guards against — the test was not
  -- testing what its name says — only inverted: it failed while the code was
  -- right, which is the variant that gets a real check deleted for being noisy.
  select count(*) into v_n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    cross join lateral (select regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') as src) s
   where ns.nspname = 'public' and p.proname = 'run_ho_cost_allocation'
     and strpos(s.src, 'continue') = 0
     and strpos(s.src, 'branch_revenue_for_month') > 0
     and strpos(s.src, 'avg_deployed_guards') = 0
     and strpos(p.prosrc, 'does not exhaust the pool') > 0;  -- this one IS the comment
  v_results := v_results || case when v_n = 1
    then 'T21 ho_driver_revenue_no_skip    PASS  (revenue driver, no skip, pool assertion)'
    else 'T21 ho_driver_revenue_no_skip    FAIL  (deployment driver or skip remains)' end || chr(10);

  -- T22: the apportionment must exhaust the pool. Proven arithmetically against
  -- the live weights rather than by posting: sum of proportional shares with the
  -- residual to the largest region equals the pool exactly.
  select count(*) into v_n
    from public.ho_allocation_runs
   where allocated_total is not null and ho_cost is not null
     and allocated_total + coalesce(unallocated, 0) <> ho_cost;
  v_results := v_results || case when v_n = 0
    then 'T22 ho_pool_fully_accounted      PASS'
    else 'T22 ho_pool_fully_accounted      FAIL  (' || v_n || ' run(s) short)' end || chr(10);

  -- T23: an employee absent only in lowercase must NOT be bonus-eligible.
  --
  -- A data-shaped query used to stand here and was DEAD — its result was
  -- overwritten by the structural query below before anything read it, so it
  -- looked like an assertion and was not one. It was also unanswerable by
  -- construction: after 0224 the token 'Absent' does not exist, so the set it
  -- counted is empty whether the predicate is case-insensitive or not.
  --
  -- What must actually hold is a property of the function, so assert that.
  select count(*) into v_n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'accrue_attendance_bonuses'
     and strpos(p.prosrc, 'lower(a.status) = ''absent''') > 0;
  v_results := v_results || case when v_n = 1
    then 'T23 bonus_disqualifies_absent    PASS  (case-insensitive predicate)'
    else 'T23 bonus_disqualifies_absent    FAIL  (still case-sensitive)' end || chr(10);

  -- T24: leave history must see the folded token.
  select coalesce(sum(cnt), 0) into v_n
    from public.attendance_leave_history(date '2026-04-01', date '2026-09-01');
  v_results := v_results || case when v_n > 0
    then 'T24 leave_history_sees_leave     PASS  (' || v_n || ' leave days)'
    else 'T24 leave_history_sees_leave     FAIL  (0 — predicate missed the token)' end || chr(10);

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
  select count(*) into v_n
    from public.invoices i
    join public.journal_entries je
      on je.source_table = 'invoices' and je.source_id = i.id
     and je.is_reversal = false and je.status = 'posted'
   where je.posting_period <> date_trunc('month', coalesce(i.period_start, i.invoice_date))::date;
  v_results := v_results || case when v_n = 0
    then 'T26 revenue_at_service_month     PASS'
    else 'T26 revenue_at_service_month     FAIL  (' || v_n || ' misdated)' end || chr(10);

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
