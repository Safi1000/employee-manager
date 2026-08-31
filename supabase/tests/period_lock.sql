-- Period lock — what a closed month refuses, and what it lets through.
--
-- Run inside a transaction; the final RAISE rolls everything back, including
-- the accounting_periods row this suite closes.
--
--   psql "$DATABASE_URL" -f supabase/tests/period_lock.sql
--
-- WHY THIS SUITE EXISTS
--
-- accounting_periods is empty on prod and dev. Zero months have ever been
-- closed, so before this file nothing in the system had ever exercised the
-- period lock at all. Every assertion here is the first time that code path has
-- run.
--
-- ASSERTING ON THE MESSAGE, NOT ON THE RAISE
--
-- The trap this suite is built to avoid: an edit to payslips.final_salary in a
-- closed month raises whether the PAYSLIPS lock refuses it or the JOURNAL lock
-- does, because journal_on_payslip reposts the accrual at old.period_month.
-- Before 0237 the payslips carve-out permitted every column and the journal lock
-- was doing the work — a test asserting "something raised" would have passed
-- against a completely open carve-out.
--
-- 0237 appends the refusing table to each message, so every assertion below
-- checks for '[payslips]' or '[invoice_payments]' specifically. That is the only
-- thing that makes these tests mean what their names say.
--
-- Trigger timing makes this sound: the period lock is BEFORE UPDATE and
-- journal_on_payslip is AFTER, so when the payslips lock refuses, it refuses
-- first and the journal trigger never runs.

do $suite$
declare
  v_co      uuid;
  v_emp     uuid;
  v_client  uuid;
  v_payslip uuid;
  v_invoice uuid;
  v_month   date := date_trunc('month', current_date - interval '2 months')::date;
  v_results text := '';
  v_asserts int;
  v_msg     text;
  v_n       int;

  -- Every money column the old carve-out wrongly permitted.
  c_protected constant text[] := array[
    'final_salary', 'net_salary', 'base_salary', 'bonus',
    'deductions', 'advance', 'income_tax', 'eobi'
  ];
  v_col     text;
  v_t       int := 0;
  v_profile uuid;
