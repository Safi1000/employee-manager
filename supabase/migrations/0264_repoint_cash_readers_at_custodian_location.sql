-- 0264 — Point the five defective posting paths at the column the application
-- actually writes.
--
-- THE DEFECT: cash_location_id is set on ZERO rows of every table in the
-- database. The application has never written it; it writes
-- custodian_location_id, via ensureCustodianLocation(). Seven posting functions
-- read the dead column. The only two that read the live one — journal_on_cheque
-- and record_bank_to_custodian — are the only routine paths whose postings land
-- on a per-location account. Same schema, same resolver, same accounts; the
-- difference is which column they name. That is the control experiment.
--
-- REPOINTED (5):
--   journal_on_advance             advances.custodian_location_id
--   journal_on_expense             expenses.custodian_location_id
--   journal_on_expense_settlement  expenses.custodian_location_id
--   journal_on_invoice_payment     invoice_payments.custodian_location_id
--   journal_on_payslip             payslips.custodian_location_id  (0263)
--   post_payslip_disbursement      payslips.custodian_location_id  (0263)
--
-- LEFT ALONE (2), correct by construction — these tables have ONLY
-- cash_location_id and the application does write it:
--   journal_on_cash_deposit        cash_deposits
--   journal_on_partner_entry       partner_account_entries
--
-- WHY A PROGRAMMATIC SUBSTITUTION RATHER THAN SIX REWRITTEN FUNCTIONS
--
-- These are 40-100 line trigger bodies carrying repost-set logic from 0256 and
-- 0258 that is easy to get subtly wrong. Retyping them to change one identifier
-- risks introducing exactly the class of defect this migration exists to fix: a
-- reader and a writer that disagree by a single name. Substituting on
-- pg_get_functiondef() is mechanically faithful — whatever was there is what
-- comes back, minus the one identifier.
--
-- It is asserted on both sides. Each function must contain the expected number
-- of occurrences BEFORE (so a function already repointed, or one that changed
-- shape, is caught rather than silently skipped) and zero AFTER.

do $$
declare
  r        record;
  v_def    text;
  v_before int;
  v_after  int;
  -- name -> occurrences expected in the current body
  v_expect constant jsonb := jsonb_build_object(
    'journal_on_advance',            3,   -- 2 in the repost set, 1 in the credit line
    'journal_on_expense',            3,
    'journal_on_expense_settlement', 1,   -- credit line only; its repost set keys on paid_at
    'journal_on_invoice_payment',    3,
    'journal_on_payslip',            2,   -- both sides of the disbursement repost test
    'post_payslip_disbursement',     1
  );
begin
  for r in
    select p.oid, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('journal_on_advance', 'journal_on_expense',
                         'journal_on_expense_settlement', 'journal_on_invoice_payment',
                         'journal_on_payslip', 'post_payslip_disbursement')
  loop
    v_def := pg_get_functiondef(r.oid);

    select count(*) into v_before
      from regexp_matches(v_def, '\ycash_location_id\y', 'g');

    if v_before <> (v_expect ->> r.proname)::int then
      raise exception
        '%: expected % occurrence(s) of cash_location_id, found % — the body is not the one this migration was written against. Review before repointing.',
        r.proname, v_expect ->> r.proname, v_before
        using errcode = '23514';
    end if;

    v_def := regexp_replace(v_def, '\ycash_location_id\y', 'custodian_location_id', 'g');

    select count(*) into v_after
      from regexp_matches(v_def, '\ycash_location_id\y', 'g');
    if v_after <> 0 then
      raise exception '%: % occurrence(s) survived the substitution', r.proname, v_after
        using errcode = '23514';
    end if;

    execute v_def;
    raise notice '0264: repointed % (% occurrence(s))', r.proname, v_before;
  end loop;
end $$;

-- The period-lock carve-out for payslips lists the payment-routing columns that
-- may still change in a closed month. The disbursement path now writes
-- custodian_location_id, so it belongs in that list — otherwise recording a cash
-- payroll payment against a closed month starts failing for a new reason.
-- cash_location_id stays in the list until 0266 drops it; a name in an allowlist
-- for a column that no longer exists is harmless, a missing one is not.
do $$
declare v_def text; v_n int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'enforce_period_lock';

  if position('''custodian_location_id''' in v_def) > 0 then
    raise notice '0264: enforce_period_lock already carries custodian_location_id';
    return;
  end if;

  select count(*) into v_n from regexp_matches(
    v_def, '''bank_account_id'', ''cheque_id'', ''cash_location_id''', 'g');
  if v_n <> 1 then
    raise exception
      'enforce_period_lock: expected exactly one payslip carve-out list to extend, found % — review by hand', v_n
      using errcode = '23514';
  end if;

  v_def := replace(v_def,
    '''bank_account_id'', ''cheque_id'', ''cash_location_id''',
    '''bank_account_id'', ''cheque_id'', ''cash_location_id'', ''custodian_location_id''');
  execute v_def;
  raise notice '0264: enforce_period_lock payslip carve-out extended';
end $$;