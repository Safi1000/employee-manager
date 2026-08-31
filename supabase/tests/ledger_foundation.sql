-- Ledger foundation tests — migrations 0219 (Part B) and 0220 (maintenance gate).
--
-- Run in the SQL editor or psql. Self-rolling-back: the final RAISE aborts the
-- transaction, so nothing is left behind. Every test below fails against the
-- pre-0219 schema and passes after 0219 + 0220.
--
--   T1   post_journal() silently dropped unresolvable lines          (0219 B1)
--   T2   post_journal() never checked debits = credits               (0219 B2)
--   T3   nothing stopped a direct unbalanced INSERT                  (0219 B2)
--   T4   reconciliation checks 1-3 green for every company           (0219 E4)
--   T5   posted entry was editable by any company-less session       (0220)
--   T6   posted entry was deletable by any company-less session      (0220)
--   T7   maintenance flag genuinely opens the gate                   (0220)
--   T8   app roles can never satisfy the role gate                   (0220)
--   T9   flag off => not maintenance, even as postgres               (0220)
--   T10  no source-record cascades into the journal remain           (0220)
--   T11  journal triggers still post after post_journal was recreated(0220)
--   T12  advances hit employee advances, not client AR, w/ dimension (0219 A7)
--   T13-T15 payroll accrues independently of disbursement           (0222 A5)
--   T16  failing-check set still equals the expected-red allowlist   (0229)
--
-- T4 and T16 assert the SET of failing ledger_checks against v_expected_red,
-- not a count of zero. Two checks are red BY DESIGN. A suite that is
-- permanently red trains a reader to skip the line.
--
-- The run ends with a CANARY line stating how many assertions executed. T9
-- called is_ledger_maintenance() — dropped by 0224 — from 0224 until
-- 2026-08-31, which aborted the block at T9 and silently skipped T10-T16.
--
-- Point v_co at the company under test.

do $$
declare
  v_co      uuid := '5eed0000-0000-4000-8000-000000000001';  -- SANDBOX TESTING ORG
  v_ar      uuid;
  v_emp     uuid;
  v_e       uuid;
  v_msg     text;
  v_n       int;
  v_ok      boolean;
  v_failed  int;
  v_red     text[];
  v_asserts int;
  -- Checks that are MEANT to be red. A permanently-red harness trains people to
  -- skip the line, which is how a two-failure state became invisible. Assert the
  -- failing SET against this allowlist, so a check that STOPS being red without
  -- this list changing is itself a failure.
  v_expected_red text[] := array[
    'no_billing_clients_on_head_office',   -- Ironclad filed on Head Office
    'no_gate_mode_in_attendance_status'    -- 24 leaked gate-mode rows
  ];
  v_results text := chr(10);
