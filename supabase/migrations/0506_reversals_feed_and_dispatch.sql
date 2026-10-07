-- 0506 — Reversals: what the page reads (reversible_actions) and the one door
-- it calls through (reverse_action).
--
-- reversible_actions is SECURITY INVOKER: it reads every source table under the
-- caller's own RLS, so a regional user sees his region's actions and nothing
-- else. That is the right shape for a READ (0377's warning is about writes that
-- quietly do less; a list that shows less is the correct list).
--
-- reverse_action dispatches by kind to the reverse_* functions of 0503-0505.
-- It is INVOKER too and does nothing but route: each target asserts its own
-- permission, tenant and blockers.
--
-- A reversed source either disappears from its table (a deleted payment) and
-- is found on the History tab, or stays and is marked: reversed_at is the
-- newest reversal of that source made AFTER the state the row is in now.

create or replace function public.reversible_actions(
  p_kind text default null, p_from date default null, p_search text default null, p_limit int default 400)
returns table(kind text, source_id uuid, occurred_at timestamptz, title text, detail text, amount numeric,
              employee_id uuid, client_id uuid, reversal_id uuid, reversed_at timestamptz)
language plpgsql
stable
set search_path to 'public'
as $function$
declare v_from timestamptz := coalesce(p_from, current_date - 120)::timestamptz;
begin
  perform public.require_perm('reversals.execute');
  return query
  with x as (
    -- PHASE 1 ---------------------------------------------------------------
    select 'payslip_disbursement'::text k, p.id sid, coalesce(p.disbursed_at, p.updated_at) at,
           ('Salary ' || to_char(p.period_month, 'Mon YYYY') || ' · ' || coalesce(public.employee_display_code(p.employee_id) || ' ', '') || coalesce(e.full_name, '')) t,
           ('Paid by ' || coalesce(p.payment_mode, '?')) d, p.amount_paid::numeric amt, p.employee_id emp, e.client_id cli
      from public.payslips p join public.employees e on e.id = p.employee_id
     where (p.disbursed or coalesce(p.amount_paid, 0) > 0) and coalesce(p.disbursed_at, p.updated_at) >= v_from
    union all
    select 'separation', s.id, s.taken_at,
           (initcap(s.to_state) || ' · ' || coalesce(public.employee_display_code(s.employee_id) || ' ', '') || coalesce(e.full_name, '')),
           ('From ' || s.from_state || coalesce(' · last day ' || to_char(e.last_working_day, 'DD Mon YYYY'), '')), null::numeric, s.employee_id, e.client_id
      from public.employee_state_snapshots s join public.employees e on e.id = s.employee_id
     where s.kind = 'separation' and s.taken_at >= v_from
    union all
    select 'separation_legacy', e.id, coalesce(e.exit_date::timestamptz, e.updated_at),
           (initcap(e.lifecycle_state::text) || ' · ' || coalesce(public.employee_display_code(e.id) || ' ', '') || e.full_name),
           ('Recorded before reversals kept copies' || coalesce(' · last day ' || to_char(e.last_working_day, 'DD Mon YYYY'), '')),
           null::numeric, e.id, e.client_id
      from public.employees e
     where e.lifecycle_state::text in ('left', 'terminated', 'fired', 'absconded')
       and not exists (select 1 from public.employee_state_snapshots s where s.employee_id = e.id and s.kind = 'separation')
       and coalesce(e.exit_date::timestamptz, e.updated_at) >= v_from
    union all
    select 'invoice_payment', ip.id, ip.created_at,
           ('Payment · ' || coalesce(c.name, 'Client') || coalesce(' · ' || i.invoice_number, '')),
           (ip.payment_mode || ' · ' || to_char(ip.payment_date, 'DD Mon YYYY')
             || case when coalesce(ip.withholding_amount, 0) > 0 then ' · WHT ' || to_char(ip.withholding_amount, 'FM999,999,999') else '' end),
           ip.amount, null::uuid, ip.client_id
      from public.invoice_payments ip
      left join public.clients c on c.id = ip.client_id
      left join public.invoices i on i.id = ip.invoice_id
     where ip.created_at >= v_from
    -- PHASE 2 ---------------------------------------------------------------
    union all
    select 'expense', ex.id, ex.created_at,
           ('Expense · ' || coalesce(cat.name, 'Expense') || coalesce(' · ' || nullif(btrim(ex.description), ''), '')),
           (ex.payment_mode || ' · ' || to_char(ex.expense_date, 'DD Mon YYYY')), ex.amount, null::uuid, ex.client_id
      from public.expenses ex left join public.expense_categories cat on cat.id = ex.category_id
     where ex.created_at >= v_from
    union all
    select 'payable_settlement', ex.id, coalesce(ex.paid_at, ex.updated_at),
           ('Payable settled · ' || coalesce(nullif(btrim(ex.description), ''), 'bill')),
           ('Paid via ' || coalesce(ex.paid_via, '?')), ex.amount, null::uuid, ex.client_id
      from public.expenses ex
     where ex.payment_mode = 'Payable' and ex.payable_status = 'Paid'
       and not exists (select 1 from public.payable_payments pp where pp.expense_id = ex.id)
       and coalesce(ex.paid_at, ex.updated_at) >= v_from
    union all
    select 'advance', a.id, a.created_at,
           ('Advance · ' || coalesce(public.employee_display_code(a.employee_id) || ' ', '') || coalesce(e.full_name, '')),
           (a.payment_mode || ' · ' || to_char(a.advance_date, 'DD Mon YYYY')), a.amount, a.employee_id, a.client_id
      from public.advances a join public.employees e on e.id = a.employee_id
     where a.payment_mode <> 'Carry-forward' and a.created_at >= v_from
    union all
    select 'vendor_payment', v.id, v.created_at,
           ('Vendor payment · ' || coalesce(vn.name, 'Vendor')), (v.paid_via || ' · ' || to_char(v.paid_on, 'DD Mon YYYY')),
           v.amount, null::uuid, null::uuid
      from public.vendor_payments v left join public.vendors vn on vn.id = v.vendor_id
     where v.created_at >= v_from
    union all
    select 'bank_transfer', bt.transfer_pair_id, bt.created_at, ('Bank transfer · ' || coalesce(bt.description, '')),
           'Between own accounts', bt.amount, null::uuid, null::uuid
      from public.bank_transactions bt
     where bt.kind = 'transfer' and bt.transfer_pair_id is not null and bt.account_delta < 0 and bt.created_at >= v_from
    union all
    select 'bank_to_custodian', bt.id, bt.created_at,
           ('Cash withdrawn to ' || coalesce(cl.name, 'custodian')), coalesce(bt.description, ''), bt.amount, null::uuid, null::uuid
      from public.bank_transactions bt left join public.cash_locations cl on cl.id::text = bt.reference_id
     where bt.kind = 'withdraw_to_cash' and bt.created_at >= v_from
    union all
    select 'custody_transfer', ct.id, ct.created_at,
           ('Custody transfer · ' || coalesce(f.name, '?') || ' → ' || coalesce(tt.name, '?')),
           to_char(ct.date, 'DD Mon YYYY'), ct.amount, null::uuid, null::uuid
      from public.custody_transfers ct
      left join public.cash_locations f on f.id = ct.from_location_id
      left join public.cash_locations tt on tt.id = ct.to_location_id
     where ct.created_at >= v_from
    union all
    select 'cash_deposit', cd.id, cd.created_at,
           ('Cash deposit · slip #' || cd.slip_number), to_char(cd.deposit_date, 'DD Mon YYYY'), cd.amount, null::uuid, null::uuid
      from public.cash_deposits cd where cd.created_at >= v_from
    union all
    select 'cheque_clearance', ch.id, coalesce(ch.cleared_at, ch.updated_at),
           ('Cheque #' || ch.cheque_number || ' cleared' || coalesce(' · ' || ch.recipient, '')),
           (ch.direction || ' · ' || ch.cheque_type), ch.amount, null::uuid, ch.client_id
      from public.cheques ch where ch.status = 'cleared' and coalesce(ch.cleared_at, ch.updated_at) >= v_from
    union all
    select 'write_off', i.id, i.updated_at, ('Write-off · invoice ' || i.invoice_number || ' · ' || coalesce(c.name, '')),
           'Bad debt', (coalesce(i.invoice_amount, 0) - coalesce(i.amount_received, 0)), null::uuid, i.client_id
      from public.invoices i left join public.clients c on c.id = i.client_id
     where i.status = 'Written-Off' and i.updated_at >= v_from
    union all
    select 'partner_entry', pe.id, pe.created_at,
           (initcap(lower(pe.type)) || ' · ' || coalesce(pa.name, 'Partner')),
           (coalesce(pe.payment_method, '') || ' · ' || to_char(pe.date, 'DD Mon YYYY')), pe.amount, null::uuid, null::uuid
      from public.partner_account_entries pe left join public.partners pa on pa.id = pe.partner_id
     where pe.created_at >= v_from and pe.type in ('DRAWING', 'CONTRIBUTION')
    union all
    select 'payroll_adjustment', a.id, a.raised_at,
           ('Adjustment · ' || coalesce(public.employee_display_code(a.employee_id) || ' ', '') || coalesce(e.full_name, '')
             || ' · ' || to_char(a.original_period_month, 'Mon YYYY')),
           (a.status::text || ' · ' || a.settlement::text || coalesce(' · ' || a.reason, '')), a.amount, a.employee_id, e.client_id
      from public.payroll_adjustments a join public.employees e on e.id = a.employee_id
     where a.status::text in ('open', 'settled') and a.raised_at >= v_from
    union all
    select 'manual_journal', j.id, j.created_at, ('Manual journal · ' || j.description), to_char(j.entry_date, 'DD Mon YYYY'),
           (select coalesce(sum(jl.debit), 0) from public.journal_lines jl where jl.journal_entry_id = j.id), null::uuid, null::uuid
      from public.journal_entries j
     where coalesce(j.manual, false) and not j.is_reversal and j.created_at >= v_from
    union all
    select 'invoice', i.id, i.created_at, ('Invoice ' || i.invoice_number || ' · ' || coalesce(c.name, '')),
           (i.status || ' · ' || to_char(coalesce(i.period_start, i.invoice_date), 'Mon YYYY')),
           coalesce(i.total_due, i.invoice_amount), null::uuid, i.client_id
      from public.invoices i left join public.clients c on c.id = i.client_id
     where i.status <> 'Written-Off' and i.created_at >= v_from
    -- PHASE 3 ---------------------------------------------------------------
    union all
    select 'inventory_purchase', pu.id, pu.created_at,
           ('Inventory purchase' || coalesce(' · ' || pu.description, '')),
           (pu.payment_mode || ' · ' || to_char(pu.purchase_date, 'DD Mon YYYY')), pu.total_actual, null::uuid, null::uuid
      from public.inventory_purchases pu where pu.created_at >= v_from
    union all
    select 'kit_event', k.id, k.created_at,
           (initcap(k.event::text) || ' · ' || k.quantity || ' × ' || coalesce(it.name, 'item') || coalesce(' ' || k.size, '')),
           coalesce(ee.full_name, si.name, ''), (k.quantity * coalesce(k.unit_actual_cost, 0)),
           coalesce(k.to_employee_id, k.from_employee_id), k.client_id
      from public.kit_events k
      left join public.inventory_item_types it on it.id = k.item_type_id
      left join public.employees ee on ee.id = coalesce(k.to_employee_id, k.from_employee_id)
      left join public.sites si on si.id = k.site_id
     where k.created_at >= v_from
    union all
    select 'clearance_ops', cc.id, cc.ops_cleared_at,
           ('Cleared by operations · ' || coalesce(public.employee_display_code(cc.employee_id) || ' ', '') || coalesce(e.full_name, '')),
           coalesce(cc.kit_summary, ''), cc.kit_fine_total, cc.employee_id, e.client_id
      from public.clearance_certificates cc join public.employees e on e.id = cc.employee_id
     where cc.ops_cleared_at is not null and cc.ops_cleared_at >= v_from
    union all
    select 'dues_release', cc.id, cc.updated_at,
           ('Dues released · ' || coalesce(public.employee_display_code(cc.employee_id) || ' ', '') || coalesce(e.full_name, '')),
           ('Fine ' || to_char(coalesce(cc.kit_fine_total, 0), 'FM999,999,999')), cc.kit_fine_total, cc.employee_id, e.client_id
      from public.clearance_certificates cc join public.employees e on e.id = cc.employee_id
     where cc.dues_released and cc.updated_at >= v_from
    union all
    select 'fixed_asset', fa.id, fa.created_at, ('Asset capitalised · ' || fa.name), fa.category::text, fa.cost, null::uuid, null::uuid
      from public.fixed_assets fa where fa.status = 'active' and fa.created_at >= v_from
    union all
    select 'asset_disposal', fa.id, fa.updated_at, ('Asset disposed · ' || fa.name),
           coalesce(to_char(fa.disposal_date, 'DD Mon YYYY'), ''), fa.disposal_proceeds, null::uuid, null::uuid
      from public.fixed_assets fa where fa.status = 'disposed' and fa.updated_at >= v_from
    union all
    select 'depreciation_entry', de.id, de.created_at,
           ('Depreciation ' || to_char(de.period_month, 'Mon YYYY') || ' · ' || coalesce(fa.name, 'asset')), '', de.amount, null::uuid, null::uuid
      from public.depreciation_entries de left join public.fixed_assets fa on fa.id = de.asset_id
     where de.created_at >= v_from
    union all
    select 'attendance_verification', h.id, h.updated_at,
           ('Attendance verified · ' || coalesce(c.name, initcap(replace(h.category, '_', ' '))) || ' · '
             || to_char(h.period_month, 'Mon YYYY') || ' half ' || h.half),
           concat_ws(' · ', case when h.hr_verified_at is not null then 'HR ' || coalesce(h.hr_verified_by_name, '') end,
                            case when h.ops_verified_at is not null then 'Ops ' || coalesce(h.ops_verified_by_name, '') end,
                            case when h.finance_verified_at is not null then 'Finance ' || coalesce(h.finance_verified_by_name, '') end),
           null::numeric, null::uuid, h.client_id
      from public.attendance_half_verifications h left join public.clients c on c.id = h.client_id
     where (h.hr_verified_at is not null or h.ops_verified_at is not null or h.finance_verified_at is not null)
       and h.updated_at >= v_from
    union all
    select 'rehire', s.id, s.taken_at,
           ('Rehire · ' || coalesce(public.employee_display_code(s.employee_id) || ' ', '') || coalesce(e.full_name, '')),
           ('Was ' || s.from_state), null::numeric, s.employee_id, e.client_id
      from public.employee_state_snapshots s join public.employees e on e.id = s.employee_id
     where s.kind = 'rehire' and s.taken_at >= v_from
    union all
    select 'lifecycle_change', le.id, le.changed_at,
           (initcap(le.from_state::text) || ' → ' || initcap(le.to_state::text) || ' · '
             || coalesce(public.employee_display_code(le.employee_id) || ' ', '') || coalesce(e.full_name, '')),
           coalesce(le.reason, ''), null::numeric, le.employee_id, e.client_id
      from public.employee_lifecycle_events le join public.employees e on e.id = le.employee_id
     where le.from_state is not null
       and le.to_state::text not in ('left', 'terminated', 'fired', 'absconded')
       and not (le.from_state::text in ('left', 'terminated', 'fired', 'absconded') and le.to_state::text = 'active')
       and coalesce(le.reason, '') not like 'Reversal of%'
       and le.changed_at >= v_from
    union all
    select 'expense_request_decision', r.id, r.decided_at,
           ('Request ' || r.status || ' · ' || coalesce(r.requested_by_name, '')),
           coalesce(r.description, ''), r.amount, null::uuid, r.client_id
      from public.expense_requests r where r.status in ('approved', 'rejected') and r.decided_at >= v_from
  )
  select x.k, x.sid, x.at, x.t, x.d, x.amt, x.emp, x.cli, rv.id, rv.reversed_at
    from x
    left join lateral (
      select r.id, r.reversed_at from public.reversals r
       where r.kind = x.k and r.source_id = x.sid and r.reversed_at >= x.at
       order by r.reversed_at desc limit 1) rv on true
   where (p_kind is null or x.k = p_kind)
     and (p_search is null or x.t ilike '%' || p_search || '%' or x.d ilike '%' || p_search || '%')
   order by x.at desc
   limit greatest(1, least(coalesce(p_limit, 400), 2000));
