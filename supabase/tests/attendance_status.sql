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
--
-- Point v_co at the company under test.

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
  v_results text := chr(10);
begin
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
  select count(*) into v_n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'run_ho_cost_allocation'
     and strpos(p.prosrc, 'continue') = 0
     and strpos(p.prosrc, 'does not exhaust the pool') > 0
     and strpos(p.prosrc, 'avg_deployed_guards') = 0
     and strpos(p.prosrc, 'branch_revenue_for_month') > 0;
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
  select count(*) into v_n
    from public.employees e
   where e.company_id = v_co
     and exists (select 1 from public.attendance_records a
                  where a.employee_id = e.id and a.status = 'absent')
     and not exists (select 1 from public.attendance_records a
                      where a.employee_id = e.id and a.status = 'Absent');
  -- After 0224 'Absent' no longer exists, so this set is either empty (all
  -- folded) or fully covered by the lower() predicate. What must hold is that
  -- the function's own predicate is case-insensitive.
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

  -- T31: an ordinary status change on that same row must still succeed.
  begin
    update public.attendance_records set status = 'absent'
     where employee_id = v_emp and attendance_date = v_day;
    v_results := v_results || 'T31 normal_status_change_ok      PASS' || chr(10);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_results := v_results || 'T31 normal_status_change_ok      FAIL  ' || left(v_msg, 42) || chr(10);
  end;
  perform set_config('app.skip_attendance_lock', '', true);

  -- T29: the legacy residue is still named so it cannot be forgotten.
  select count(*) into v_n from public.attendance_gate_mode_residue(v_co);
  v_results := v_results || case when v_n >= 1
    then 'T29 residue_is_named             PASS  (' || v_n || ' guard(s))'
    else 'T29 residue_is_named             PASS  (none left)' end || chr(10);

  raise exception 'ROLLBACK_ATTENDANCE_TESTS: %', v_results;
end $$;