begin
  select id into v_ar from public.chart_of_accounts
   where company_id = v_co and system_key = 'ar';
  if v_ar is null then
    raise exception 'No AR account for company % — run seed_chart_of_accounts() first', v_co;
  end if;

  -- T1: an unresolvable account key must raise, not drop the line.
  begin
    perform public.post_journal(v_co, current_date, 'ledger test 1',
      'zz_test', gen_random_uuid(), false,
      jsonb_build_array(
        jsonb_build_object('key', 'ar',                  'debit', 100, 'credit', 0),
        jsonb_build_object('key', 'no_such_account_key', 'debit', 0,   'credit', 100)));
    v_results := v_results || 'T1  unresolved_account_key       FAIL (no exception)' || chr(10);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    -- ASSERT ON THE MESSAGE. "Something raised" is not the assertion: an
    -- unrelated constraint, a typo in the fixture or a permission error would
    -- all satisfy it. Only post_journal's own refusal proves the line was
    -- rejected rather than silently dropped, which is the B1 defect.
    v_results := v_results || case when v_msg like '%cannot resolve account%'
      then 'T1  unresolved_account_key       PASS  (post_journal refused the key)'
      else 'T1  unresolved_account_key       INCONCLUSIVE — ' || left(v_msg, 44) end || chr(10);
  end;

  -- T2: post_journal must reject an unbalanced entry.
  begin
    perform public.post_journal(v_co, current_date, 'ledger test 2',
      'zz_test', gen_random_uuid(), false,
      jsonb_build_array(
        jsonb_build_object('key', 'ar',   'debit', 100, 'credit', 0),
        jsonb_build_object('key', 'bank', 'debit', 0,   'credit', 70)));
    v_results := v_results || 'T2  unbalanced_via_post_journal  FAIL (no exception)' || chr(10);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_results := v_results || case when v_msg like '%post_journal: entry does not balance%'
      then 'T2  unbalanced_via_post_journal  PASS  (refused by post_journal)'
      else 'T2  unbalanced_via_post_journal  INCONCLUSIVE — ' || left(v_msg, 44) end || chr(10);
  end;

  -- T3: a direct INSERT bypassing post_journal must also fail.
  begin
    v_e := gen_random_uuid();
    insert into public.journal_entries
      (id, company_id, entry_date, description, source_table, source_id,
       is_reversal, status, posting_period)
    values
      (v_e, v_co, current_date, 'ledger test 3', 'zz_test', gen_random_uuid(),
       false, 'posted', date_trunc('month', current_date)::date);
    insert into public.journal_lines (journal_entry_id, account_id, debit, credit)
      values (v_e, v_ar, 500, 0);
    set constraints all immediate;  -- force the deferred balance check now
    v_results := v_results || 'T3  unbalanced_direct_insert     FAIL (no exception)' || chr(10);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    -- Must be the DEFERRED CONSTRAINT, not post_journal. The whole point of T3
    -- is that a write bypassing the RPC is still caught, so a message from
    -- post_journal here would mean the test proved nothing.
    v_results := v_results || case
      when v_msg like '%post_journal%'
        then 'T3  unbalanced_direct_insert     FAIL  (post_journal answered; constraint untested)'
      when v_msg like '%does not balance%'
        then 'T3  unbalanced_direct_insert     PASS  (deferred constraint fired)'
      else 'T3  unbalanced_direct_insert     INCONCLUSIVE — ' || left(v_msg, 44) end || chr(10);
  end;

  -- T4: the failing set must equal the expected-red allowlist exactly.
  select coalesce(array_agg(distinct k.check_name order by k.check_name), '{}')
    into v_red
    from public.companies c
    cross join lateral public.ledger_checks(c.id) k
   where not k.passed;
  v_results := v_results || case when v_red = v_expected_red
    then 'T4  ledger_checks_allowlist      PASS  (failing set = expected red)'
    else 'T4  ledger_checks_allowlist      FAIL  got {' || array_to_string(v_red, ',') || '}' end || chr(10);

  select id into v_e from public.journal_entries
   where company_id = v_co and status = 'posted' limit 1;

  -- T5: no company context and NO maintenance flag must be refused.
  -- Under 0219 alone this was ALLOWED — that was the hole 0220 closes.
  perform set_config('app.ledger_maintenance', '', true);
  begin
    update public.journal_entries set description = 'TAMPERED' where id = v_e;
    v_results := v_results || 'T5  update_posted_no_flag        FAIL (allowed!)' || chr(10);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_results := v_results || case when v_msg like '%Posted journal rows are immutable%'
      then 'T5  update_posted_no_flag        PASS  (immutability trigger fired)'
      else 'T5  update_posted_no_flag        INCONCLUSIVE — ' || left(v_msg, 44) end || chr(10);
  end;

  -- T6: DELETE likewise refused.
  begin
    delete from public.journal_entries where id = v_e;
    v_results := v_results || 'T6  delete_posted_no_flag        FAIL (allowed!)' || chr(10);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_results := v_results || case when v_msg like '%Posted journal rows are immutable%'
      then 'T6  delete_posted_no_flag        PASS  (immutability trigger fired)'
      else 'T6  delete_posted_no_flag        INCONCLUSIVE — ' || left(v_msg, 44) end || chr(10);
  end;

  -- T7: flag on + privileged session_user opens the gate.
  perform set_config('app.ledger_maintenance', 'on', true);
  begin
    update public.journal_entries set description = description where id = v_e;
    v_results := v_results || 'T7  update_posted_with_flag      PASS  (maintenance permitted)' || chr(10);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_results := v_results || 'T7  update_posted_with_flag      FAIL  ' || left(v_msg, 58) || chr(10);
  end;
  perform set_config('app.ledger_maintenance', '', true);

  -- T8: app roles can never satisfy the role gate, flag or no flag.
  select count(*) into v_n from pg_roles
   where rolname in ('authenticator', 'authenticated', 'anon')
     and (rolsuper or rolbypassrls);
  v_results := v_results || case when v_n = 0
    then 'T8  app_roles_cannot_maintain    PASS  (0 of 3 privileged)'
    else 'T8  app_roles_cannot_maintain    FAIL  (' || v_n || ' privileged)' end || chr(10);

  -- T9: flag off => not maintenance, even for postgres.
  select public.is_maintenance_session() into v_ok;   -- renamed by 0224
  v_results := v_results || case when not v_ok
    then 'T9  flag_off_is_not_maintenance  PASS'
    else 'T9  flag_off_is_not_maintenance  FAIL' end || chr(10);

  -- T10: only the entry->lines composition cascade may remain.
  select count(*) into v_n
    from pg_constraint c join pg_class r on r.oid = c.conrelid
   where c.contype = 'f'
     and r.relname in ('journal_entries', 'journal_lines')
     and c.confdeltype in ('c', 'n')
     and c.conname <> 'journal_lines_journal_entry_id_fkey';
  v_results := v_results || case when v_n = 0
    then 'T10 no_source_cascades           PASS  (composition cascade only)'
    else 'T10 no_source_cascades           FAIL  (' || v_n || ' cascade/set-null left)' end || chr(10);

  -- T11/T12: triggers still post after post_journal was dropped/recreated, and
  -- an advance lands in employee advances with its employee dimension set.
  select id into v_emp from public.employees where company_id = v_co limit 1;
  insert into public.advances (company_id, employee_id, amount, advance_date, payment_mode)
    values (v_co, v_emp, 1234, current_date, 'Bank');

  select count(*) into v_n from public.journal_entries
   where company_id = v_co and source_table = 'advances' and entry_date = current_date;
  v_results := v_results || case when v_n > 0
    then 'T11 advance_trigger_still_posts  PASS'
    else 'T11 advance_trigger_still_posts  FAIL (no entry posted)' end || chr(10);

  select count(*) into v_n
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.source_table = 'advances' and je.entry_date = current_date
     and a.system_key = 'employee_advances_receivable'
     and jl.employee_id is not null;
  v_results := v_results || case when v_n = 1
    then 'T12 advance_hits_correct_account PASS  (employee_id dimension set)'
    else 'T12 advance_hits_correct_account FAIL' end || chr(10);

  -- T13-T16 (0222): payroll accrues independently of disbursement (A5), and a
  -- payslip carrying advance recovery, employee EOBI, salary tax AND the
  -- employer EOBI share still balances and leaves every control reconciled.
  insert into public.payslips
    (company_id, employee_id, period_month, base_salary, final_salary, net_salary,
     advance, eobi, income_tax, eobi_employer, disbursed, payment_mode)
  values
    (v_co, v_emp, '2026-05-01', 30000, 30000, 27780, 500, 370, 1350, 1850, false, 'Bank')
  returning id into v_e;

  select count(*) into v_n from public.journal_entries
   where source_table = 'payslips' and source_id = v_e;
  v_results := v_results || case when v_n = 1
    then 'T13 accrual_posts_undisbursed    PASS  (A5: accrual is not gated on payment)'
    else 'T13 accrual_posts_undisbursed    FAIL' end || chr(10);

  select count(*) into v_n from public.journal_entries
   where source_table = 'payslips_disbursement' and source_id = v_e;
  v_results := v_results || case when v_n = 0
    then 'T14 no_disbursement_yet          PASS'
    else 'T14 no_disbursement_yet          FAIL' end || chr(10);

  update public.payslips set disbursed = true, disbursed_at = now() where id = v_e;
  select count(*) into v_n from public.journal_entries
   where source_table = 'payslips_disbursement' and source_id = v_e;
  v_results := v_results || case when v_n = 1
    then 'T15 disbursement_posts           PASS'
    else 'T15 disbursement_posts           FAIL' end || chr(10);

  select coalesce(array_agg(distinct k.check_name order by k.check_name), '{}')
    into v_red
    from public.companies c cross join lateral public.ledger_checks(c.id) k where not k.passed;
  v_results := v_results || case when v_red = v_expected_red
    then 'T16 checks_after_full_payroll    PASS  (failing set unchanged)'
    else 'T16 checks_after_full_payroll    FAIL  got {' || array_to_string(v_red, ',') || '}' end || chr(10);

  -- CANARY. A harness whose silence cannot be told apart from "all good" and
  -- "died at line 40" is not a harness. T9 aborted this suite from 0224 until
  -- 2026-08-31 and nobody could see it from the output.
  v_asserts := array_length(string_to_array(trim(both chr(10) from v_results), chr(10)), 1);
  v_results := v_results || '--- CANARY: ' || v_asserts || '/16 assertions executed'
    || case when v_asserts = 16 then ' (complete)' else ' *** SUITE TRUNCATED ***' end || chr(10);

  raise exception 'ROLLBACK_LEDGER_TESTS: %', v_results;
end $$;
