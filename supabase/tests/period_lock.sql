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
  v_expected int;
  c_fixed_tests constant int := 11;  -- T1..T11 below; hand-maintained, and independent of the derived sets
  v_msg     text;
  v_n       int;

  -- THE PROTECTED SET IS DERIVED FROM THE SCHEMA, NOT HAND-LISTED.
  --
  -- It used to be eight names typed out by hand — the columns the old carve-out
  -- wrongly permitted. That list could only ever describe the bug it was written
  -- against. payslips has seventeen numeric columns; the hand-list covered eight,
  -- so allowance, eobi_employer, per_day_salary and five day counts were refused
  -- by the lock and proved by nothing. eobi_employer is the employer statutory
  -- share: a direct client cost that feeds client Net Cash and therefore partner
  -- remuneration, so an unproven lock on it is an F4 problem, not a tidiness one.
  --
  -- Derived means a money column added to payslips next month joins the protected
  -- set automatically instead of falling into neither list. The hand-maintained
  -- half is the PERMITTED list, which is short, and which is what 0237 actually
  -- decided.
  c_permitted_numeric constant text[] := array['amount_paid'];
  v_protected text[];
  v_col     text;
  v_t       int := 0;
  v_profile uuid;

  -- THE INVOICES HALF, DERIVED THE SAME WAY — AND FOR THE SAME REASON.
  --
  -- This suite tested invoices with two hand-picked assertions: T3 (a receipt is
  -- allowed) and T4 (invoice_amount is refused). Both passed against 0237's
  -- carve-out, which pinned six columns by name and let the other twenty-seven
  -- ride along with any update that also moved amount_received — subtotal,
  -- total_due, tax_added_total, tax_withheld_total, previous_balance,
  -- period_start, branch_id, contract_id among them. T3 and T4 could not see
  -- that, because a hand-picked pair can only ever describe the columns whoever
  -- wrote it was already thinking about. That is G0.2, and it is the payslips
  -- lesson repeating on the other table.
  --
  -- Derived means a money or date column added to invoices next month joins the
  -- protected set automatically. The hand-maintained half is the PERMITTED list,
  -- which is short, and which is what 0253 actually decided.
  c_invoice_permitted constant text[] := array[
    'amount_received', 'status', 'notes', 'updated_at',
    'attachment_path', 'attachment_file_name', 'drive_file_id', 'drive_view_url'
  ];
  v_inv_protected text[];
  v_branch  uuid;
  v_contract uuid;