begin
  perform set_config('app.ledger_maintenance', 'on', true);

  select id into v_co from public.companies where name = 'SANDBOX TESTING ORG';
  if v_co is null then
    raise exception 'period_lock suite needs SANDBOX TESTING ORG; not found';
  end if;

  -- THE PRECONDITION THAT MAKES THIS SUITE MEAN ANYTHING.
  --
  -- enforce_period_lock() opens with:
  --   if current_company_id() is null and not is_ssa_unscoped() then return ...
  -- and current_company_id() reads profiles via auth.uid(). In a service-role
  -- or psql session there is no JWT, so auth.uid() is null, the lock returns
  -- early and enforces NOTHING. Every "allowed" assertion below would pass for
  -- the wrong reason and every "refused" one would fail confusingly.
  --
  -- So: adopt a real profile in the sandbox company, then ASSERT the lock is
  -- actually live before running a single test.
  select id into v_profile from public.profiles where company_id = v_co limit 1;
  if v_profile is null then
    raise exception 'period_lock suite needs a profile in SANDBOX TESTING ORG to act as';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_profile)::text, true);

  if public.current_company_id() is distinct from v_co then
    raise exception
      'period_lock suite ABORTED: current_company_id() is % but the suite acts for %. The lock would return early and every assertion below would be vacuous.',
      coalesce(public.current_company_id()::text, 'NULL'), v_co;
  end if;

  select id into v_emp from public.employees where company_id = v_co limit 1;
  select id into v_client from public.clients where company_id = v_co limit 1;

  -- A payslip and an invoice dated in the month we are about to close.
  insert into public.payslips
    (company_id, employee_id, period_month, base_salary, final_salary, net_salary,
     bonus, deductions, advance, eobi, income_tax, eobi_employer, disbursed, payment_mode)
  values
    (v_co, v_emp, v_month, 40000, 40000, 37000, 1000, 500, 2000, 370, 1130, 1850, false, 'Bank')
  returning id into v_payslip;

  insert into public.invoices
    (company_id, client_id, invoice_number, invoice_date, period_start, period_end,
     invoice_amount, subtotal, total_due, amount_received, status)
  values
    (v_co, v_client, 'PLOCK-001', v_month, v_month,
     (v_month + interval '1 month - 1 day')::date, 100000, 100000, 100000, 0, 'Unpaid')
  returning id into v_invoice;

  -- Close the month. Everything below runs against a genuinely closed period.
  insert into public.accounting_periods (company_id, period_month, closed_at)
  values (v_co, v_month, now());

  if not public.is_period_closed(v_co, v_month) then
    raise exception 'period_lock suite could not close %; nothing below would mean anything', v_month;
  end if;

  -- T1..T8 — every money column must be refused BY THE PAYSLIPS LOCK.
  foreach v_col in array c_protected loop
    v_t := v_t + 1;
    begin
      execute format('update public.payslips set %I = %I + 1 where id = $1', v_col, v_col)
        using v_payslip;
      v_results := v_results || 'T' || v_t || ' payslip_' || rpad(v_col, 14)
        || ' FAIL  (edit accepted in a closed month)' || chr(10);
    exception when others then
      v_msg := sqlerrm;
      v_results := v_results || 'T' || v_t || ' payslip_' || rpad(v_col, 14)
        || case when v_msg like '%[payslips]%'
                then ' PASS  (refused by the payslips lock)'
                when v_msg like '%[journal_entries]%'
                then ' FAIL  (only the journal lock caught it — carve-out still open)'
                else ' FAIL  (' || left(v_msg, 60) || ')' end || chr(10);
    end;
  end loop;

  -- T9 — disbursement fields are the permitted set and must pass.
  begin
    update public.payslips
       set disbursed = true, disbursed_at = now(), amount_paid = 37000,
           status = 'Cleared', notes = 'period_lock suite'
     where id = v_payslip;
    v_results := v_results || 'T9  payslip_disbursement_allowed  PASS' || chr(10);
  exception when others then
    v_results := v_results || 'T9  payslip_disbursement_allowed  FAIL  ('
      || left(sqlerrm, 70) || ')' || chr(10);
  end;

  -- T10 — moving a payslip between months is NOT in the permitted set.
  begin
    update public.payslips set period_month = v_month + interval '1 month' where id = v_payslip;
    v_results := v_results || 'T10 payslip_month_move_refused    FAIL  (accepted)' || chr(10);
  exception when others then
    v_msg := sqlerrm;
    v_results := v_results || 'T10 payslip_month_move_refused    '
      || case when v_msg like '%[payslips]%' then 'PASS' else 'FAIL  (' || left(v_msg, 50) || ')' end || chr(10);
  end;

  -- T11 — carve-out (a): a receipt updating the cumulative total is allowed.
  begin
    update public.invoices set amount_received = 25000, status = 'Partly-Paid' where id = v_invoice;
    v_results := v_results || 'T11 invoice_amount_received_ok    PASS  (cumulative, GL-neutral)' || chr(10);
  exception when others then
    v_results := v_results || 'T11 invoice_amount_received_ok    FAIL  ('
      || left(sqlerrm, 70) || ')' || chr(10);
  end;

  -- T12 — but moving the invoice itself is still refused.
  begin
    update public.invoices set invoice_amount = 120000 where id = v_invoice;
    v_results := v_results || 'T12 invoice_amount_refused        FAIL  (accepted)' || chr(10);
  exception when others then
    v_msg := sqlerrm;
    v_results := v_results || 'T12 invoice_amount_refused        '
      || case when v_msg like '%[invoices]%' then 'PASS' else 'FAIL  (' || left(v_msg, 50) || ')' end || chr(10);
  end;

  -- T13 — carve-out (b) is gone: a BACKDATED receipt is refused by the
  -- invoice_payments lock itself, not by the journal lock downstream.
  begin
    insert into public.invoice_payments
      (company_id, invoice_id, client_id, amount, payment_date, payment_mode)
    values (v_co, v_invoice, v_client, 5000, v_month + 5, 'Cash');
    v_results := v_results || 'T13 backdated_receipt_refused     FAIL  (accepted)' || chr(10);
  exception when others then
    v_msg := sqlerrm;
    v_results := v_results || 'T13 backdated_receipt_refused     '
      || case when v_msg like '%[invoice_payments]%'
              then 'PASS  (refused at the payment, not downstream)'
              when v_msg like '%[journal_entries]%'
              then 'FAIL  (carve-out still present; journal lock caught it)'
              else 'FAIL  (' || left(v_msg, 50) || ')' end || chr(10);
  end;

  -- T14 — a receipt dated in an OPEN month against a closed-month invoice is
  -- the normal case and must still work. This is what carve-out (a) protects.
  begin
    insert into public.invoice_payments
      (company_id, invoice_id, client_id, amount, payment_date, payment_mode)
    values (v_co, v_invoice, v_client, 5000, current_date, 'Cash');
    v_results := v_results || 'T14 current_month_receipt_ok      PASS' || chr(10);
  exception when others then
    v_results := v_results || 'T14 current_month_receipt_ok      FAIL  ('
      || left(sqlerrm, 70) || ')' || chr(10);
  end;

  -- T15 — the journal lock has no carve-out and never had one.
  begin
    insert into public.journal_entries (company_id, entry_date, description, source_table)
    values (v_co, v_month + 3, 'period_lock suite', 'manual');
    v_results := v_results || 'T15 journal_entry_refused         FAIL  (accepted)' || chr(10);
  exception when others then
    v_msg := sqlerrm;
    v_results := v_results || 'T15 journal_entry_refused         '
      || case when v_msg like '%[journal_entries]%' then 'PASS' else 'FAIL  (' || left(v_msg, 50) || ')' end || chr(10);
  end;

  -- T16 — reopening restores writes. A lock that cannot be lifted is an outage.
  delete from public.accounting_periods where company_id = v_co and period_month = v_month;
  begin
    update public.payslips set final_salary = 40001 where id = v_payslip;
    v_results := v_results || 'T16 reopen_restores_writes        PASS' || chr(10);
  exception when others then
    v_results := v_results || 'T16 reopen_restores_writes        FAIL  ('
      || left(sqlerrm, 70) || ')' || chr(10);
  end;

  -- CANARY. Silence must not be ambiguous between "all passed" and "aborted".
  v_asserts := array_length(string_to_array(trim(both chr(10) from v_results), chr(10)), 1);
  v_results := v_results || '--- CANARY: ' || v_asserts || '/16 assertions executed'
    || case when v_asserts = 16 then ' (complete)' else ' *** SUITE TRUNCATED ***' end || chr(10);

  raise exception 'ROLLBACK_PERIOD_LOCK_TESTS: %', v_results;
end
$suite$;
