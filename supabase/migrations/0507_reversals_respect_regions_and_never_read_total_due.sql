-- 0507 — Reversals respect regions, and never read total_due.
--
-- FOUND 2026-10-08 by ledger_checks() the night 0502-0506 went in, three ways:
--
--   no_definer_function_crosses_a_branch — every reverse_* is SECURITY DEFINER
--     (the undo it calls writes as the owner) and none checked the caller's
--     region. A user pinned to one region could reverse another region's
--     payslip, payment or firing. branch_guard_gaps() named nine of them; the
--     rest write tables it does not watch, but the hole is the same, so all
--     twenty-nine get the guard:
--       * a source that belongs to a region → assert_branch_writable(its branch)
--       * a company-wide money movement (bank transfer, custody, vendor payment,
--         partner entry, manual journal, expense request) → refused outright for
--         a region-bound user. assert_branch_writable(null) would have waved it
--         through, which is exactly the case the detector exists for.
--   total_due_not_read_as_a_balance — reverse_invoice and reversible_actions
--     printed coalesce(total_due, invoice_amount) in a title. total_due carries
--     the client's arrears; the invoice's own amount is invoice_amount.
--   every_control_is_invoked — reverse_action_checked matched the detector's
--     "check" name pattern and nothing in the database calls it (the page
--     does). Its one job — refusing an unknown kind — moves into
--     reverse_action, and the wrapper is dropped. The page calls
--     reverse_action.
--
-- SURGERY, NOT RESTATEMENT. Each function is amended against
-- pg_get_functiondef; the anchor (its tenant-guard line) must appear exactly
-- once or the migration refuses.

do $$
declare
  r record; v_def text; v_hits int;
