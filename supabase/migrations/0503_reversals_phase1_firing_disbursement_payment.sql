-- 0503 — Reversals, phase 1: a wrong firing, a wrong salary disbursement, a
-- wrong client payment. The three named in the request. Foundation is 0502.
--
-- Every function here: reversals.execute first, the tenant guard on its id,
-- blockers computed, then either a preview (p_preview) or the writes. Same
-- body for both, so the popup cannot promise what the write will not do.

-- ===========================================================================
-- 1. SALARY DISBURSEMENT
-- ===========================================================================
-- Generalises 0422 (Abdul Tanvir, hand-written). The ACCRUAL is never touched:
-- he worked the month and is owed it. Only the payment is undone:
--   * money back where it came from, through apply_money_delta;
--   * payslip to Pending, amount_paid 0 — journal_on_payslip reverses the
--     disbursement entry on disbursed true -> false (0422 relied on the same arm);
--   * adjustments that payslip had settled reopen (settle_carried_adjustments
--     only ever runs forward);
--   * the overpayment carry-forward this payslip created is removed;
--   * a payslip inside a disbursed run: enforce_payroll_run_lock refuses an
--     amount_paid change unless the run is draft/review, so the run steps to
--     review for the write and lands on approved — ready to pay this one again.
--
-- MODE. 'error' (default): the payment never really happened — wrong bank,
-- entered twice. 'recover': it happened and he must pay it back — the money
-- stays out, and the same amount is recorded as an advance against him
-- (record_advance), so the bank nets to no change and his next payslip
-- recovers it. Cash and bank only: a cheque has its own register.
create or replace function public.reverse_payslip_disbursement(
  p_payslip_id uuid, p_reason text, p_preview boolean default false, p_mode text default 'error')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  ps        record;
  v_name    text;
  v_title   text;
  v_paid    numeric;
  v_where   text;
  v_run     record;
  v_cf      record;
  v_adj     int;
  v_b       text[] := '{}';
  v_e       text[] := '{}';
  v_n       int;
  v_rid     uuid;
  v_note    text;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.payslips where id = p_payslip_id));
  perform public.reversal_check('payslip_disbursement', p_payslip_id, p_reason, p_preview,
    (select coalesce(disbursed_at, updated_at) from public.payslips where id = p_payslip_id));
  if coalesce(p_mode, 'error') not in ('error', 'recover') then
    raise exception 'Unknown reversal mode %.', p_mode using errcode = 'P0001';
  end if;

  select * into ps from public.payslips where id = p_payslip_id for update;
  if ps.id is null then raise exception 'That payslip no longer exists.' using errcode = 'P0001'; end if;

  select full_name into v_name from public.employees where id = ps.employee_id;
  v_title := 'Salary ' || to_char(ps.period_month, 'Mon YYYY') || ' · '
          || coalesce(public.employee_display_code(ps.employee_id) || ' ', '') || coalesce(v_name, '');
  v_paid := round(coalesce(ps.amount_paid, 0));

  if not ps.disbursed and v_paid = 0 then
    v_b := array_append(v_b, ('This payslip has not been paid, so there is nothing to reverse.')::text);
  end if;
  if ps.payment_mode = 'Cheque' and ps.cheque_id is not null
     and exists (select 1 from public.cheques c where c.id = ps.cheque_id and c.status = 'cleared') then
    v_b := array_append(v_b, (('It was paid by cheque #' || (select cheque_number from public.cheques where id = ps.cheque_id)
                   || ', which has cleared. Reverse the cheque clearance first.'))::text);
  end if;
  if p_mode = 'recover' and ps.payment_mode not in ('Cash', 'Bank') then
    v_b := array_append(v_b, ('Recovering the money is only possible for a cash or bank payment.')::text);
  end if;

  v_note := 'Payroll overpayment carry-forward · ' || to_char(ps.period_month, 'FMMonth YYYY');
  select id, amount into v_cf from public.advances
   where employee_id = ps.employee_id and notes = v_note limit 1;
  if v_cf.id is not null and exists (
       select 1 from public.payslips p2
        where p2.employee_id = ps.employee_id and p2.period_month > ps.period_month
          and p2.disbursed and coalesce(p2.advance, 0) > 0) then
    v_b := array_append(v_b, ('The overpayment carried forward from this payslip has already been recovered on a later payslip. Reverse that disbursement first.')::text);
  end if;

  -- Always selected, so v_run is assigned (to nulls) when there is no run.
  select id, status into v_run from public.payroll_runs where id = ps.payroll_run_id for update;
  if v_run.id is not null then
    if v_run.status = 'cancelled' then
      v_b := array_append(v_b, ('Its payroll run is cancelled.')::text);
    end if;
  end if;

  v_where := case ps.payment_mode
    when 'Bank' then coalesce((select bank_name || ' ' || account_number from public.bank_accounts where id = ps.bank_account_id), 'the bank')
    when 'Cash' then coalesce((select name from public.cash_locations where id = ps.custodian_location_id), 'cash in hand')
    else null end;

  if p_mode = 'recover' then
    v_e := array_append(v_e, (('PKR ' || to_char(v_paid, 'FM999,999,999') || ' stays paid out and is recorded as an advance against him; his next payslip recovers it.'))::text);
  elsif v_where is not null and v_paid > 0 then
    v_e := array_append(v_e, (('PKR ' || to_char(v_paid, 'FM999,999,999') || ' goes back to ' || v_where || '.'))::text);
  else
    v_e := array_append(v_e, ('No balance moves (an uncleared cheque or a payable never left the bank).')::text);
  end if;
  v_e := array_append(v_e, ('The payslip goes back to Pending. He is still owed the salary — the month''s accrual is untouched.')::text);
  v_e := array_append(v_e, ('The disbursement journal entry is reversed.')::text);
  select count(*) into v_adj from public.payroll_adjustments
   where settled_payslip_id = ps.id and status = 'settled';
  if v_adj > 0 then
    v_e := array_append(v_e, ((v_adj || ' payroll adjustment(s) this payslip settled are reopened.'))::text);
  end if;
  if v_cf.id is not null then
    v_e := array_append(v_e, (('The overpayment carry-forward of PKR ' || to_char(v_cf.amount, 'FM999,999,999') || ' is removed.'))::text);
  end if;
  if v_run.id is not null and v_run.status in ('disbursed', 'completed') then
    v_e := array_append(v_e, ('Its payroll run returns to Approved, so this payslip can be paid again from the run.')::text);
  end if;

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('payslip_disbursement', p_payslip_id, v_title, v_b, v_e, p_preview);
  end if;

  -- The run lock admits a pay change only in draft/review.
  if v_run.id is not null and v_run.status in ('disbursed', 'completed', 'approved') then
    update public.payroll_runs set status = 'review', updated_at = now() where id = v_run.id;
  end if;

  if v_paid > 0 and ps.payment_mode in ('Cash', 'Bank') then
    perform public.apply_money_delta(
      ps.company_id, ps.payment_mode, ps.bank_account_id, v_paid, 'payroll',
      'Reversal · ' || v_title,
      case when ps.payment_mode = 'Cash' then ps.custodian_location_id::text else ps.id::text end);
  end if;

  update public.payslips
     set disbursed = false, disbursed_at = null, status = 'Pending', amount_paid = 0, updated_at = now()
   where id = ps.id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'Expected to reverse exactly one payslip, reversed %.', v_n; end if;

  update public.payroll_adjustments
     set status = 'open', settled_at = null, settled_by = null, settled_payslip_id = null
   where settled_payslip_id = ps.id and status = 'settled';

  if v_cf.id is not null then
    delete from public.advances where id = v_cf.id;
  end if;

  if v_run.id is not null and v_run.status in ('disbursed', 'completed', 'approved') then
    update public.payroll_runs set status = 'approved', updated_at = now() where id = v_run.id;
  end if;

  if p_mode = 'recover' and v_paid > 0 then
    perform public.record_advance(
      ps.employee_id, v_paid, current_date, ps.payment_mode, null,
      case when ps.payment_mode = 'Bank' then ps.bank_account_id end, null,
      case when ps.payment_mode = 'Cash' then ps.custodian_location_id end,
      'Recovered from reversed salary ' || to_char(ps.period_month, 'Mon YYYY'));
  end if;

  v_rid := public.reversal_finish(ps.company_id, 'payslip_disbursement', ps.id, v_title, p_mode, p_reason,
                                  to_jsonb(ps), v_e);
  return public.reversal_result('payslip_disbursement', p_payslip_id, v_title, v_b, v_e, false, v_rid);
