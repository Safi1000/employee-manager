-- Repost sets — the properties, not the instances.
--
-- Run in the Supabase SQL editor, or over any connection that can execute SQL.
-- One self-rolling-back DO block; the final RAISE aborts the transaction.
-- Needs SANDBOX TESTING ORG and a profile in it, like period_lock.sql.
--
-- WHY THIS FILE IS SHAPED AROUND PROPERTIES
--
-- docs/REPOST_SET_AUDIT.md found the same defect in eight triggers: each posts
-- at a date it never compared, so moving a row's date left the ledger entry in
-- the old month. Eight fixes with eight tests would have recorded eight
-- instances of one thing and proved nothing about the ninth trigger somebody
-- adds next month.
--
-- So this file asserts ONE property against EVERY source table in the class:
--
--   P1. Move a posted row's date and the old month is vacated.
--       No live entry may remain dated in the month the row has left, and a
--       live entry must exist dated in the month it has joined.
--
-- "Live" means not a reversal and not itself reversed. That definition is what
-- makes the assertion survive the reverse-and-repost implementation: three
-- entries can exist afterwards and the property still holds, because two of
-- them cancel.
--
-- P2 is separate and specific, because it is a different defect (0257):
--
--   P2. Reassigning a partner entry moves the equity to the new partner's
--       capital account.
--
-- FIXTURES THAT CANNOT BE BUILT ARE REPORTED, NOT SKIPPED SILENTLY.
--
-- Each fixture is wrapped in its own exception handler. A table whose row could
-- not be created is named in the output with the reason, and the property is
-- reported as UNPROVEN for that table rather than omitted. A suite that quietly
-- tests six of nine tables and prints six passes is the vacuity this project
-- keeps finding.
--
-- STATUS: 9 passed, 0 failed on dev. P1 covers all 9 source tables in the class,
-- P2 covers the partner reassignment. Three fixtures had to be corrected before
-- they built at all - cash_deposits needs bank_account_id and an INTEGER
-- slip_number, fixed_assets takes a lowercase enum category plus five more NOT
-- NULL columns - and each one was named by the NOT COVERED report rather than
-- vanishing from the count. That report is the part of this file to keep.

do $suite$
declare
  v_co       uuid;
  v_profile  uuid;
  v_m1       date := date_trunc('month', current_date)::date;
  v_m2       date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_results  text := '';
  v_skipped  text := '';
  v_msg      text;

  v_emp uuid; v_client uuid; v_bank uuid; v_cat uuid;
  v_loc1 uuid; v_loc2 uuid; v_inv uuid; v_p1 uuid; v_p2 uuid; v_cap1 uuid; v_cap2 uuid;

  -- The cases, accumulated as fixtures succeed.
  v_src   text[] := '{}';
  v_ids   uuid[] := '{}';
  v_label text[] := '{}';
  v_id    uuid;

  i         int;
  v_stale   int;   -- live entries still dated in the month the row left
  v_landed  int;   -- live entries dated in the month the row joined
  v_pass    int := 0;
  v_fail    int := 0;
  v_acct    uuid;
