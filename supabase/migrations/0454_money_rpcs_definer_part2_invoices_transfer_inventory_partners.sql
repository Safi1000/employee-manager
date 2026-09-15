-- 0454 — Stage B part 2 of the money-movement pass: the remaining money RPCs
-- become SECURITY DEFINER with internal asserts.
--
-- Same reasoning as 0453: INVOKER→DEFINER drops the RLS that today doubles as the
-- permission gate (the `v_n <> 1` refusal) and the tenant scope, so each function
-- restates require_perm and guards EVERY uuid parameter with a call the
-- tenant_guard_gaps() detector recognises (assert_same_company /
-- assert_branch_in_company, the param named inside the call).
--
-- KEYS: invoice family -> invoices.edit; record_bank_transfer & set_cash_opening_
-- balance -> accounting.edit; record_inventory_purchase -> inventory.edit (already
-- asserted); record_partner_entry / delete_partner_entry -> accounting.edit
-- (DECIDED with Shayan: partner drawings/contributions are finance cash moves, not
-- a partnership run post).
--
-- record_invoice_payment already carries require_perm('invoices.edit') and asserts
-- every uuid param (p_bank_account_id is in the detector's exempt list, ALREADY
-- CHECKED via a company-scoped existence probe), so it needs only the DEFINER flip.
--
-- apply_money_delta keeps its authenticated EXECUTE until part 3; every parent here
-- is now DEFINER, so part 3 can safely revoke it.

-- ── record_invoice_payment: DEFINER flip only (already fully guarded) ───────────
alter function public.record_invoice_payment(uuid,numeric,date,text,uuid,text,numeric,uuid,uuid)
  security definer;