end;
$function$;

comment on function public.reversible_actions(text, date, text, int) is
  '0506: every action the Reversals page can reverse, newest first, under the caller''s RLS. reversal_id/reversed_at are set when this state of the source has already been reversed.';

create or replace function public.reverse_action(
  p_kind text, p_id uuid, p_reason text default null, p_preview boolean default true, p_mode text default 'error')
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
begin
  return case p_kind
    when 'payslip_disbursement'      then public.reverse_payslip_disbursement(p_id, p_reason, p_preview, p_mode)
    when 'separation'                then public.reverse_separation(p_id, p_reason, p_preview)
    when 'invoice_payment'           then public.reverse_invoice_payment(p_id, p_reason, p_preview)
    when 'separation_legacy'         then public.reverse_separation_legacy(p_id, p_reason, p_preview)
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
end;
$function$;

-- reverse_action returns null for an unknown kind; refuse instead.
create or replace function public.reverse_action_checked(
  p_kind text, p_id uuid, p_reason text default null, p_preview boolean default true, p_mode text default 'error')
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare v jsonb;
begin
  v := public.reverse_action(p_kind, p_id, p_reason, p_preview, p_mode);
  if v is null then raise exception 'Unknown reversal kind %.', p_kind using errcode = 'P0001'; end if;
  return v;
end;
$function$;

grant execute on function public.reversible_actions(text, date, text, int) to authenticated;
grant execute on function public.reverse_action(text, uuid, text, boolean, text) to authenticated;
grant execute on function public.reverse_action_checked(text, uuid, text, boolean, text) to authenticated;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0506 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