begin
  for r in select * from (values
    ('reverse_payslip_disbursement', 'perform public.assert_same_company((select company_id from public.payslips where id = p_payslip_id));', 'perform public.assert_branch_writable((select branch_id from public.payslips where id = p_payslip_id));'),
    ('reverse_separation', 'perform public.assert_same_company((select company_id from public.employee_state_snapshots where id = p_snapshot_id));', 'perform public.assert_branch_writable((select e.branch_id from public.employee_state_snapshots x join public.employees e on e.id = x.employee_id where x.id = p_snapshot_id));'),
    ('reverse_separation_legacy', 'perform public.assert_same_company((select company_id from public.employees where id = p_employee_id));', 'perform public.assert_branch_writable((select branch_id from public.employees where id = p_employee_id));'),
    ('reverse_invoice_payment', 'perform public.assert_same_company((select company_id from public.invoice_payments where id = p_payment_id));', 'perform public.assert_branch_writable((select branch_id from public.invoice_payments where id = p_payment_id));'),
    ('reverse_expense', 'perform public.assert_same_company((select company_id from public.expenses where id = p_expense_id));', 'perform public.assert_branch_writable((select branch_id from public.expenses where id = p_expense_id));'),
    ('reverse_payable_settlement', 'perform public.assert_same_company((select company_id from public.expenses where id = p_expense_id));', 'perform public.assert_branch_writable((select branch_id from public.expenses where id = p_expense_id));'),
    ('reverse_advance', 'perform public.assert_same_company((select company_id from public.advances where id = p_advance_id));', 'perform public.assert_branch_writable((select branch_id from public.advances where id = p_advance_id));'),
    ('reverse_vendor_payment', 'perform public.assert_same_company((select company_id from public.vendor_payments where id = p_vendor_payment_id));', 'if public.is_branched_user() and not public.is_super_super_admin() then raise exception ''This reversal moves company-wide money; a user assigned to one region cannot make it.'' using errcode = ''42501''; end if;'),
    ('reverse_bank_transfer', 'perform public.assert_same_company((select max(company_id::text)::uuid from public.bank_transactions where transfer_pair_id = p_pair_id));', 'if public.is_branched_user() and not public.is_super_super_admin() then raise exception ''This reversal moves company-wide money; a user assigned to one region cannot make it.'' using errcode = ''42501''; end if;'),
    ('reverse_bank_to_custodian', 'perform public.assert_same_company((select company_id from public.bank_transactions where id = p_transaction_id));', 'if public.is_branched_user() and not public.is_super_super_admin() then raise exception ''This reversal moves company-wide money; a user assigned to one region cannot make it.'' using errcode = ''42501''; end if;'),
    ('reverse_custody_transfer', 'perform public.assert_same_company((select company_id from public.custody_transfers where id = p_transfer_id));', 'if public.is_branched_user() and not public.is_super_super_admin() then raise exception ''This reversal moves company-wide money; a user assigned to one region cannot make it.'' using errcode = ''42501''; end if;'),
    ('reverse_cash_deposit', 'perform public.assert_same_company((select company_id from public.cash_deposits where id = p_deposit_id));', 'if public.is_branched_user() and not public.is_super_super_admin() then raise exception ''This reversal moves company-wide money; a user assigned to one region cannot make it.'' using errcode = ''42501''; end if;'),
    ('reverse_cheque_clearance', 'perform public.assert_same_company((select company_id from public.cheques where id = p_cheque_id));', 'perform public.assert_branch_writable((select branch_id from public.cheques where id = p_cheque_id));'),
    ('reverse_write_off', 'perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id));', 'perform public.assert_branch_writable((select branch_id from public.invoices where id = p_invoice_id));'),
    ('reverse_partner_entry', 'perform public.assert_same_company((select company_id from public.partner_account_entries where id = p_entry_id));', 'if public.is_branched_user() and not public.is_super_super_admin() then raise exception ''This reversal moves company-wide money; a user assigned to one region cannot make it.'' using errcode = ''42501''; end if;'),
    ('reverse_payroll_adjustment', 'perform public.assert_same_company((select company_id from public.payroll_adjustments where id = p_adjustment_id));', 'perform public.assert_branch_writable((select p.branch_id from public.payroll_adjustments a join public.payslips p on p.id = a.payslip_id where a.id = p_adjustment_id));'),
    ('reverse_manual_journal', 'perform public.assert_same_company((select company_id from public.journal_entries where id = p_entry_id));', 'if public.is_branched_user() and not public.is_super_super_admin() then raise exception ''This reversal moves company-wide money; a user assigned to one region cannot make it.'' using errcode = ''42501''; end if;'),
    ('reverse_invoice', 'perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id));', 'perform public.assert_branch_writable((select branch_id from public.invoices where id = p_invoice_id));'),
    ('reverse_inventory_purchase', 'perform public.assert_same_company((select company_id from public.inventory_purchases where id = p_purchase_id));', 'perform public.assert_branch_writable((select branch_id from public.inventory_purchases where id = p_purchase_id));'),
    ('reverse_kit_event', 'perform public.assert_same_company((select company_id from public.kit_events where id = p_event_id));', 'perform public.assert_branch_writable((select branch_id from public.kit_events where id = p_event_id));'),
    ('reverse_clearance_ops', 'perform public.assert_same_company((select company_id from public.clearance_certificates where id = p_certificate_id));', 'perform public.assert_branch_writable((select e.branch_id from public.clearance_certificates x join public.employees e on e.id = x.employee_id where x.id = p_certificate_id));'),
    ('reverse_dues_release', 'perform public.assert_same_company((select company_id from public.clearance_certificates where id = p_certificate_id));', 'perform public.assert_branch_writable((select e.branch_id from public.clearance_certificates x join public.employees e on e.id = x.employee_id where x.id = p_certificate_id));'),
    ('reverse_fixed_asset', 'perform public.assert_same_company((select company_id from public.fixed_assets where id = p_asset_id));', 'perform public.assert_branch_writable((select branch_id from public.fixed_assets where id = p_asset_id));'),
    ('reverse_asset_disposal', 'perform public.assert_same_company((select company_id from public.fixed_assets where id = p_asset_id));', 'perform public.assert_branch_writable((select branch_id from public.fixed_assets where id = p_asset_id));'),
    ('reverse_depreciation_entry', 'perform public.assert_same_company((select company_id from public.depreciation_entries where id = p_entry_id));', 'perform public.assert_branch_writable((select branch_id from public.depreciation_entries where id = p_entry_id));'),
    ('reverse_attendance_verification', 'perform public.assert_same_company((select company_id from public.attendance_half_verifications where id = p_verification_id));', 'perform public.assert_branch_writable((select coalesce(h.branch_id, c.branch_id) from public.attendance_half_verifications h left join public.clients c on c.id = h.client_id where h.id = p_verification_id));'),
    ('reverse_rehire', 'perform public.assert_same_company((select company_id from public.employee_state_snapshots where id = p_snapshot_id));', 'perform public.assert_branch_writable((select e.branch_id from public.employee_state_snapshots x join public.employees e on e.id = x.employee_id where x.id = p_snapshot_id));'),
    ('reverse_lifecycle_change', 'perform public.assert_same_company((select company_id from public.employee_lifecycle_events where id = p_event_id));', 'perform public.assert_branch_writable((select e.branch_id from public.employee_lifecycle_events x join public.employees e on e.id = x.employee_id where x.id = p_event_id));'),
    ('reverse_expense_request_decision', 'perform public.assert_same_company((select company_id from public.expense_requests where id = p_request_id));', 'if public.is_branched_user() and not public.is_super_super_admin() then raise exception ''This reversal moves company-wide money; a user assigned to one region cannot make it.'' using errcode = ''42501''; end if;')
  ) as t(fname, anchor, guard)
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = r.fname;
    if v_def is null then raise exception '0507 REFUSED: % does not exist.', r.fname; end if;
    if position(r.guard in v_def) > 0 then
      continue;   -- already guarded (replay)
    end if;
    v_hits := (length(v_def) - length(replace(v_def, r.anchor, ''))) / length(r.anchor);
    if v_hits <> 1 then
      raise exception '0507 REFUSED: % anchor appears % times, expected 1.', r.fname, v_hits;
    end if;
    execute replace(v_def, r.anchor, r.anchor || E'\n  ' || r.guard);
  end loop;