end;
$function$;

-- ===========================================================================
-- 2. A FIRING (or resignation, or absconding) — by snapshot
-- ===========================================================================
-- The source is the employee_state_snapshots row 0502's trigger took just
-- before the exit, so a guard fired, restored, and fired again has two
-- separately reversible exits. Restores the employee row's exit fields, his
-- open postings (reopened only where enforce_deployment_slot_free still admits
-- them — otherwise he is active and unposted, on reserve), the attendance the
-- purge deleted (each day independently; a day a month or half lock refuses is
-- reported, not forced), and removes an un-assessed clearance.
create or replace function public.reverse_separation(
  p_snapshot_id uuid, p_reason text, p_preview boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  s        record;
  e        record;
  d        jsonb;
  a        jsonb;
  v_title  text;
  v_b      text[] := '{}';
  v_e      text[] := '{}';
  v_posted int := 0;
  v_reserve int := 0;
  v_days   int := 0;
  v_skip   int := 0;
  v_rid    uuid;
  v_state  text;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.employee_state_snapshots where id = p_snapshot_id));
  perform public.reversal_check('separation', p_snapshot_id, p_reason, p_preview);

  select * into s from public.employee_state_snapshots where id = p_snapshot_id;
  if s.id is null or s.kind <> 'separation' then
    raise exception 'That is not a recorded separation.' using errcode = 'P0001';
  end if;
  select * into e from public.employees where id = s.employee_id for update;
  v_state := s.employee ->> 'lifecycle_state';
  v_title := initcap(s.to_state) || ' · ' || coalesce(public.employee_display_code(e.id) || ' ', '') || e.full_name;

  if exists (select 1 from public.employee_state_snapshots s2
              where s2.employee_id = s.employee_id and s2.taken_at > s.taken_at) then
    v_b := array_append(v_b, ('He has changed since (rehired or separated again). Reverse the later change first.')::text);
  end if;
  if e.lifecycle_state::text not in ('left', 'terminated', 'fired', 'absconded') then
    v_b := array_append(v_b, (('He is ' || e.lifecycle_state || ' now, not separated.'))::text);
  end if;
  if exists (select 1 from public.clearance_certificates c
              where c.employee_id = e.id and c.created_at >= s.taken_at and c.ops_cleared_at is not null) then
    v_b := array_append(v_b, ('Operations has already cleared him. Reverse the clearance (and any dues release) first.')::text);
  end if;

  v_e := array_append(v_e, (('Back to ' || v_state || '; last working day, termination date and exit reason are cleared.'))::text);
  if jsonb_array_length(s.deployments) > 0 then
    v_e := array_append(v_e, ((jsonb_array_length(s.deployments) || ' posting(s) reopened where the post is still free; otherwise he stays on reserve, unposted.'))::text);
  else
    v_e := array_append(v_e, ('He had no open posting when he left, so he returns unposted.')::text);
  end if;
  if jsonb_array_length(s.attendance) > 0 then
    v_e := array_append(v_e, ((jsonb_array_length(s.attendance) || ' attendance day(s) deleted by the separation are put back (a day a locked month refuses is skipped and counted).'))::text);
  end if;
  if exists (select 1 from public.clearance_certificates c
              where c.employee_id = e.id and c.created_at >= s.taken_at and c.ops_cleared_at is null) then
    v_e := array_append(v_e, ('His open, un-assessed clearance is removed.')::text);
  end if;

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('separation', p_snapshot_id, v_title, v_b, v_e, p_preview);
  end if;

  perform set_config('app.reversal', 'on', true);

  update public.employees set
    lifecycle_state     = v_state::public.employee_lifecycle_state,
    last_working_day    = (s.employee ->> 'last_working_day')::date,
    termination_date    = (s.employee ->> 'termination_date')::date,
    separation_reason   = (s.employee ->> 'separation_reason')::public.separation_reason,
    exit_reason         = s.employee ->> 'exit_reason',
    exit_date           = (s.employee ->> 'exit_date')::date,
    eligible_for_rehire = (s.employee ->> 'eligible_for_rehire')::boolean,
    updated_at          = now()
  where id = e.id;

  for d in select * from jsonb_array_elements(s.deployments) loop
    begin
      if exists (select 1 from public.deployments x where x.id = (d ->> 'id')::uuid) then
        update public.deployments
           set end_date = null, reason = (d ->> 'reason')::public.deployment_reason, updated_at = now()
         where id = (d ->> 'id')::uuid;
      else
        insert into public.deployments select * from jsonb_populate_record(null::public.deployments, d);
      end if;
      v_posted := v_posted + 1;
      update public.vacancies
         set status = 'filled', filled_at = now(), filled_by_guard_id = e.id
       where vacated_by_guard_id = e.id and status = 'open' and opened_at >= s.taken_at
         and contract_line_id is not distinct from (d ->> 'contract_line_id')::uuid;
    exception when others then
      v_reserve := v_reserve + 1;
    end;
  end loop;

  perform set_config('app.skip_attendance_lock', '1', true);
  for a in select * from jsonb_array_elements(s.attendance) loop
    begin
      if not exists (select 1 from public.attendance_records r
                      where r.employee_id = e.id and r.attendance_date = (a ->> 'attendance_date')::date) then
        insert into public.attendance_records select * from jsonb_populate_record(null::public.attendance_records, a);
        v_days := v_days + 1;
      end if;
    exception when others then
      v_skip := v_skip + 1;
    end;
  end loop;
  perform set_config('app.skip_attendance_lock', '', true);

  delete from public.clearance_certificates c
   where c.employee_id = e.id and c.created_at >= s.taken_at and c.ops_cleared_at is null;

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, changed_by, notes)
  values (e.company_id, e.id, e.lifecycle_state, v_state::public.employee_lifecycle_state,
          'Reversal of separation', auth.uid(), btrim(p_reason));

  perform set_config('app.reversal', '', true);

  v_e := array_append(v_e, (('Done: ' || v_posted || ' posting(s) reopened, ' || v_reserve || ' left on reserve, '
                 || v_days || ' attendance day(s) restored, ' || v_skip || ' refused by a lock.'))::text);
  v_rid := public.reversal_finish(e.company_id, 'separation', s.id, v_title, 'error', p_reason, to_jsonb(s), v_e);
  return public.reversal_result('separation', p_snapshot_id, v_title, v_b, v_e, false, v_rid);