begin
  perform set_config('app.ledger_maintenance', 'on', true);

  select id into v_co from public.companies where name = 'SANDBOX TESTING ORG';
  if v_co is null then
    raise exception 'repost_sets suite needs SANDBOX TESTING ORG; not found';
  end if;
  select id into v_profile from public.profiles where company_id = v_co limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_profile)::text, true);
  if public.current_company_id() is distinct from v_co then
    raise exception 'repost_sets suite ABORTED: current_company_id() is %, expected %',
      coalesce(public.current_company_id()::text, 'NULL'), v_co;
  end if;

  select id into v_emp    from public.employees where company_id = v_co limit 1;
  select id into v_client from public.clients where company_id = v_co limit 1;
  select id into v_bank   from public.bank_accounts where company_id = v_co limit 1;
  select id into v_cat    from public.expense_categories limit 1;
  select id into v_loc1   from public.cash_locations where company_id = v_co order by id limit 1;
  select id into v_loc2   from public.cash_locations where company_id = v_co and id <> v_loc1 order by id limit 1;
  select id into v_inv    from public.invoices where company_id = v_co limit 1;
  select id, coa_account_id into v_p1, v_cap1
    from public.partners where company_id = v_co and coa_account_id is not null order by id limit 1;
  select id, coa_account_id into v_p2, v_cap2
    from public.partners where company_id = v_co and coa_account_id is not null and id <> v_p1 order by id limit 1;

  -- ---------------------------------------------------------------- fixtures
  -- Every row is created dated v_m1 and will be moved to v_m2. Both months are
  -- open (accounting_periods is empty), so the period lock cannot interfere and
  -- a refusal here would be a real failure rather than a closed month.

  begin
    insert into public.advances (company_id, employee_id, amount, advance_date, payment_mode, custodian_location_id)
    values (v_co, v_emp, 5000, v_m1, 'Cash', v_loc1) returning id into v_id;
    v_src := v_src || 'advances'::text; v_ids := v_ids || v_id; v_label := v_label || 'advances.advance_date'::text;
  exception when others then
    v_skipped := v_skipped || '      advances — ' || left(sqlerrm, 70) || chr(10);
  end;

  begin
    insert into public.expenses (company_id, category_id, amount, expense_date, payment_mode, description)
    values (v_co, v_cat, 7000, v_m1, 'Bank', 'repost_sets suite') returning id into v_id;
    v_src := v_src || 'expenses'::text; v_ids := v_ids || v_id; v_label := v_label || 'expenses.expense_date'::text;
  exception when others then
    v_skipped := v_skipped || '      expenses — ' || left(sqlerrm, 70) || chr(10);
  end;

  begin
    insert into public.invoice_payments (company_id, invoice_id, client_id, amount, payment_date, payment_mode)
    values (v_co, v_inv, v_client, 3000, v_m1, 'Bank') returning id into v_id;
    v_src := v_src || 'invoice_payments'::text; v_ids := v_ids || v_id; v_label := v_label || 'invoice_payments.payment_date'::text;
  exception when others then
    v_skipped := v_skipped || '      invoice_payments — ' || left(sqlerrm, 70) || chr(10);
  end;

  begin
    insert into public.cash_deposits
      (company_id, bank_account_id, cash_location_id, amount, deposit_date, slip_number)
    values (v_co, v_bank, v_loc1, 4000, v_m1, 999001) returning id into v_id;
    v_src := v_src || 'cash_deposits'::text; v_ids := v_ids || v_id; v_label := v_label || 'cash_deposits.deposit_date'::text;
  exception when others then
    v_skipped := v_skipped || '      cash_deposits — ' || left(sqlerrm, 70) || chr(10);
  end;

  begin
    insert into public.custody_transfers (company_id, from_location_id, to_location_id, amount, date)
    values (v_co, v_loc1, coalesce(v_loc2, v_loc1), 2500, v_m1) returning id into v_id;
    v_src := v_src || 'custody_transfers'::text; v_ids := v_ids || v_id; v_label := v_label || 'custody_transfers.date'::text;
  exception when others then
    v_skipped := v_skipped || '      custody_transfers — ' || left(sqlerrm, 70) || chr(10);
  end;

  begin
    insert into public.fixed_assets
      (company_id, name, category, cost, acquisition_date, payment_mode,
       salvage_value, depreciation_method, useful_life_months, accumulated_depreciation, status)
    values (v_co, 'repost_sets suite', 'equipment', 60000, v_m1, 'Bank',
            0, 'straight_line', 60, 0, 'active') returning id into v_id;
    v_src := v_src || 'fixed_assets'::text; v_ids := v_ids || v_id; v_label := v_label || 'fixed_assets.acquisition_date'::text;
  exception when others then
    v_skipped := v_skipped || '      fixed_assets — ' || left(sqlerrm, 70) || chr(10);
  end;

  begin
    insert into public.partner_account_entries
      (company_id, partner_id, date, type, amount, payment_method)
    values (v_co, v_p1, v_m1, 'CONTRIBUTION', 11000, 'BANK_TRANSFER') returning id into v_id;
    v_src := v_src || 'partner_account_entries'::text; v_ids := v_ids || v_id;
    v_label := v_label || 'partner_account_entries.date'::text;
  exception when others then
    v_skipped := v_skipped || '      partner_account_entries — ' || left(sqlerrm, 70) || chr(10);
  end;

  -- A cheque only posts once it CLEARS, so it has to be cleared before its date
  -- can be moved. That is the whole point of case seven: the status-transition
  -- shape is where an `or` in a condition list would not have reached.
  begin
    insert into public.cheques (company_id, bank_account_id, cheque_number, amount, cheque_date,
                                status, direction, cheque_type, custodian_location_id)
    values (v_co, v_bank, 'RSET-1', 9000, v_m1, 'pending', 'outgoing', 'cash', v_loc1)
    returning id into v_id;
    update public.cheques set status = 'cleared', cleared_at = now() where id = v_id;
    v_src := v_src || 'cheques'::text; v_ids := v_ids || v_id; v_label := v_label || 'cheques.cheque_date (cleared)'::text;
  exception when others then
    v_skipped := v_skipped || '      cheques — ' || left(sqlerrm, 70) || chr(10);
  end;

  -- Likewise a payable only posts a settlement once it is Paid.
  begin
    insert into public.expenses (company_id, category_id, amount, expense_date, payment_mode,
                                 description, payable_status)
    values (v_co, v_cat, 8000, v_m1, 'Payable', 'repost_sets settlement', 'Pending')
    returning id into v_id;
    update public.expenses
       set payable_status = 'Paid', paid_via = 'Bank', paid_bank_account_id = v_bank,
           paid_at = v_m1::timestamptz
     where id = v_id;
    v_src := v_src || 'expense_settlements'::text; v_ids := v_ids || v_id;
    v_label := v_label || 'expenses.paid_at (settled)'::text;
  exception when others then
    v_skipped := v_skipped || '      expense_settlements — ' || left(sqlerrm, 70) || chr(10);
  end;

  -- ------------------------------------------------------------------ P1
  for i in 1 .. coalesce(array_length(v_src, 1), 0) loop
    begin
      -- Move the date. Which column depends on the table; the property does not.
      case v_src[i]
        when 'advances'                then update public.advances set advance_date = v_m2 where id = v_ids[i];
        when 'expenses'                then update public.expenses set expense_date = v_m2 where id = v_ids[i];
        when 'invoice_payments'        then update public.invoice_payments set payment_date = v_m2 where id = v_ids[i];
        when 'cash_deposits'           then update public.cash_deposits set deposit_date = v_m2 where id = v_ids[i];
        when 'custody_transfers'       then update public.custody_transfers set date = v_m2 where id = v_ids[i];
        when 'fixed_assets'            then update public.fixed_assets set acquisition_date = v_m2 where id = v_ids[i];
        when 'partner_account_entries' then update public.partner_account_entries set date = v_m2 where id = v_ids[i];
        when 'cheques'                 then update public.cheques set cheque_date = v_m2 where id = v_ids[i];
        when 'expense_settlements'     then update public.expenses set paid_at = v_m2::timestamptz where id = v_ids[i];
      end case;

      -- Live = not a reversal, and not itself reversed.
      select count(*) into v_stale
        from public.journal_entries je
       where je.source_table = v_src[i] and je.source_id = v_ids[i]
         and je.entry_date >= v_m1
         and je.reversal_of_entry_id is null
         and not exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = je.id);

      select count(*) into v_landed
        from public.journal_entries je
       where je.source_table = v_src[i] and je.source_id = v_ids[i]
         and je.entry_date >= v_m2 and je.entry_date < v_m1
         and je.reversal_of_entry_id is null
         and not exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = je.id);

      if v_stale = 0 and v_landed > 0 then
        v_pass := v_pass + 1;
        v_results := v_results || 'P1 ' || rpad(v_label[i], 34) || ' PASS  (old month vacated, entry landed in the new one)' || chr(10);
      else
        v_fail := v_fail + 1;
        v_results := v_results || 'P1 ' || rpad(v_label[i], 34) || ' FAIL  (live entries left in old month: '
          || v_stale || ', landed in new month: ' || v_landed || ')' || chr(10);
      end if;
    exception when others then
      v_fail := v_fail + 1;
      v_results := v_results || 'P1 ' || rpad(v_label[i], 34) || ' FAIL  (' || left(sqlerrm, 55) || ')' || chr(10);
    end;
  end loop;

  -- ------------------------------------------------------------------ P2
  if v_p2 is null then
    v_skipped := v_skipped || '      P2 partner reassignment — fewer than two partners with a capital account' || chr(10);
  else
    begin
      insert into public.partner_account_entries
        (company_id, partner_id, date, type, amount, payment_method)
      values (v_co, v_p1, v_m1, 'CONTRIBUTION', 12000, 'BANK_TRANSFER') returning id into v_id;

      update public.partner_account_entries set partner_id = v_p2 where id = v_id;

      select jl.account_id into v_acct
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.journal_entry_id
       where je.source_table = 'partner_account_entries' and je.source_id = v_id
         and je.reversal_of_entry_id is null
         and not exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = je.id)
         and jl.credit > 0
       limit 1;

      if v_acct = v_cap2 then
        v_pass := v_pass + 1;
        v_results := v_results || 'P2 partner reassignment            PASS  (equity followed to the new partner)' || chr(10);
      else
        v_fail := v_fail + 1;
        v_results := v_results || 'P2 partner reassignment            FAIL  (credited '
          || case when v_acct = v_cap1 then 'the PREVIOUS partner' else coalesce(v_acct::text, 'nothing') end || ')' || chr(10);
      end if;
    exception when others then
      v_fail := v_fail + 1;
      v_results := v_results || 'P2 partner reassignment            FAIL  (' || left(sqlerrm, 55) || ')' || chr(10);
    end;
  end if;

  -- --------------------------------------------------------------- canary
  -- Nine source tables are in the date class. Anything fewer means a fixture
  -- failed, and the count says so rather than the absence being invisible.
  v_results := v_results || '--- ' || v_pass || ' passed, ' || v_fail || ' failed; P1 covered '
    || coalesce(array_length(v_src, 1), 0) || ' of 9 source tables in the date class' || chr(10);

  v_results := v_results || chr(10) || 'NOT COVERED — fixture could not be built:' || chr(10)
    || coalesce(nullif(v_skipped, ''), '      none' || chr(10));

  raise exception 'ROLLBACK_REPOST_SETS: %', v_results;
end
$suite$;
