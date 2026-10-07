-- 0505 — Reversals, phase 3: inventory, kit, clearance, fixed assets,
-- attendance verification, employee status and expense-request decisions.
-- Same contract as 0503/0504 (reversals.execute, tenant guard, preview = the
-- same body, blockers refuse, one reversal per source).

-- ===========================================================================
-- INVENTORY PURCHASE — only while what it bought is still on the shelf
-- ===========================================================================
-- Stock is a moving average, so a purchase is taken back out at its own unit
-- cost and the remaining units re-averaged. If any line's units have been
-- issued since, the shelf cannot give them back: the line is named.
create or replace function public.reverse_inventory_purchase(p_purchase_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  pu record; l record; st record; v_title text; v_b text[] := '{}'; v_e text[] := '{}';
  v_rid uuid; v_new int; v_cost numeric; v_name text;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.inventory_purchases where id = p_purchase_id));
  perform public.reversal_check('inventory_purchase', p_purchase_id, p_reason, p_preview);
  select * into pu from public.inventory_purchases where id = p_purchase_id for update;
  if pu.id is null then raise exception 'That purchase no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Inventory purchase ' || to_char(pu.purchase_date, 'DD Mon YYYY') || ' · PKR '
          || to_char(coalesce(pu.total_actual, 0), 'FM999,999,999') || coalesce(' · ' || pu.description, '');

  for l in select * from public.inventory_purchase_lines where purchase_id = pu.id loop
    select name into v_name from public.inventory_item_types where id = l.item_type_id;
    select * into st from public.inventory_stock s
     where s.company_id = pu.company_id and s.item_type_id = l.item_type_id
       and coalesce(s.size, '') = coalesce(l.size, '') and s.grade = l.grade
       and s.serial_number is not distinct from l.serial_number
     limit 1;
    if st.id is null or st.quantity < l.quantity then
      v_b := array_append(v_b, (coalesce(v_name, 'An item') || coalesce(' ' || l.size, '') || ': '
             || l.quantity || ' bought, ' || coalesce(st.quantity, 0) || ' left in the store. Return the issued units first.')::text);
    end if;
  end loop;

  v_e := array_append(v_e, 'The purchased units come off the shelf; the remaining stock is re-averaged.'::text);
  if pu.payment_mode in ('Cash', 'Bank') then
    v_e := array_append(v_e, ('PKR ' || to_char(coalesce(pu.total_actual, 0), 'FM999,999,999') || ' goes back to ' || lower(pu.payment_mode) || '.')::text);
  elsif pu.payment_mode = 'Payable' then
    v_e := array_append(v_e, 'The amount owed to the vendor is reversed.'::text);
  end if;
  v_e := array_append(v_e, 'The purchase journal entry is reversed. The purchase record stays, marked reversed.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('inventory_purchase', p_purchase_id, v_title, v_b, v_e, p_preview);
  end if;

  for l in select * from public.inventory_purchase_lines where purchase_id = pu.id loop
    select * into st from public.inventory_stock s
     where s.company_id = pu.company_id and s.item_type_id = l.item_type_id
       and coalesce(s.size, '') = coalesce(l.size, '') and s.grade = l.grade
       and s.serial_number is not distinct from l.serial_number
     limit 1 for update;
    v_new := st.quantity - l.quantity;
    if v_new <= 0 then
      v_cost := st.unit_actual_cost;
    else
      v_cost := round((st.quantity * st.unit_actual_cost - l.quantity * l.unit_actual_cost) / v_new, 2);
      if v_cost <= 0 then v_cost := st.unit_actual_cost; end if;
    end if;
    update public.inventory_stock set quantity = v_new, unit_actual_cost = v_cost, updated_at = now() where id = st.id;
  end loop;

  perform public.reverse_journal_for_source(pu.company_id, 'inventory_purchases', pu.id, pu.purchase_date);
  if coalesce(pu.total_actual, 0) > 0 then
    perform public.apply_money_delta(pu.company_id, pu.payment_mode, pu.bank_account_id, pu.total_actual,
                                     'inventory_purchase', 'Reversal · ' || v_title, pu.id::text);
  end if;

  v_rid := public.reversal_finish(pu.company_id, 'inventory_purchase', pu.id, v_title, 'error', p_reason, to_jsonb(pu), v_e);
  return public.reversal_result('inventory_purchase', p_purchase_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- KIT MOVEMENT — an issue, a return or a handover, the newest in its chain
-- ===========================================================================
create or replace function public.reverse_kit_event(p_event_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  ev record; st record; v_chain uuid; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_name text; v_who text;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.kit_events where id = p_event_id));
  perform public.reversal_check('kit_event', p_event_id, p_reason, p_preview);
  select * into ev from public.kit_events where id = p_event_id for update;
  if ev.id is null then raise exception 'That kit movement no longer exists.' using errcode = 'P0001'; end if;
  v_chain := coalesce(ev.issue_id, ev.id);
  select name into v_name from public.inventory_item_types where id = ev.item_type_id;
  v_who := coalesce((select full_name from public.employees where id = coalesce(ev.to_employee_id, ev.from_employee_id)),
                    (select name from public.sites where id = ev.site_id), '');
  v_title := initcap(ev.event::text) || ' · ' || ev.quantity || ' × ' || coalesce(v_name, 'item')
          || coalesce(' ' || ev.size, '') || ' · ' || v_who;

  if exists (select 1 from public.kit_events x where coalesce(x.issue_id, x.id) = v_chain and x.id <> ev.id
               and (x.event_date > ev.event_date or (x.event_date = ev.event_date and x.seq > ev.seq))) then
    v_b := array_append(v_b, 'A later movement of this kit exists (a return or handover). Reverse that first.'::text);
  end if;
  if ev.event = 'issue' then
    if ev.costed_month is not null then
      v_b := array_append(v_b, ('It has already been charged to the client in ' || to_char(ev.costed_month, 'Mon YYYY') || '. Record a return instead.')::text);
    end if;
    if exists (select 1 from public.clearance_kit_items k where k.issue_id = ev.id) then
      v_b := array_append(v_b, 'It is on a clearance assessment. Reverse the clearance first.'::text);
    end if;
    v_e := array_append(v_e, (ev.quantity || ' unit(s) go back on the shelf.')::text);
  elsif ev.event = 'return' then
    if ev.condition::text <> 'unusable' then
      select * into st from public.inventory_stock s
       where s.company_id = ev.company_id and s.item_type_id = ev.item_type_id
         and coalesce(s.size, '') = coalesce(ev.size, '') and s.grade = 'used'
         and s.serial_number is not distinct from ev.serial_number limit 1;
      if st.id is null or st.quantity < ev.quantity then
        v_b := array_append(v_b, 'The returned units are no longer on the shelf (re-issued since). Return them first.'::text);
      end if;
      v_e := array_append(v_e, (ev.quantity || ' used unit(s) come off the shelf.')::text);
    end if;
    v_e := array_append(v_e, 'The kit is out with him again, as before the return.'::text);
  else
    v_e := array_append(v_e, 'The kit is back with the guard who handed it over, in the condition he held it.'::text);
  end if;
  v_e := array_append(v_e, 'The movement is removed from the kit history and kept in the reversal.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('kit_event', p_event_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.require_perm('inventory.edit');

  if ev.event = 'issue' then
    update public.inventory_stock s set quantity = s.quantity + ev.quantity, updated_at = now()
     where s.company_id = ev.company_id and s.item_type_id = ev.item_type_id
       and coalesce(s.size, '') = coalesce(ev.size, '') and s.grade = ev.grade
       and s.serial_number is not distinct from ev.serial_number;
    if not found then
      insert into public.inventory_stock (company_id, item_type_id, branch_id, size, grade, serial_number, quantity, unit_actual_cost)
      values (ev.company_id, ev.item_type_id, ev.branch_id, ev.size, ev.grade, ev.serial_number, ev.quantity, ev.unit_actual_cost);
    end if;
  elsif ev.event = 'return' and ev.condition::text <> 'unusable' then
    update public.inventory_stock set quantity = quantity - ev.quantity, updated_at = now() where id = st.id;
  end if;
  delete from public.kit_events where id = ev.id;

  v_rid := public.reversal_finish(ev.company_id, 'kit_event', ev.id, v_title, 'error', p_reason, to_jsonb(ev), v_e);
  return public.reversal_result('kit_event', p_event_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- CLEARANCE, OPERATIONS STAGE — back to "not cleared"
-- ===========================================================================
-- ops_clear_employee returned the reusable / unusable kit through return_kit in
-- the same transaction that stamped ops_cleared_at, so those returns share its
-- now() and are found by it. They are taken back off the shelf; the item
-- outcomes and fines stay on the assessment for ops to re-clear.
create or replace function public.reverse_clearance_ops(p_certificate_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare c record; r record; st record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_n int := 0;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.clearance_certificates where id = p_certificate_id));
  perform public.reversal_check('clearance_ops', p_certificate_id, p_reason, p_preview,
    (select ops_cleared_at from public.clearance_certificates where id = p_certificate_id));
  select * into c from public.clearance_certificates where id = p_certificate_id for update;
  if c.id is null then raise exception 'That clearance no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Clearance (operations) · ' || coalesce(public.employee_display_code(c.employee_id) || ' ', '')
          || coalesce((select full_name from public.employees where id = c.employee_id), '');

  if c.ops_cleared_at is null then
    v_b := array_append(v_b, 'Operations has not cleared him.'::text);
  end if;
  if c.dues_released then
    v_b := array_append(v_b, 'Finance has released his dues. Reverse the dues release first.'::text);
  end if;
  for r in select * from public.kit_events k
            where k.event = 'return' and k.notes = 'Clearance' and k.from_employee_id = c.employee_id
              and k.created_at = c.ops_cleared_at loop
    v_n := v_n + 1;
    if r.condition::text <> 'unusable' then
      select * into st from public.inventory_stock s
       where s.company_id = r.company_id and s.item_type_id = r.item_type_id
         and coalesce(s.size, '') = coalesce(r.size, '') and s.grade = 'used'
         and s.serial_number is not distinct from r.serial_number limit 1;
      if st.id is null or st.quantity < r.quantity then
        v_b := array_append(v_b, 'Kit returned at this clearance has been re-issued since. Return it first.'::text);
      end if;
    end if;
  end loop;

  v_e := array_append(v_e, 'He shows as not cleared again; finance cannot see him until ops clears him.'::text);
  if v_n > 0 then
    v_e := array_append(v_e, (v_n || ' kit return(s) made by the clearance are undone — the kit is out with him again.')::text);
  end if;
  v_e := array_append(v_e, 'Item outcomes and fines stay on the assessment, ready to re-clear. Any recorded signature is cleared.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('clearance_ops', p_certificate_id, v_title, v_b, v_e, p_preview);
  end if;

  for r in select * from public.kit_events k
            where k.event = 'return' and k.notes = 'Clearance' and k.from_employee_id = c.employee_id
              and k.created_at = c.ops_cleared_at loop
    if r.condition::text <> 'unusable' then
      update public.inventory_stock s set quantity = s.quantity - r.quantity, updated_at = now()
       where s.company_id = r.company_id and s.item_type_id = r.item_type_id
         and coalesce(s.size, '') = coalesce(r.size, '') and s.grade = 'used'
         and s.serial_number is not distinct from r.serial_number;
    end if;
    delete from public.kit_events where id = r.id;
  end loop;

  update public.clearance_certificates
     set ops_cleared_at = null, ops_cleared_by = null, kit_fine_total = 0, kit_summary = null,
         outstanding_kit_count = null, kit_returned = null, signed_at = null, signed_by = null, updated_at = now()
   where id = c.id;

  v_rid := public.reversal_finish(c.company_id, 'clearance_ops', c.id, v_title, 'error', p_reason, to_jsonb(c), v_e);
  return public.reversal_result('clearance_ops', p_certificate_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- FINAL DUES RELEASE — the fine comes off his payslips again
-- ===========================================================================
-- release_final_dues wrote each deduction into the payslip's notes as
-- "Kit fine PKR <n> (clearance)" — its own fixed format — so the same text is
-- the record of how much to give back to each payslip.
create or replace function public.reverse_dues_release(p_certificate_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare c record; ps record; v_take numeric; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_n int := 0;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.clearance_certificates where id = p_certificate_id));
  perform public.reversal_check('dues_release', p_certificate_id, p_reason, p_preview,
    (select updated_at from public.clearance_certificates where id = p_certificate_id));
  select * into c from public.clearance_certificates where id = p_certificate_id for update;
  if c.id is null then raise exception 'That clearance no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Dues released · ' || coalesce(public.employee_display_code(c.employee_id) || ' ', '')
          || coalesce((select full_name from public.employees where id = c.employee_id), '');

  if not c.dues_released then
    v_b := array_append(v_b, 'His dues have not been released.'::text);
  end if;
  if exists (select 1 from public.payslips p where p.employee_id = c.employee_id and p.disbursed
               and p.notes like '%Kit fine PKR % (clearance)%') then
    v_b := array_append(v_b, 'His final pay (with the fine deducted) has been disbursed. Reverse that disbursement first.'::text);
  end if;
  select count(*) into v_n from public.payslips p where p.employee_id = c.employee_id and not p.disbursed
     and p.notes like '%Kit fine PKR % (clearance)%';
  if coalesce(c.kit_fine_total, 0) > 0 then
    v_e := array_append(v_e, ('The kit fine of PKR ' || to_char(c.kit_fine_total, 'FM999,999,999') || ' is taken off ' || v_n || ' payslip(s) again and its journal entry reversed.')::text);
  end if;
  v_e := array_append(v_e, 'The certificate goes back to awaiting release; finance can release it again.'::text);

  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('dues_release', p_certificate_id, v_title, v_b, v_e, p_preview);
  end if;

  for ps in select * from public.payslips p where p.employee_id = c.employee_id and not p.disbursed
              and p.notes like '%Kit fine PKR % (clearance)%' for update loop
    v_take := replace(substring(ps.notes from 'Kit fine PKR ([0-9,.]+) \(clearance\)'), ',', '')::numeric;
    update public.payslips
       set deductions = greatest(0, coalesce(deductions, 0) - v_take),
           final_salary = final_salary + v_take,
           net_salary = net_salary + v_take,
           notes = nullif(btrim(regexp_replace(notes, '( · )?Kit fine PKR [0-9,.]+ \(clearance\)', '')), ''),
           updated_at = now()
     where id = ps.id;
  end loop;
  perform public.reverse_journal_for_source(c.company_id, 'kit_fine', c.id, coalesce(c.dues_released_on, current_date));
  update public.clearance_certificates
     set dues_released = false, dues_released_on = null, fine_written_off = 0, cumulative_paid = 0,
         status = 'pending', updated_at = now()
   where id = c.id;

  v_rid := public.reversal_finish(c.company_id, 'dues_release', c.id, v_title, 'error', p_reason, to_jsonb(c), v_e);
  return public.reversal_result('dues_release', p_certificate_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- FIXED ASSET: CAPITALISATION, DISPOSAL, ONE MONTH'S DEPRECIATION
-- ===========================================================================
create or replace function public.reverse_fixed_asset(p_asset_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare a record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.fixed_assets where id = p_asset_id));
  perform public.reversal_check('fixed_asset', p_asset_id, p_reason, p_preview);
  select * into a from public.fixed_assets where id = p_asset_id for update;
  if a.id is null then raise exception 'That asset no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Asset capitalised · ' || a.name || ' · PKR ' || to_char(a.cost, 'FM999,999,999');
  if exists (select 1 from public.depreciation_entries d where d.asset_id = a.id) then
    v_b := array_append(v_b, 'Depreciation has been run on it. Reverse those months first, newest first.'::text);
  end if;
  if a.status <> 'active' then
    v_b := array_append(v_b, ('It is ' || a.status || '. Reverse the disposal first.')::text);
  end if;
  v_e := array_append(v_e, 'The asset leaves the register and its purchase entry is reversed.'::text);
  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('fixed_asset', p_asset_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.require_perm('accounting.edit');
  delete from public.fixed_assets where id = a.id;
  v_rid := public.reversal_finish(a.company_id, 'fixed_asset', a.id, v_title, 'error', p_reason, to_jsonb(a), v_e);
  return public.reversal_result('fixed_asset', p_asset_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

create or replace function public.reverse_asset_disposal(p_asset_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare a record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.fixed_assets where id = p_asset_id));
  perform public.reversal_check('asset_disposal', p_asset_id, p_reason, p_preview,
    (select updated_at from public.fixed_assets where id = p_asset_id));
  select * into a from public.fixed_assets where id = p_asset_id for update;
  if a.id is null then raise exception 'That asset no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Asset disposed · ' || a.name;
  if a.status <> 'disposed' then
    v_b := array_append(v_b, 'It is not disposed.'::text);
  end if;
  v_e := array_append(v_e, 'The asset is active again at its cost and depreciation; the disposal entry (and any gain or loss) is reversed.'::text);
  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('asset_disposal', p_asset_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.require_perm('accounting.edit');
  perform public.reverse_journal_for_source(a.company_id, 'fixed_assets_disposal', a.id, coalesce(a.disposal_date, current_date));
  update public.fixed_assets
     set status = 'active', disposal_date = null, disposal_proceeds = null, updated_at = now()
   where id = a.id;
  v_rid := public.reversal_finish(a.company_id, 'asset_disposal', a.id, v_title, 'error', p_reason, to_jsonb(a), v_e);
  return public.reversal_result('asset_disposal', p_asset_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

create or replace function public.reverse_depreciation_entry(p_entry_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare d record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_name text;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.depreciation_entries where id = p_entry_id));
  perform public.reversal_check('depreciation_entry', p_entry_id, p_reason, p_preview);
  select * into d from public.depreciation_entries where id = p_entry_id for update;
  if d.id is null then raise exception 'That depreciation entry no longer exists.' using errcode = 'P0001'; end if;
  select name into v_name from public.fixed_assets where id = d.asset_id;
  v_title := 'Depreciation ' || to_char(d.period_month, 'Mon YYYY') || ' · ' || coalesce(v_name, 'asset')
          || ' · PKR ' || to_char(d.amount, 'FM999,999,999');
  if exists (select 1 from public.depreciation_entries x where x.asset_id = d.asset_id and x.period_month > d.period_month) then
    v_b := array_append(v_b, 'A later month has been depreciated for this asset. Reverse that month first.'::text);
  end if;
  v_e := array_append(v_e, 'The month''s depreciation entry is reversed and the asset''s accumulated depreciation falls by it.'::text);
  v_e := array_append(v_e, 'Run depreciation for that month again to repost it.'::text);
  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('depreciation_entry', p_entry_id, v_title, v_b, v_e, p_preview);
  end if;
  perform public.require_perm('accounting.edit');
  perform public.reverse_journal_for_source(d.company_id, 'depreciation_entries', d.id,
                                            (d.period_month + interval '1 month - 1 day')::date);
  delete from public.depreciation_entries where id = d.id;
  v_rid := public.reversal_finish(d.company_id, 'depreciation_entry', d.id, v_title, 'error', p_reason, to_jsonb(d), v_e);
  return public.reversal_result('depreciation_entry', p_entry_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- ATTENDANCE VERIFICATION (one half-month, every stage at once)
-- ===========================================================================
-- The board's own undo goes stage by stage under each stage's key. This is the
-- administrator's version: the half goes back to unverified in one step, under
-- the same freeze attendance_half_action applies (payroll past Draft).
create or replace function public.reverse_attendance_verification(p_verification_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare h record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.attendance_half_verifications where id = p_verification_id));
  perform public.reversal_check('attendance_verification', p_verification_id, p_reason, p_preview,
    (select updated_at from public.attendance_half_verifications where id = p_verification_id));
  select * into h from public.attendance_half_verifications where id = p_verification_id for update;
  if h.id is null then raise exception 'That verification no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Attendance verified · ' || coalesce((select name from public.clients where id = h.client_id), initcap(replace(h.category, '_', ' ')))
          || ' · ' || to_char(h.period_month, 'Mon YYYY') || ' half ' || h.half;
  if h.hr_verified_at is null and h.ops_verified_at is null and h.finance_verified_at is null then
    v_b := array_append(v_b, 'Nothing is verified on this half.'::text);
  end if;
  if exists (select 1 from public.payroll_run_phases ph
              where ph.period_month = h.period_month and ph.phase in ('review', 'finance_verify')
                and (ph.client_id = h.client_id or (h.client_id is null and ph.category = h.category))) then
    v_b := array_append(v_b, 'Payroll for this month has moved past Draft. Move payroll back to Draft first.'::text);
  end if;
  v_e := array_append(v_e, 'The half goes back to unverified: HR, Ops and Finance verification are all cleared.'::text);
  v_e := array_append(v_e, 'Attendance for that half can be edited again and must be re-verified before payroll.'::text);
  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('attendance_verification', p_verification_id, v_title, v_b, v_e, p_preview);
  end if;
  update public.attendance_half_verifications
     set hr_verified_by = null, hr_verified_by_name = null, hr_verified_at = null,
         ops_verified_by = null, ops_verified_by_name = null, ops_verified_at = null,
         finance_verified_by = null, finance_verified_by_name = null, finance_verified_at = null,
         updated_at = now()
   where id = h.id;
  v_rid := public.reversal_finish(h.company_id, 'attendance_verification', h.id, v_title, 'error', p_reason, to_jsonb(h), v_e);
  return public.reversal_result('attendance_verification', p_verification_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- REHIRE — back to separated, as he was before it (by snapshot)
-- ===========================================================================
create or replace function public.reverse_rehire(p_snapshot_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare s record; e record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid; v_state text; v_n int;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.employee_state_snapshots where id = p_snapshot_id));
  perform public.reversal_check('rehire', p_snapshot_id, p_reason, p_preview);
  select * into s from public.employee_state_snapshots where id = p_snapshot_id;
  if s.id is null or s.kind <> 'rehire' then raise exception 'That is not a recorded rehire.' using errcode = 'P0001'; end if;
  select * into e from public.employees where id = s.employee_id for update;
  v_state := s.employee ->> 'lifecycle_state';
  v_title := 'Rehire · ' || coalesce(public.employee_display_code(e.id) || ' ', '') || e.full_name;

  if exists (select 1 from public.employee_state_snapshots s2 where s2.employee_id = s.employee_id and s2.taken_at > s.taken_at) then
    v_b := array_append(v_b, 'He has changed since (separated again). Reverse the later change first.'::text);
  end if;
  if e.lifecycle_state::text <> 'active' then
    v_b := array_append(v_b, ('He is ' || e.lifecycle_state || ' now, not active.')::text);
  end if;
  select count(*) into v_n from public.attendance_records a
   where a.employee_id = e.id and a.attendance_date >= e.join_date
     and lower(a.status) in ('present', 'double_duty', 'relief_cover');
  if v_n > 0 then
    v_b := array_append(v_b, ('He has ' || v_n || ' worked day(s) since the rehire. Clear that attendance first.')::text);
  end if;
  if exists (select 1 from public.payslips p where p.employee_id = e.id
               and p.period_month >= date_trunc('month', e.join_date)::date and p.disbursed) then
    v_b := array_append(v_b, 'He has been paid for the new stint. Reverse that disbursement first.'::text);
  end if;
  v_e := array_append(v_e, ('Back to ' || v_state || ' with his previous exit dates and reason.')::text);
  v_e := array_append(v_e, 'The posting the rehire opened is removed and the rehire count goes back.'::text);
  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('rehire', p_snapshot_id, v_title, v_b, v_e, p_preview);
  end if;

  perform set_config('app.reversal', 'on', true);
  delete from public.deployments d
   where d.guard_id = e.id and d.reason = 'new_hire' and d.created_at >= s.taken_at;
  update public.employees set
    lifecycle_state     = v_state::public.employee_lifecycle_state,
    join_date           = (s.employee ->> 'join_date')::date,
    last_working_day    = (s.employee ->> 'last_working_day')::date,
    termination_date    = (s.employee ->> 'termination_date')::date,
    separation_reason   = (s.employee ->> 'separation_reason')::public.separation_reason,
    exit_reason         = s.employee ->> 'exit_reason',
    exit_date           = (s.employee ->> 'exit_date')::date,
    eligible_for_rehire = (s.employee ->> 'eligible_for_rehire')::boolean,
    rehire_count        = coalesce((s.employee ->> 'rehire_count')::int, rehire_count),
    updated_at          = now()
  where id = e.id;
  insert into public.employee_lifecycle_events (company_id, employee_id, from_state, to_state, reason, changed_by, notes)
  values (e.company_id, e.id, e.lifecycle_state, v_state::public.employee_lifecycle_state, 'Reversal of rehire', auth.uid(), btrim(p_reason));
  perform set_config('app.reversal', '', true);

  v_rid := public.reversal_finish(e.company_id, 'rehire', s.id, v_title, 'error', p_reason, to_jsonb(s), v_e);
  return public.reversal_result('rehire', p_snapshot_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- OTHER STATUS CHANGES (archive, on leave, waitlist ...) — the newest event
-- ===========================================================================
-- Exits and rehires have their own snapshot-based reversals above; this covers
-- every other lifecycle move, which changes the state and nothing else.
create or replace function public.reverse_lifecycle_change(p_event_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare ev record; e record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid;
  v_exit text[] := array['left', 'terminated', 'fired', 'absconded'];
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.employee_lifecycle_events where id = p_event_id));
  perform public.reversal_check('lifecycle_change', p_event_id, p_reason, p_preview);
  select * into ev from public.employee_lifecycle_events where id = p_event_id;
  if ev.id is null then raise exception 'That status change no longer exists.' using errcode = 'P0001'; end if;
  select * into e from public.employees where id = ev.employee_id for update;
  v_title := initcap(coalesce(ev.from_state::text, '?')) || ' → ' || initcap(ev.to_state::text) || ' · '
          || coalesce(public.employee_display_code(e.id) || ' ', '') || e.full_name;
  if ev.to_state::text = any (v_exit) or (ev.from_state::text = any (v_exit) and ev.to_state::text = 'active') then
    v_b := array_append(v_b, 'Exits and rehires are reversed from their own entries (Separation / Rehire).'::text);
  end if;
  if ev.from_state is null then
    v_b := array_append(v_b, 'This was his first status; there is nothing to go back to.'::text);
  end if;
  if exists (select 1 from public.employee_lifecycle_events x where x.employee_id = ev.employee_id and x.changed_at > ev.changed_at) then
    v_b := array_append(v_b, 'His status has changed again since. Reverse the newer change first.'::text);
  end if;
  if e.lifecycle_state is distinct from ev.to_state then
    v_b := array_append(v_b, ('He is ' || e.lifecycle_state || ' now, not ' || ev.to_state || '.')::text);
  end if;
  v_e := array_append(v_e, ('His status goes back to ' || coalesce(ev.from_state::text, '?') || '.')::text);
  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('lifecycle_change', p_event_id, v_title, v_b, v_e, p_preview);
  end if;
  perform set_config('app.reversal', 'on', true);
  update public.employees set lifecycle_state = ev.from_state, updated_at = now() where id = e.id;
  insert into public.employee_lifecycle_events (company_id, employee_id, from_state, to_state, reason, changed_by, notes)
  values (e.company_id, e.id, ev.to_state, ev.from_state, 'Reversal of status change', auth.uid(), btrim(p_reason));
  perform set_config('app.reversal', '', true);
  v_rid := public.reversal_finish(e.company_id, 'lifecycle_change', ev.id, v_title, 'error', p_reason, to_jsonb(ev), v_e);
  return public.reversal_result('lifecycle_change', p_event_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

-- ===========================================================================
-- EXPENSE REQUEST DECISION (approved / rejected -> pending)
-- ===========================================================================
create or replace function public.reverse_expense_request_decision(p_request_id uuid, p_reason text, p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare r record; v_title text; v_b text[] := '{}'; v_e text[] := '{}'; v_rid uuid;
begin
  perform public.require_perm('reversals.execute');
  perform public.assert_same_company((select company_id from public.expense_requests where id = p_request_id));
  perform public.reversal_check('expense_request_decision', p_request_id, p_reason, p_preview,
    (select decided_at from public.expense_requests where id = p_request_id));
  select * into r from public.expense_requests where id = p_request_id for update;
  if r.id is null then raise exception 'That request no longer exists.' using errcode = 'P0001'; end if;
  v_title := 'Request ' || r.status || ' · PKR ' || to_char(r.amount, 'FM999,999,999') || coalesce(' · ' || r.requested_by_name, '');
  if r.status = 'pending' then
    v_b := array_append(v_b, 'It has not been decided.'::text);
  end if;
  if r.expense_id is not null then
    v_b := array_append(v_b, 'An expense has been recorded from it. Reverse that expense first.'::text);
  end if;
  v_e := array_append(v_e, 'The request is pending again and goes back to the approvers.'::text);
  if p_preview or cardinality(v_b) > 0 then
    return public.reversal_result('expense_request_decision', p_request_id, v_title, v_b, v_e, p_preview);
  end if;
  update public.expense_requests
     set status = 'pending', decided_by = null, decided_by_name = null, decided_at = null,
         decision_note = null, updated_at = now()
   where id = r.id;
  v_rid := public.reversal_finish(r.company_id, 'expense_request_decision', r.id, v_title, 'error', p_reason, to_jsonb(r), v_e);
  return public.reversal_result('expense_request_decision', p_request_id, v_title, v_b, v_e, false, v_rid);
end; $function$;

do $$
declare f text;
begin
  foreach f in array array[
    'reverse_inventory_purchase(uuid,text,boolean)', 'reverse_kit_event(uuid,text,boolean)',
    'reverse_clearance_ops(uuid,text,boolean)', 'reverse_dues_release(uuid,text,boolean)',
    'reverse_fixed_asset(uuid,text,boolean)', 'reverse_asset_disposal(uuid,text,boolean)',
    'reverse_depreciation_entry(uuid,text,boolean)', 'reverse_attendance_verification(uuid,text,boolean)',
    'reverse_rehire(uuid,text,boolean)', 'reverse_lifecycle_change(uuid,text,boolean)',
    'reverse_expense_request_decision(uuid,text,boolean)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0505 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