end;
$function$;

-- ===========================================================================
-- 2b. A FIRING RECORDED BEFORE 0502 — no snapshot exists, so a partial undo
-- ===========================================================================
-- Exits made before the snapshot trigger existed have nothing photographed.
-- What can still be restored is restored: active again, exit fields cleared,
-- the posting the separation ended reopened if the post is still free. The
-- attendance the purge deleted at the time is gone and cannot come back; the
-- preview says so, so nobody believes it did.
create or replace function public.reverse_separation_legacy(
  p_employee_id uuid, p_reason text, p_preview boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  e        record;
  d        record;
  v_title  text;
  v_b      text[] := '{}';
  v_e      text[] := '{}';
  v_rid    uuid;
  v_posted boolean := false;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.employees where id = p_employee_id));
  perform public.reversal_check('separation_legacy', p_employee_id, p_reason, p_preview,
    (select updated_at from public.employees where id = p_employee_id));

  select * into e from public.employees where id = p_employee_id for update;
  if e.id is null then raise exception 'That employee no longer exists.' using errcode = 'P0001'; end if;
  v_title := initcap(e.lifecycle_state::text) || ' · ' || coalesce(public.employee_display_code(e.id) || ' ', '') || e.full_name;

  if e.lifecycle_state::text not in ('left', 'terminated', 'fired', 'absconded') then
    v_b := array_append(v_b, ('He is ' || e.lifecycle_state || ' now, not separated.')::text);
  end if;
  if exists (select 1 from public.employee_state_snapshots s where s.employee_id = e.id and s.kind = 'separation') then
    v_b := array_append(v_b, 'This exit has a full record. Reverse it from its Separation entry instead.'::text);
  end if;
  if exists (select 1 from public.clearance_certificates c where c.employee_id = e.id and c.ops_cleared_at is not null and not c.dues_released) then
    v_b := array_append(v_b, 'Operations has already cleared him. Reverse the clearance first.'::text);
  end if;
  if exists (select 1 from public.clearance_certificates c where c.employee_id = e.id and c.dues_released) then
    v_b := array_append(v_b, 'His final dues have been released. Reverse the dues release first.'::text);
  end if;

  select * into d from public.deployments x
   where x.guard_id = e.id and x.reason = 'separation' and x.end_date is not null
   order by x.end_date desc limit 1;

  v_e := array_append(v_e, 'Back to active; last working day, termination date and exit reason are cleared.'::text);
  if d.id is not null then
    v_e := array_append(v_e, 'The posting his exit ended is reopened if the post is still free; otherwise he stays on reserve, unposted.'::text);
  else
    v_e := array_append(v_e, 'No posting was ended by his exit, so he returns unposted.'::text);
  end if;
  v_e := array_append(v_e, 'This exit was recorded before reversals kept copies: attendance deleted at the time cannot be restored. Re-mark any days he actually worked.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('separation_legacy', p_employee_id, v_title, v_b, v_e, p_preview);
  end if;

  perform set_config('app.reversal', 'on', true);
  update public.employees set
    lifecycle_state = 'active', last_working_day = null, termination_date = null,
    separation_reason = null, exit_reason = null, exit_date = null, updated_at = now()
  where id = e.id;

  if d.id is not null then
    begin
      update public.deployments set end_date = null, reason = 'new_hire', updated_at = now() where id = d.id;
      v_posted := true;
      update public.vacancies set status = 'filled', filled_at = now(), filled_by_guard_id = e.id
       where vacated_by_guard_id = e.id and status = 'open'
         and contract_line_id is not distinct from d.contract_line_id;
    exception when others then
      v_posted := false;
    end;
  end if;

  delete from public.clearance_certificates c where c.employee_id = e.id and c.ops_cleared_at is null;

  insert into public.employee_lifecycle_events (company_id, employee_id, from_state, to_state, reason, changed_by, notes)
  values (e.company_id, e.id, e.lifecycle_state, 'active', 'Reversal of separation', auth.uid(), btrim(p_reason));
  perform set_config('app.reversal', '', true);

  v_e := array_append(v_e, (case when v_posted then 'Done: his posting was reopened.'
                                 else 'Done: he is active and on reserve (his old post was not free).' end)::text);
  v_rid := public.reversal_finish(e.company_id, 'separation_legacy', e.id, v_title, 'error', p_reason, to_jsonb(e), v_e);
  return public.reversal_result('separation_legacy', p_employee_id, v_title, v_b, v_e, false, v_rid);
end;
$function$;

-- ===========================================================================
-- 3. A CLIENT PAYMENT (receipt), including its withholding
-- ===========================================================================
-- delete_invoice_payment already moves the money back, takes the receipt and
-- its withholding off the invoice and (via the delete) reverses the journal.
-- This calls it, keeps the row in reversals.before, and sets the invoice's
-- status to what its remaining receipts make it. The period lock refuses a
-- DELETE in a closed month, so a receipt in a closed month is a blocker that
-- names the month rather than a failure that names a trigger.
create or replace function public.reverse_invoice_payment(
  p_payment_id uuid, p_reason text, p_preview boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  p       record;
  v_inv   record;
  v_title text;
  v_where text;
  v_b     text[] := '{}';
  v_e     text[] := '{}';
  v_rid   uuid;
  v_left  numeric;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.invoice_payments where id = p_payment_id));
  perform public.reversal_check('invoice_payment', p_payment_id, p_reason, p_preview);

  select * into p from public.invoice_payments where id = p_payment_id for update;
  if p.id is null then raise exception 'That payment no longer exists.' using errcode = 'P0001'; end if;
  select id, invoice_number, invoice_amount, amount_received, status into v_inv
    from public.invoices where id = p.invoice_id;

  v_title := 'Payment PKR ' || to_char(p.amount, 'FM999,999,999') || ' · '
          || coalesce((select name from public.clients where id = p.client_id), 'Client')
          || coalesce(' · ' || v_inv.invoice_number, '');

  if p.cheque_id is not null then
    v_b := array_append(v_b, ('It was received by cheque. Reverse the cheque clearance instead — that removes this receipt with it.')::text);
  end if;
  if public.is_period_closed(p.company_id, p.payment_date) then
    v_b := array_append(v_b, (('Its month (' || to_char(p.payment_date, 'Mon YYYY') || ') is closed. Reopen it in Period Close, then reverse.'))::text);
  end if;

  v_where := case p.payment_mode
    when 'Bank' then coalesce((select bank_name || ' ' || account_number from public.bank_accounts where id = p.bank_account_id), 'the bank')
    when 'Cash' then 'cash in hand' else null end;
  if v_where is not null then
    v_e := array_append(v_e, (('PKR ' || to_char(p.amount, 'FM999,999,999') || ' is taken back out of ' || v_where || '.'))::text);
  end if;
  if coalesce(p.withholding_amount, 0) > 0 then
    v_e := array_append(v_e, (('The PKR ' || to_char(p.withholding_amount, 'FM999,999,999') || ' withholding recorded on it is reversed too.'))::text);
  end if;
  if v_inv.id is not null then
    v_e := array_append(v_e, (('Invoice ' || v_inv.invoice_number || ' is owed PKR '
                   || to_char(p.amount + coalesce(p.withholding_amount, 0), 'FM999,999,999') || ' again.'))::text);
  else
    v_e := array_append(v_e, ('The client''s balance is owed the amount again.')::text);
  end if;
  v_e := array_append(v_e, ('The receipt''s journal entry is reversed.')::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('invoice_payment', p_payment_id, v_title, v_b, v_e, p_preview);
  end if;

  perform public.delete_invoice_payment(p_payment_id);

  if v_inv.id is not null then
    select amount_received into v_left from public.invoices where id = v_inv.id;
    update public.invoices
       set status = case when coalesce(v_left, 0) <= 0 then 'Unpaid'
                         when v_left < invoice_amount then 'Partly-Paid'
                         else status end,
           updated_at = now()
     where id = v_inv.id and status in ('Paid', 'Partly-Paid', 'Unpaid');
  end if;

  v_rid := public.reversal_finish(p.company_id, 'invoice_payment', p.id, v_title, 'error', p_reason, to_jsonb(p), v_e);
  return public.reversal_result('invoice_payment', p_payment_id, v_title, v_b, v_e, false, v_rid);
end;
$function$;

revoke execute on function public.reverse_payslip_disbursement(uuid, text, boolean, text) from public, anon;
revoke execute on function public.reverse_separation(uuid, text, boolean) from public, anon;
revoke execute on function public.reverse_invoice_payment(uuid, text, boolean) from public, anon;
revoke execute on function public.reverse_separation_legacy(uuid, text, boolean) from public, anon;
grant execute on function public.reverse_separation_legacy(uuid, text, boolean) to authenticated;
grant execute on function public.reverse_payslip_disbursement(uuid, text, boolean, text) to authenticated;
grant execute on function public.reverse_separation(uuid, text, boolean) to authenticated;
grant execute on function public.reverse_invoice_payment(uuid, text, boolean) to authenticated;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0503 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