end $$;

-- total_due, twice.
do $$
declare v_def text; v_hits int;
  a1 text := 'to_char(coalesce(i.total_due, i.invoice_amount), ''FM999,999,999'')';
  a2 text := 'coalesce(i.total_due, i.invoice_amount), null::uuid, i.client_id';
begin
  select pg_get_functiondef('public.reverse_invoice(uuid,text,boolean)'::regprocedure) into v_def;
  v_hits := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  if v_hits = 1 then
    execute replace(v_def, a1, 'to_char(i.invoice_amount, ''FM999,999,999'')');
  elsif position('total_due' in v_def) > 0 then
    raise exception '0507 REFUSED: reverse_invoice total_due anchor appears % times.', v_hits;
  end if;

  select pg_get_functiondef('public.reversible_actions(text,date,text,integer)'::regprocedure) into v_def;
  v_hits := (length(v_def) - length(replace(v_def, a2, ''))) / length(a2);
  if v_hits = 1 then
    execute replace(v_def, a2, 'i.invoice_amount, null::uuid, i.client_id');
  elsif position('total_due' in v_def) > 0 then
    raise exception '0507 REFUSED: reversible_actions total_due anchor appears % times.', v_hits;
  end if;
end $$;

-- reverse_action refuses an unknown kind itself; the wrapper goes.
create or replace function public.reverse_action(
  p_kind text, p_id uuid, p_reason text default null, p_preview boolean default true, p_mode text default 'error')
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare v jsonb;
begin
  v := case p_kind
    when 'payslip_disbursement'      then public.reverse_payslip_disbursement(p_id, p_reason, p_preview, p_mode)
    when 'separation'                then public.reverse_separation(p_id, p_reason, p_preview)
    when 'separation_legacy'         then public.reverse_separation_legacy(p_id, p_reason, p_preview)
    when 'invoice_payment'           then public.reverse_invoice_payment(p_id, p_reason, p_preview)
    when 'expense'                   then public.reverse_expense(p_id, p_reason, p_preview)
    when 'payable_settlement'        then public.reverse_payable_settlement(p_id, p_reason, p_preview)
    when 'advance'                   then public.reverse_advance(p_id, p_reason, p_preview)
    when 'vendor_payment'            then public.reverse_vendor_payment(p_id, p_reason, p_preview)
    when 'bank_transfer'             then public.reverse_bank_transfer(p_id, p_reason, p_preview)
    when 'bank_to_custodian'         then public.reverse_bank_to_custodian(p_id, p_reason, p_preview)
    when 'custody_transfer'          then public.reverse_custody_transfer(p_id, p_reason, p_preview)
    when 'cash_deposit'              then public.reverse_cash_deposit(p_id, p_reason, p_preview)
    when 'cheque_clearance'          then public.reverse_cheque_clearance(p_id, p_reason, p_preview)
    when 'write_off'                 then public.reverse_write_off(p_id, p_reason, p_preview)
    when 'partner_entry'             then public.reverse_partner_entry(p_id, p_reason, p_preview)
    when 'payroll_adjustment'        then public.reverse_payroll_adjustment(p_id, p_reason, p_preview)
    when 'manual_journal'            then public.reverse_manual_journal(p_id, p_reason, p_preview)
    when 'invoice'                   then public.reverse_invoice(p_id, p_reason, p_preview)
    when 'inventory_purchase'        then public.reverse_inventory_purchase(p_id, p_reason, p_preview)
    when 'kit_event'                 then public.reverse_kit_event(p_id, p_reason, p_preview)
    when 'clearance_ops'             then public.reverse_clearance_ops(p_id, p_reason, p_preview)
    when 'dues_release'              then public.reverse_dues_release(p_id, p_reason, p_preview)
    when 'fixed_asset'               then public.reverse_fixed_asset(p_id, p_reason, p_preview)
    when 'asset_disposal'            then public.reverse_asset_disposal(p_id, p_reason, p_preview)
    when 'depreciation_entry'        then public.reverse_depreciation_entry(p_id, p_reason, p_preview)
    when 'attendance_verification'   then public.reverse_attendance_verification(p_id, p_reason, p_preview)
    when 'rehire'                    then public.reverse_rehire(p_id, p_reason, p_preview)
    when 'lifecycle_change'          then public.reverse_lifecycle_change(p_id, p_reason, p_preview)
    when 'expense_request_decision'  then public.reverse_expense_request_decision(p_id, p_reason, p_preview)
    else null
  end;
  if v is null then
    raise exception 'Unknown reversal kind %.', p_kind using errcode = 'P0001';
  end if;
  return v;
end;
$function$;

drop function if exists public.reverse_action_checked(text, uuid, text, boolean, text);

-- Verification: the three detectors this migration answers, read directly.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name, ', ') into v_n, v_who
    from public.branch_guard_gaps() g where g.function_name like 'reverse\_%';
  if v_n <> 0 then raise exception '0507 FAILED: branch_guard_gaps still names %', v_who; end if;

  select count(*) into v_n from public.total_due_read_as_a_balance() t
   where t.object_name in ('reverse_invoice', 'reversible_actions');
  if v_n <> 0 then raise exception '0507 FAILED: total_due is still read by a reversal function.'; end if;

  select count(*) into v_n from public.uninvoked_controls() u where u.object_name like 'reverse\_%';
  if v_n <> 0 then raise exception '0507 FAILED: a reversal function is still an uninvoked control.'; end if;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0507 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