-- ── amend_invoice_payment (invoices.edit) ──────────────────────────────────────
create or replace function public.amend_invoice_payment(
  p_payment_id uuid, p_amount numeric, p_payment_date date, p_payment_mode text,
  p_bank_account_id uuid default null, p_custodian_location_id uuid default null, p_notes text default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_n     int;
  p       record;
  v_desc  text;
  v_room  numeric;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('invoices.edit'); end if;
  perform public.assert_same_company((select company_id from public.invoice_payments where id = p_payment_id));
  if p_bank_account_id       is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment needs an amount greater than zero.' using errcode = 'P0001';
  end if;
  if p_payment_mode not in ('Cash', 'Bank') then
    raise exception 'A payment is received in Cash or Bank, not %.', p_payment_mode using errcode = 'P0001';
  end if;
  if p_payment_mode = 'Bank' and p_bank_account_id is null then
    raise exception 'A bank payment needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if p_payment_mode = 'Cash' and p_custodian_location_id is null then
    raise exception 'A cash receipt must name the custodian who received it. Nothing has been recorded.'
      using errcode = '23514';
  end if;

  select id, company_id, invoice_id, client_id, amount, withholding_amount,
         payment_mode, bank_account_id
    into p from public.invoice_payments where id = p_payment_id;
  if p.id is null then
    raise exception 'That payment does not exist, or you cannot see it. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;

  v_desc := 'Payment · ' || coalesce((select c.name from public.clients c where c.id = p.client_id), 'Client')
         || coalesce(' · Invoice ' || (select i.invoice_number from public.invoices i where i.id = p.invoice_id), '');

  perform public.apply_money_delta(
    p.company_id, p.payment_mode, p.bank_account_id, -p.amount,
    'receipt', 'Payment edit reversal · ' || v_desc, p.id::text);

  if p.invoice_id is not null then
    update public.invoices
       set amount_received = amount_received - (p.amount + coalesce(p.withholding_amount, 0)),
           updated_at = now()
     where id = p.invoice_id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception
        'Editing a payment needs the invoices.edit permission. Nothing has been recorded.'
        using errcode = '42501';
    end if;
  end if;

  if p.invoice_id is not null then
    select i.invoice_amount - i.amount_received into v_room
      from public.invoices i where i.id = p.invoice_id;
    if p_amount + coalesce(p.withholding_amount, 0) > v_room + 0.0001 then
      raise exception
        'That amount exceeds what is left on the invoice (PKR %). Nothing has been recorded.', round(v_room, 2)
        using errcode = '23514';
    end if;
  end if;

  update public.invoice_payments set
    amount = p_amount,
    payment_date = p_payment_date,
    payment_mode = p_payment_mode,
    bank_account_id = case when p_payment_mode = 'Bank' then p_bank_account_id else null end,
    custodian_location_id = case when p_payment_mode = 'Cash' then p_custodian_location_id else null end,
    notes = nullif(btrim(p_notes), '')
  where id = p_payment_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception
      'Editing a payment needs the invoices.edit permission. Nothing has been recorded.'
      using errcode = '42501';
  end if;

  if p.invoice_id is not null then
    update public.invoices
       set amount_received = amount_received + (p_amount + coalesce(p.withholding_amount, 0)),
           updated_at = now()
     where id = p.invoice_id;
  end if;

  perform public.apply_money_delta(
    p.company_id, p_payment_mode, p_bank_account_id, p_amount,
    'receipt', 'Payment updated · ' || v_desc, p.id::text);
end;
$function$;

-- ── delete_invoice_payment (invoices.edit) ─────────────────────────────────────
create or replace function public.delete_invoice_payment(p_payment_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_n int; p record; v_desc text;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('invoices.edit'); end if;
  perform public.assert_same_company((select company_id from public.invoice_payments where id = p_payment_id));
  select id, company_id, invoice_id, client_id, amount, withholding_amount,
         payment_mode, bank_account_id
    into p from public.invoice_payments where id = p_payment_id;
  if p.id is null then
    raise exception 'That payment does not exist, or you cannot see it. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;

  v_desc := 'Payment deleted · ' || coalesce((select c.name from public.clients c where c.id = p.client_id), 'Client')
         || coalesce(' · Invoice ' || (select i.invoice_number from public.invoices i where i.id = p.invoice_id), '');

  perform public.apply_money_delta(
    p.company_id, p.payment_mode, p.bank_account_id, -p.amount,
    'receipt', v_desc, p.id::text);

  if p.invoice_id is not null then
    update public.invoices
       set amount_received = amount_received - (p.amount + coalesce(p.withholding_amount, 0)),
           updated_at = now()
     where id = p.invoice_id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception
        'Deleting a payment needs the invoices.edit permission. Nothing has been recorded.'
        using errcode = '42501';
    end if;
  end if;

  delete from public.invoice_payments where id = p_payment_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception
      'Deleting a payment needs the invoices.edit permission. Nothing has been recorded.'
      using errcode = '42501';
  end if;
end;
$function$;

-- ── record_bank_transfer (accounting.edit) ─────────────────────────────────────
create or replace function public.record_bank_transfer(
  p_from_bank_account_id uuid, p_to_bank_account_id uuid, p_amount numeric, p_date date, p_notes text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_pair    uuid := gen_random_uuid();
  v_from    record;
  v_to      record;
  v_desc    text;
  v_n       int;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'A transfer needs an amount greater than zero.' using errcode = 'P0001';
  end if;
  if p_from_bank_account_id is null or p_to_bank_account_id is null then
    raise exception 'A transfer needs two accounts. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if p_from_bank_account_id = p_to_bank_account_id then
    raise exception 'A transfer needs two different accounts. Nothing has been recorded.' using errcode = '23514';
  end if;
  if p_date is null then
    raise exception 'A transfer needs a date. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  -- Both accounts asserted against the session by id (also the detector coverage).
  perform public.assert_same_company((select company_id from public.bank_accounts where id = p_from_bank_account_id));
  perform public.assert_same_company((select company_id from public.bank_accounts where id = p_to_bank_account_id));

  select id, company_id, bank_name into v_from
    from public.bank_accounts where id = p_from_bank_account_id;
  if v_from.id is null then
    raise exception 'The account money is leaving does not exist, or you cannot see it. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;

  select id, company_id, bank_name into v_to
    from public.bank_accounts where id = p_to_bank_account_id;
  if v_to.id is null then
    raise exception 'The account money is going to does not exist, or you cannot see it. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;

  if v_to.company_id is distinct from v_from.company_id then
    raise exception 'Those two accounts belong to different companies. Nothing has been recorded.'
      using errcode = '42501';
  end if;

  v_desc := 'Transfer ' || coalesce(v_from.bank_name, '?') || ' → ' || coalesce(v_to.bank_name, '?')
         || coalesce(' · ' || nullif(btrim(p_notes), ''), '');

  perform public.apply_money_delta(
    v_from.company_id, 'Bank', p_from_bank_account_id, -p_amount,
    'transfer', v_desc, v_pair::text);
  perform public.apply_money_delta(
    v_to.company_id, 'Bank', p_to_bank_account_id, p_amount,
    'transfer', v_desc, v_pair::text);

  update public.bank_transactions
     set transfer_pair_id = v_pair,
         created_at = p_date + time '12:00'
   where reference_id = v_pair::text;
  get diagnostics v_n = row_count;

  if v_n <> 2 then
    raise exception
      'A transfer must produce exactly two ledger lines and this one produced %. Nothing has been recorded.', v_n
      using errcode = 'P0001';
  end if;

  return v_pair;
end;
$function$;

-- ── record_inventory_purchase (inventory.edit; already asserts perm) ───────────
create or replace function public.record_inventory_purchase(
  p_purchase_date date, p_lines jsonb, p_payment_mode text default 'Payable',
  p_vendor_id uuid default null, p_bank_account_id uuid default null,
  p_custodian_location_id uuid default null, p_branch_id uuid default null, p_description text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_co        uuid;
  v_purchase  uuid;
  v_line      jsonb;
  v_type      public.inventory_item_types%rowtype;
  v_qty       int;
  v_unit      numeric;
  v_size      text;
  v_grade     public.stock_grade;
  v_serial    text;
  v_expiry    date;
  v_stock     uuid;
  v_old_qty   int;
  v_old_cost  numeric;
  v_total     numeric := 0;
  v_jlines    jsonb := '[]'::jsonb;
  v_credit    text;
  v_entry     uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('inventory.edit');
  end if;
  perform public.assert_branch_in_company(p_branch_id);
  perform public.assert_branch_writable(p_branch_id);
  if p_vendor_id            is not null then perform public.assert_same_company((select company_id from public.vendors where id = p_vendor_id)); end if;
  if p_bank_account_id      is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;

  v_co := public.current_company_id();
  if v_co is null then raise exception 'No company in scope'; end if;
  perform public.ensure_inventory_accounts(v_co);

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'A purchase needs at least one line';
  end if;

  insert into public.inventory_purchases
    (company_id, branch_id, purchase_date, vendor_id, payment_mode,
     bank_account_id, custodian_location_id, description, created_by)
  values (v_co, p_branch_id, p_purchase_date, p_vendor_id, p_payment_mode,
          p_bank_account_id, p_custodian_location_id, p_description, auth.uid())
  returning id into v_purchase;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_type from public.inventory_item_types
     where id = (v_line->>'item_type_id')::uuid and company_id = v_co;
    if v_type.id is null then
      raise exception 'Unknown item type on a purchase line';
    end if;

    if not v_type.issuable then
      raise exception
        'ITEM TYPE "%" IS NOT ISSUABLE, so it is an office expense and never touches inventory. Record it on the Expenses screen instead.',
        v_type.name;
    end if;

    v_qty   := (v_line->>'quantity')::int;
    v_unit  := (v_line->>'unit_actual_cost')::numeric;
    v_size  := nullif(v_line->>'size', '');
    v_grade := coalesce(nullif(v_line->>'grade', ''), 'new')::public.stock_grade;
    v_serial:= nullif(v_line->>'serial_number', '');
    v_expiry:= nullif(v_line->>'licence_expiry', '')::date;

    if v_type.serialised and v_serial is null then
      raise exception '"%" is serialised — every unit needs its own serial number.', v_type.name;
    end if;
    if v_type.sized and v_size is null then
      raise exception '"%" is stocked by size — the line needs one.', v_type.name;
    end if;

    insert into public.inventory_purchase_lines
      (company_id, purchase_id, item_type_id, size, grade, serial_number,
       licence_expiry, quantity, unit_actual_cost)
    values (v_co, v_purchase, v_type.id, v_size, v_grade, v_serial,
            v_expiry, v_qty, v_unit);

    if v_serial is not null then
      insert into public.inventory_stock
        (company_id, item_type_id, branch_id, size, grade, serial_number,
         licence_expiry, quantity, unit_actual_cost)
      values (v_co, v_type.id, p_branch_id, v_size, v_grade, v_serial,
              v_expiry, v_qty, v_unit);
    else
      select id, quantity, unit_actual_cost into v_stock, v_old_qty, v_old_cost
        from public.inventory_stock
       where company_id = v_co and item_type_id = v_type.id
         and coalesce(size, '') = coalesce(v_size, '') and grade = v_grade
         and serial_number is null
       for update;

      if v_stock is null then
        insert into public.inventory_stock
          (company_id, item_type_id, branch_id, size, grade, quantity, unit_actual_cost)
        values (v_co, v_type.id, p_branch_id, v_size, v_grade, v_qty, v_unit);
      else
        update public.inventory_stock
           set quantity = v_old_qty + v_qty,
               unit_actual_cost = case when v_old_qty + v_qty = 0 then v_unit
                 else round((v_old_qty * v_old_cost + v_qty * v_unit) / (v_old_qty + v_qty), 2) end,
               updated_at = now()
         where id = v_stock;
      end if;
    end if;

    v_total := v_total + (v_qty * v_unit);

    v_jlines := v_jlines || jsonb_build_object(
      'key', v_type.inventory_key, 'debit', v_qty * v_unit, 'credit', 0);
  end loop;

  update public.inventory_purchases set total_actual = v_total where id = v_purchase;

  v_credit := case p_payment_mode
    when 'Cash'    then 'cash'
    when 'Bank'    then 'bank'
    when 'Cheque'  then 'bank'
    else 'ap'
  end;
  v_jlines := v_jlines || jsonb_build_object('key', v_credit, 'debit', 0, 'credit', v_total);

  if v_total > 0 then
    v_entry := public.post_journal(
      v_co, p_purchase_date,
      coalesce(p_description, 'Inventory purchase'),
      'inventory_purchases', v_purchase, false, v_jlines, p_branch_id);
    update public.inventory_purchases
       set posted_at = now(), journal_entry_id = v_entry
     where id = v_purchase;

    perform public.apply_money_delta(
      v_co, p_payment_mode, p_bank_account_id, -v_total,
      'inventory_purchase',
      coalesce(p_description, 'Inventory purchase'), v_purchase::text);
  end if;

  return v_purchase;
end;
$function$;

-- ── record_partner_entry (accounting.edit — DECIDED) ───────────────────────────
create or replace function public.record_partner_entry(
  p_partner_id uuid, p_date date, p_type text, p_description text, p_amount numeric,
  p_method text, p_bank_account_id uuid, p_cash_location_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_co uuid; v_name text; v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  perform public.assert_same_company((select company_id from public.partners where id = p_partner_id));
  if p_bank_account_id  is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  if p_cash_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_cash_location_id)); end if;

  if p_type not in ('DRAWING', 'CONTRIBUTION') then
    raise exception 'A partner payment is a drawing or a contribution.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount above zero.';
  end if;
  if p_method in ('BANK_TRANSFER', 'CHEQUE') and p_bank_account_id is null then
    raise exception 'Choose the bank account.';
  end if;
  if p_method = 'CASH' and p_cash_location_id is null then
    raise exception 'Choose who paid (cash custodian).';
  end if;

  select company_id, name into v_co, v_name from public.partners where id = p_partner_id;
  if v_co is null then raise exception 'Partner not found.'; end if;

  insert into public.partner_account_entries
    (company_id, partner_id, date, type, description, amount, payment_method,
     bank_account_id, cash_location_id, created_by)
  values
    (v_co, p_partner_id, p_date, p_type, nullif(trim(coalesce(p_description, '')), ''), p_amount, p_method,
     case when p_method in ('BANK_TRANSFER', 'CHEQUE') then p_bank_account_id end,
     case when p_method = 'CASH' then p_cash_location_id end,
     auth.uid())
  returning id into v_id;

  if p_method in ('BANK_TRANSFER', 'CHEQUE') then
    perform public.apply_money_delta(
      v_co, 'Bank', p_bank_account_id,
      case when p_type = 'DRAWING' then -p_amount else p_amount end,
      'partner_entry',
      v_name || ' — ' || lower(p_type) || coalesce(' — ' || nullif(trim(coalesce(p_description, '')), ''), ''),
      v_id::text);
  end if;

  return v_id;
end;
$function$;

-- ── delete_partner_entry (accounting.edit — DECIDED) ───────────────────────────
create or replace function public.delete_partner_entry(p_entry_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare e record; v_name text; v_n int;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  perform public.assert_same_company((select company_id from public.partner_account_entries where id = p_entry_id));
  select * into e from public.partner_account_entries where id = p_entry_id;
  if not found then raise exception 'Entry not found.'; end if;
  if coalesce(e.is_locked, false) then raise exception 'This entry is locked and cannot be deleted.'; end if;

  if e.payment_method in ('BANK_TRANSFER', 'CHEQUE') and e.bank_account_id is not null
     and e.type in ('DRAWING', 'CONTRIBUTION') then
    select name into v_name from public.partners where id = e.partner_id;
    perform public.apply_money_delta(
      e.company_id, 'Bank', e.bank_account_id,
      case when e.type = 'DRAWING' then e.amount else -e.amount end,
      'partner_entry',
      'Deleted: ' || coalesce(v_name, 'partner') || ' — ' || lower(e.type),
      e.id::text);
  end if;

  delete from public.partner_account_entries where id = p_entry_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'The entry could not be deleted. Nothing has been changed.' using errcode = '42501';
  end if;
end;
$function$;

-- ── set_cash_opening_balance (accounting.edit) ─────────────────────────────────
create or replace function public.set_cash_opening_balance(p_amount numeric)
 returns numeric
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_company uuid := public.current_company_id();
  v_existing numeric;
  v_balance  numeric;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  if v_company is null then
    raise exception
      'No company is selected, so there is no cash balance to open. Pick a company with the "Viewing as" selector first.'
      using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'An opening cash balance must be zero or more.' using errcode = 'P0001';
  end if;

  select cash_delta into v_existing
    from public.bank_transactions
   where company_id = v_company and kind = 'opening' and bank_account_id is null
   limit 1;
  if found then
    raise exception
      'The opening cash balance is already set, at PKR %. It is recorded once and cannot be set again. Nothing has been recorded.', v_existing
      using errcode = '23505',
            hint = 'Cash that arrived after the opening is recorded as a deposit or a receipt, not as another opening.';
  end if;

  insert into public.treasury (company_id, cash_balance)
  values (v_company, 0)
  on conflict (company_id) do nothing;

  if p_amount > 0 then
    perform public.apply_money_delta(
      v_company, 'Cash', null, p_amount, 'opening', 'Opening cash balance', null);
  else
    insert into public.bank_transactions
      (company_id, bank_account_id, kind, amount, cash_delta, account_delta, description)
    values (v_company, null, 'opening', 0, 0, 0, 'Opening cash balance');
  end if;

  select cash_balance into v_balance from public.treasury where company_id = v_company;
  return v_balance;
end;
$function$;

-- ── verification ───────────────────────────────────────────────────────────────
do $mig$
declare v_bad text;
begin
  select string_agg(proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('record_invoice_payment','amend_invoice_payment','delete_invoice_payment','record_bank_transfer',
     'record_inventory_purchase','record_partner_entry','delete_partner_entry','set_cash_opening_balance')
    and not p.prosecdef;
  if v_bad is not null then
    raise exception '0454 FAILED: these should be SECURITY DEFINER but are not: %', v_bad;
  end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0454 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