begin
  perform set_config('app.ledger_maintenance', 'on', true);

  -- Generated columns are excluded because UPDATE on one raises "cannot update
  -- a generated column", which is not the period lock refusing and would be
  -- scored as a pass by a suite that only checked that something raised.
  select array_agg(c.column_name order by c.column_name)
    into v_protected
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name   = 'payslips'
     and c.data_type in ('numeric','integer','bigint','smallint','double precision','real')
     and c.is_generated = 'NEVER'
     and not (c.column_name = any (c_permitted_numeric));

  -- Non-vacuity. A derived set that comes back empty or tiny would make every
  -- assertion below silently disappear and the suite would still print PASS for
  -- everything it did run.
  if coalesce(array_length(v_protected, 1), 0) < 12 then
    raise exception 'period_lock suite ABORTED: derived protected set is % column(s); payslips should yield at least 12',
      coalesce(array_length(v_protected, 1), 0);
  end if;

  -- The same derivation for invoices. Numeric AND date columns, because the
  -- columns 0237 left open were not all money: period_start is the date
  -- journal_on_invoice reposts the accrual at, and moving it moves the charge
  -- between months. Restricting to numeric would have reproduced the original
  -- blind spot in a new place.
  select array_agg(c.column_name order by c.column_name)
    into v_inv_protected
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name   = 'invoices'
     and c.data_type in ('numeric','integer','bigint','smallint','double precision','real','date')
     and c.is_generated = 'NEVER'
     and not (c.column_name = any (c_invoice_permitted));

  if coalesce(array_length(v_inv_protected, 1), 0) < 8 then
    raise exception 'period_lock suite ABORTED: derived invoice protected set is % column(s); invoices should yield at least 8',
      coalesce(array_length(v_inv_protected, 1), 0);
  end if;

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

  -- A non-head-office branch, so T9 has something real to move the invoice off.
  select id into v_branch from public.branches
   where company_id = v_co and not coalesce(is_head_office, false) limit 1;

  -- A contract with no invoice in the month we are about to close. Two reasons,
  -- both learned the hard way:
  --   * uq_invoice_contract_month is unique on (contract_id, month), so a
  --     contract already invoiced for v_month makes the fixture insert fail.
  --   * T10 nulls contract_id, and the fixture must therefore START non-null.
  --     Left NULL, `set contract_id = null` is a no-op, the carve-out correctly
  --     permits it, and T10 reports the column as unprotected when it is not.
  --     That is instance eleven, and it caught this suite a second time.
  select c.id into v_contract
    from public.contracts c
   where c.company_id = v_co
     and not exists (
       select 1 from public.invoices i
        where i.contract_id = c.id
          and date_trunc('month', coalesce(i.period_start, i.invoice_date)) = v_month)
   limit 1;
  if v_contract is null then
    raise exception 'period_lock suite ABORTED: every contract in SANDBOX TESTING ORG already has an invoice in %; T10 would test a no-op', v_month;
  end if;

  -- Every money column is populated. A NULL column mutated with coalesce(col,0)+1
  -- still changes, but a fixture that leaves the disputed columns NULL is one
  -- schema change away from testing nothing — and these are exactly the columns
  -- 0237 left open, so they are the ones that must be unambiguously present.
  insert into public.invoices
    (company_id, client_id, branch_id, contract_id, invoice_number, invoice_date, period_start, period_end,
     invoice_amount, subtotal, total_due, amount_received, status,
     tax_added_total, tax_withheld_total, previous_balance, withholding_tax)
  values
    (v_co, v_client, v_branch, v_contract, 'PLOCK-001', v_month, v_month,
     (v_month + interval '1 month - 1 day')::date, 100000, 85000, 118000, 0, 'Unpaid',
     15000, 2000, 20000, 2000)
  returning id into v_invoice;

  -- Close the month. Everything below runs against a genuinely closed period.
  insert into public.accounting_periods (company_id, period_month, closed_at)
  values (v_co, v_month, now());

  if not public.is_period_closed(v_co, v_month) then
    raise exception 'period_lock suite could not close %; nothing below would mean anything', v_month;
  end if;

  -- C01..Cnn — every numeric column outside the carve-out must be refused BY
  -- THE PAYSLIPS LOCK, not by the journal lock downstream.
  foreach v_col in array v_protected loop
    v_t := v_t + 1;
    begin
      -- coalesce, because the mutation must actually CHANGE the row. per_day_salary
      -- is nullable and NULL + 1 is NULL, so the update was a no-op and 0237's
      -- carve-out correctly permitted it — the suite then scored a false FAIL
      -- against a lock that was behaving properly. A test whose mutation does
      -- nothing tests nothing.
      execute format('update public.payslips set %I = coalesce(%I, 0) + 1 where id = $1', v_col, v_col)
        using v_payslip;
      v_results := v_results || 'C' || lpad(v_t::text, 2, '0') || ' payslip_' || rpad(v_col, 15)
        || ' FAIL  (edit accepted in a closed month)' || chr(10);
    exception when others then
      v_msg := sqlerrm;
      v_results := v_results || 'C' || lpad(v_t::text, 2, '0') || ' payslip_' || rpad(v_col, 15)
        || case when v_msg like '%[payslips]%'
                then ' PASS  (refused by the payslips lock)'
                when v_msg like '%[journal_entries]%'
                then ' FAIL  (only the journal lock caught it — carve-out still open)'
                else ' FAIL  (' || left(v_msg, 60) || ')' end || chr(10);
    end;
  end loop;

  -- D01..Dnn — G0.2. Every money or date column outside the invoices carve-out
  -- must be refused BY THE INVOICES LOCK.
  --
  -- The distinction this loop exists to draw: before 0253, tax_added_total,
  -- period_start and branch_id WERE refused — by trg_journal_entries_period_lock
  -- downstream, because journal_on_invoice reposts on them and the journal lock
  -- has no carve-out. A suite that asserted "something raised" would have scored
  -- those as passes while the invoices carve-out sat wide open, and would have
  -- said nothing at all about subtotal, total_due, tax_withheld_total and
  -- previous_balance, which no lock anywhere refused. Scoring [journal_entries]
  -- as a distinct FAIL is what makes this loop mean what its name says.
  --
  -- EVERY MUTATION HERE CARRIES A RECEIPT ALONGSIDE IT, AND THAT IS THE WHOLE
  -- TEST. 0237's carve-out opens with `old.amount_received is distinct from
  -- new.amount_received`; touch one of these columns on its own and the branch
  -- never fires, the row falls through to the lock, and it is refused. Written
  -- that way this loop is green against the broken carve-out and proves nothing.
  -- The defect is only reachable by riding along with a receipt, so the receipt
  -- is part of every statement below.
  --
  -- The first version of this loop omitted it. The probe that caught the
  -- omission is the reason the shape is spelled out here rather than assumed.
  --
  -- The mutation is coalesced so it always changes the row (instance eleven).
  v_t := 0;
  foreach v_col in array v_inv_protected loop
    v_t := v_t + 1;
    select c.data_type into v_msg
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'invoices' and c.column_name = v_col;
    begin
      if v_msg = 'date' then
        execute format('update public.invoices set amount_received = amount_received + 100, %I = coalesce(%I, $2) + 1 where id = $1', v_col, v_col)
          using v_invoice, v_month;
      else
        execute format('update public.invoices set amount_received = amount_received + 100, %I = coalesce(%I, 0) + 1 where id = $1', v_col, v_col)
          using v_invoice;
      end if;
      v_results := v_results || 'D' || lpad(v_t::text, 2, '0') || ' invoice_' || rpad(v_col, 20)
        || ' FAIL  (edit accepted in a closed month)' || chr(10);
    exception when others then
      v_msg := sqlerrm;
      v_results := v_results || 'D' || lpad(v_t::text, 2, '0') || ' invoice_' || rpad(v_col, 20)
        || case when v_msg like '%[invoices]%'
                then ' PASS  (refused by the invoices lock)'
                when v_msg like '%[journal_entries]%'
                then ' FAIL  (only the journal lock caught it — carve-out still open)'
                else ' FAIL  (' || left(v_msg, 60) || ')' end || chr(10);
    end;
  end loop;

  -- T1 — disbursement fields are the permitted set and must pass.
  begin
    update public.payslips
       set disbursed = true, disbursed_at = now(), amount_paid = 37000,
           status = 'Cleared', notes = 'period_lock suite'
     where id = v_payslip;
    v_results := v_results || 'T1  payslip_disbursement_allowed  PASS' || chr(10);
  exception when others then
    v_results := v_results || 'T1  payslip_disbursement_allowed  FAIL  ('
      || left(sqlerrm, 70) || ')' || chr(10);
  end;

  -- T2 — moving a payslip between months is NOT in the permitted set.
  begin
    update public.payslips set period_month = v_month + interval '1 month' where id = v_payslip;
    v_results := v_results || 'T2  payslip_month_move_refused    FAIL  (accepted)' || chr(10);
  exception when others then
    v_msg := sqlerrm;
    v_results := v_results || 'T2  payslip_month_move_refused    '
      || case when v_msg like '%[payslips]%' then 'PASS' else 'FAIL  (' || left(v_msg, 50) || ')' end || chr(10);
  end;

  -- T3 — carve-out (a): a receipt updating the cumulative total is allowed.
  begin
    update public.invoices set amount_received = 25000, status = 'Partly-Paid' where id = v_invoice;
    v_results := v_results || 'T3  invoice_amount_received_ok    PASS  (cumulative, GL-neutral)' || chr(10);
  exception when others then
    v_results := v_results || 'T3  invoice_amount_received_ok    FAIL  ('
      || left(sqlerrm, 70) || ')' || chr(10);
  end;

  -- T4 — but moving the invoice itself is still refused.
  begin
    update public.invoices set invoice_amount = 120000 where id = v_invoice;
    v_results := v_results || 'T4  invoice_amount_refused        FAIL  (accepted)' || chr(10);
  exception when others then
    v_msg := sqlerrm;
    v_results := v_results || 'T4  invoice_amount_refused        '
      || case when v_msg like '%[invoices]%' then 'PASS' else 'FAIL  (' || left(v_msg, 50) || ')' end || chr(10);
  end;

  -- T5 — carve-out (b) is gone: a BACKDATED receipt is refused by the
  -- invoice_payments lock itself, not by the journal lock downstream.
  begin
    insert into public.invoice_payments
      (company_id, invoice_id, client_id, amount, payment_date, payment_mode)
    values (v_co, v_invoice, v_client, 5000, v_month + 5, 'Cash');
    v_results := v_results || 'T5  backdated_receipt_refused     FAIL  (accepted)' || chr(10);
  exception when others then
    v_msg := sqlerrm;
    v_results := v_results || 'T5  backdated_receipt_refused     '
      || case when v_msg like '%[invoice_payments]%'
              then 'PASS  (refused at the payment, not downstream)'
              when v_msg like '%[journal_entries]%'
              then 'FAIL  (carve-out still present; journal lock caught it)'
              else 'FAIL  (' || left(v_msg, 50) || ')' end || chr(10);
  end;

  -- T6 — a receipt dated in an OPEN month against a closed-month invoice is
  -- the normal case and must still work. This is what carve-out (a) protects.
  begin
    insert into public.invoice_payments
      (company_id, invoice_id, client_id, amount, payment_date, payment_mode)
    values (v_co, v_invoice, v_client, 5000, current_date, 'Cash');
    v_results := v_results || 'T6  current_month_receipt_ok      PASS' || chr(10);
  exception when others then
    v_results := v_results || 'T6  current_month_receipt_ok      FAIL  ('
      || left(sqlerrm, 70) || ')' || chr(10);
  end;

  -- T7 — the journal lock has no carve-out and never had one.
  begin
    insert into public.journal_entries (company_id, entry_date, description, source_table)
    values (v_co, v_month + 3, 'period_lock suite', 'manual');
    v_results := v_results || 'T7  journal_entry_refused         FAIL  (accepted)' || chr(10);
  exception when others then
    v_msg := sqlerrm;
    v_results := v_results || 'T7  journal_entry_refused         '
      || case when v_msg like '%[journal_entries]%' then 'PASS' else 'FAIL  (' || left(v_msg, 50) || ')' end || chr(10);
  end;

  -- T9 — branch_id. Not a money column, so the derived loop above cannot reach
  -- it, and it is one of the six journal_on_invoice reposts on. Moving an
  -- invoice to another branch in a closed month restates the closed month's
  -- revenue by branch, which is the dimension regional allocation runs on.
  begin
    update public.invoices set amount_received = amount_received + 100, branch_id = null where id = v_invoice;
    v_results := v_results || 'T9  invoice_branch_refused        FAIL  (accepted)' || chr(10);
  exception when others then
    v_msg := sqlerrm;
    v_results := v_results || 'T9  invoice_branch_refused        '
      || case when v_msg like '%[invoices]%' then 'PASS'
              when v_msg like '%[journal_entries]%' then 'FAIL  (only the journal lock caught it)'
              else 'FAIL  (' || left(v_msg, 50) || ')' end || chr(10);
  end;

  -- T10 — contract_id. A posting dimension per the posting rules, and the one
  -- journal_on_invoice does NOT repost on, so nothing downstream would catch it
  -- if the carve-out let it through. No backstop means this assertion is the
  -- only thing standing behind the column.
  begin
    update public.invoices set amount_received = amount_received + 100, contract_id = null where id = v_invoice;
    v_results := v_results || 'T10 invoice_contract_refused      FAIL  (accepted)' || chr(10);
  exception when others then
    v_msg := sqlerrm;
    v_results := v_results || 'T10 invoice_contract_refused      '
      || case when v_msg like '%[invoices]%' then 'PASS'
              else 'FAIL  (' || left(v_msg, 50) || ')' end || chr(10);
  end;

  -- T11 — POSITIVE CONTROL for the permitted set. Attaching the scan of a July
  -- invoice in August is a normal act and must not be refused. A carve-out
  -- verified only by what it refuses is half tested, and the untested half is
  -- the one that takes production down.
  begin
    update public.invoices
       set drive_file_id = 'plock-suite', drive_view_url = 'https://example.invalid/x',
           attachment_file_name = 'PLOCK-001.pdf', notes = 'period_lock suite',
           updated_at = now()
     where id = v_invoice;
    v_results := v_results || 'T11 invoice_document_allowed      PASS' || chr(10);
  exception when others then
    v_results := v_results || 'T11 invoice_document_allowed      FAIL  ('
      || left(sqlerrm, 70) || ')' || chr(10);
  end;

  -- T8 — reopening restores writes. A lock that cannot be lifted is an outage.
  delete from public.accounting_periods where company_id = v_co and period_month = v_month;
  begin
    update public.payslips set final_salary = 40001 where id = v_payslip;
    v_results := v_results || 'T8  reopen_restores_writes        PASS' || chr(10);
  exception when others then
    v_results := v_results || 'T8  reopen_restores_writes        FAIL  ('
      || left(sqlerrm, 70) || ')' || chr(10);
  end;

  -- CANARY. Silence must not be ambiguous between "all passed" and "aborted".
  -- The expected total is derived the same way the protected set is: one
  -- assertion per protected column, plus the eight fixed policy tests. It is NOT
  -- a literal, so adding a money column to payslips raises the expected count
  -- and the loop must actually cover it.
  v_asserts := array_length(string_to_array(trim(both chr(10) from v_results), chr(10)), 1);
  v_expected := array_length(v_protected, 1) + array_length(v_inv_protected, 1) + c_fixed_tests;
  v_results := v_results || '--- CANARY: ' || v_asserts || '/' || v_expected || ' assertions executed'
    || case when v_asserts = v_expected then ' (complete)' else ' *** SUITE TRUNCATED ***' end || chr(10);

  raise exception 'ROLLBACK_PERIOD_LOCK_TESTS: %', v_results;
end
$suite$;
