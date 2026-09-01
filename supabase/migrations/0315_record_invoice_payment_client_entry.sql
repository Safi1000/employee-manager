-- 0315 — record_invoice_payment() gains a client-only entry point and records
-- client_id, so the receivables screen can stop having its own implementation.
--
-- WHY
--
-- Accounting.tsx (Banks & Ledgers -> Client Receivables) — the screen operators
-- actually use — did not call this function. It inserted into invoice_payments
-- directly, in two places, and updated invoices.amount_received by hand. That is
-- a SECOND IMPLEMENTATION of payment application, and it skipped:
--
--   * the oldest-first waterfall across the client's open invoices
--   * the pro-rata withholding split per settlement
--   * assert_same_company
--   * the composed bank_transactions row
--
-- Bringing it across needs two things this function did not have.
--
-- 1. A CLIENT-ONLY ENTRY POINT. The screen supports a payment with no invoice
--    ("standalone"), and this function keyed everything off p_invoice_id. The
--    waterfall itself was never invoice-keyed — it always settled the CLIENT's
--    open invoices oldest first — so the only thing missing was a way to name
--    the client directly. p_invoice_id stays supported and stays the way to
--    TARGET a named invoice, which operators rely on.
--
-- 2. client_id ON THE ROW. This function never wrote it; the direct inserts
--    did. Moving the screen across without this would have silently dropped the
--    client from every receipt, and CashCustody.tsx reads
--    invoice_payments -> clients(name) to label cash movements. The rows would
--    have rendered with no client.
--
--    That is worth stating plainly: replacing a parallel implementation is not
--    only about what the survivor does, but about what the one being deleted
--    did that the survivor does not.
--
-- NO REGION FILTER, AND WHY THAT IS SAFE. The waterfall can settle an invoice
-- the operator is not looking at. Confirmed with Shayan: NO CLIENT SPANS MORE
-- THAN ONE REGION, so every invoice it can reach belongs to the same region as
-- the one in front of them. Recorded here so the next reader does not re-derive
-- it — and so that if a client ever does span regions, this is the comment that
-- has to change.
--
-- Region scoping in the screens is a separate, per-screen frontend layer and is
-- untouched: two layers, different boundaries.

drop function if exists public.record_invoice_payment(uuid, numeric, date, text, uuid, text, numeric, uuid);

create or replace function public.record_invoice_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_payment_mode text,
  p_bank_account_id uuid,
  p_notes text,
  p_withholding numeric default null,
  p_custodian_location_id uuid default null,
  p_client_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company        uuid;
  v_client         uuid;
  v_caller_company uuid := public.current_company_id();
  v_total          numeric := 0;
  v_wht_total      numeric := 0;
  v_wht            numeric;
  v_rate           numeric;
  v_first_pay      uuid;
  v_pay_id         uuid;
  v_touched        int := 0;
  v_client_name    text;
  v_desc           text;
  v_wht_share      numeric;
  rec              record;
begin
  if p_invoice_id is null and p_client_id is null then
    raise exception 'Name an invoice or a client for this receipt'
      using errcode = '23514',
            hint = 'Pass p_invoice_id to target one invoice, or p_client_id to settle the client''s open invoices oldest first.';
  end if;

  -- tenant guard [resolved]: owning company looked up from p_invoice_id via public.invoices (0242b),
  -- or from p_client_id via public.clients when this is a client-only receipt (0315).
  if p_invoice_id is not null then
    perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id));
  else
    perform public.assert_same_company((select company_id from public.clients where id = p_client_id));
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;
  if p_payment_mode not in ('Cash', 'Bank') then
    raise exception 'Invalid payment mode';
  end if;
  if p_payment_date is null then
    raise exception 'Payment date is required';
  end if;

  if p_invoice_id is not null then
    select company_id, client_id into v_company, v_client
    from public.invoices where id = p_invoice_id;
    if v_company is null then
      raise exception 'Invoice not found';
    end if;
  else
    select company_id, id into v_company, v_client
    from public.clients where id = p_client_id;
    if v_company is null then
      raise exception 'Client not found';
    end if;
  end if;

  if v_caller_company is distinct from v_company then
    raise exception 'Not authorised for this company';
  end if;

  -- 0281. NULL means "use the client's agreed rate"; 0 means "none".
  if p_withholding is null then
    select coalesce(c.withholding_tax_rate, 0) into v_rate
      from public.clients c where c.id = v_client;
    v_wht := round(p_amount * coalesce(v_rate, 0) / 100, 2);
  else
    v_wht := p_withholding;
  end if;
  if v_wht < 0 then
    raise exception 'Withholding amount cannot be negative';
  end if;

  if p_payment_mode = 'Bank' then
    if p_bank_account_id is null then
      raise exception 'Select a bank account for Bank payments';
    end if;
    perform 1 from public.bank_accounts where id = p_bank_account_id and company_id = v_company;
    if not found then
      raise exception 'Bank account not found for this company';
    end if;
  else
    -- 0281 / 0268. Cash reaches a person, and the ledger posts to that person's
    -- account. Without a custodian the posting lands on the undifferentiated
    -- cash control and the money is attributable to nobody.
    if p_custodian_location_id is null then
      raise exception 'Select the custodian who received the cash'
        using errcode = '23514',
              hint = 'A cash receipt must name a cash location so the ledger can attribute it.';
    end if;
    perform 1 from public.cash_locations
     where id = p_custodian_location_id and company_id = v_company;
    if not found then
      raise exception 'Cash location not found for this company';
    end if;
  end if;

  -- A1: outstanding is GROSS. WHT no longer reduces it here.
  -- 0314: invoices.outstanding is generated as invoice_amount - amount_received.
  for rec in
    with u as (
      select i.id,
             i.outstanding,
             row_number() over (order by i.invoice_date, i.invoice_number) as rn,
             count(*) over () as n,
             coalesce(sum(i.outstanding)
                        over (order by i.invoice_date, i.invoice_number
                              rows between unbounded preceding and 1 preceding), 0) as cum_before
      from public.invoices i
      where i.client_id = v_client
        and i.outstanding > 0.0001
    )
    select id,
           case when rn = n then (p_amount + v_wht - cum_before)
                else greatest(0, least(outstanding, p_amount + v_wht - cum_before)) end as settle
    from u
    order by rn
  loop
    continue when rec.settle <= 0.0001;
    -- Split each settlement into its cash and WHT components, pro rata.
    v_wht_share := case when (p_amount + v_wht) > 0
                        then round(rec.settle * v_wht / (p_amount + v_wht), 2) else 0 end;

    insert into public.invoice_payments
      (company_id, invoice_id, client_id, amount, withholding_amount, payment_date,
       payment_mode, bank_account_id, custodian_location_id, notes)
    values
      (v_company, rec.id, v_client, rec.settle - v_wht_share, v_wht_share, p_payment_date,
       p_payment_mode, p_bank_account_id, p_custodian_location_id, nullif(btrim(p_notes), ''))
    returning id into v_pay_id;

    if v_first_pay is null then v_first_pay := v_pay_id; end if;

    -- The receivable is cleared by cash AND withholding together.
    update public.invoices
      set amount_received = amount_received + rec.settle, updated_at = now()
      where id = rec.id;

    v_total     := v_total + (rec.settle - v_wht_share);
    v_wht_total := v_wht_total + v_wht_share;
    v_touched   := v_touched + 1;
  end loop;

  if v_touched = 0 then
    -- Nothing open to settle. The money still arrived, so it is recorded against
    -- the invoice if one was named and against the client otherwise.
    insert into public.invoice_payments
      (company_id, invoice_id, client_id, amount, withholding_amount, payment_date,
       payment_mode, bank_account_id, custodian_location_id, notes)
    values
      (v_company, p_invoice_id, v_client, p_amount, v_wht, p_payment_date,
       p_payment_mode, p_bank_account_id, p_custodian_location_id, nullif(btrim(p_notes), ''))
    returning id into v_pay_id;
    v_first_pay := v_pay_id;
    if p_invoice_id is not null then
      update public.invoices
        set amount_received = amount_received + p_amount + v_wht, updated_at = now()
        where id = p_invoice_id;
    end if;
    v_total     := p_amount;
    v_wht_total := v_wht;
    v_touched   := 1;
  end if;

  if p_payment_mode = 'Bank' then
    update public.bank_accounts set balance = balance + v_total, updated_at = now()
      where id = p_bank_account_id;
  else
    update public.treasury set cash_balance = cash_balance + v_total, updated_at = now()
      where company_id = v_company;
    if not found then
      insert into public.treasury (company_id, cash_balance) values (v_company, v_total);
    end if;
  end if;

  select name into v_client_name from public.clients where id = v_client;
  v_desc := 'Payment received (' || lower(p_payment_mode) || ') · '
            || coalesce(v_client_name, 'Client') || ' · '
            || v_touched || ' invoice' || case when v_touched = 1 then '' else 's' end
            || ' (oldest first)'
            || case when v_wht_total > 0 then ' · WHT ' || v_wht_total else '' end;

  insert into public.bank_transactions
    (company_id, bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
  values
    (v_company, p_bank_account_id, 'receipt', v_total,
     case when p_payment_mode = 'Cash' then v_total else 0 end,
     case when p_payment_mode = 'Bank' then v_total else 0 end,
     v_desc, v_first_pay::text);

  return jsonb_build_object(
    'total_applied', v_total,
    'withholding_applied', v_wht_total,
    'invoices_touched', v_touched);
end;
$function$;

comment on function public.record_invoice_payment(uuid, numeric, date, text, uuid, text, numeric, uuid, uuid) is
  'Records a client receipt across open invoices oldest first. Name an invoice (p_invoice_id) to target one, or a client (p_client_id) for a receipt with no invoice — one of the two is required. p_custodian_location_id is REQUIRED for Cash (0268/0281). p_withholding: null = use the client''s withholding_tax_rate, 0 = none, a number = that amount. Writes client_id on every payment row (0315).';

-- ---------------------------------------------------------------------------
-- PROOFS. Four, in both directions, all rolled back.
-- ---------------------------------------------------------------------------

do $$
declare
  v_co     uuid := (select id from public.companies where name = 'SANDBOX TESTING ORG');
  v_uid    uuid; v_inv uuid; v_cust uuid; v_cli uuid;
  v_res    jsonb; v_msg text; v_cid uuid;
begin
  if v_co is null then
    raise notice '0315: no sandbox company; proofs skipped';
    return;
  end if;

  select p.id into v_uid from public.profiles p
   where coalesce(p.view_as_company, p.company_id) = v_co limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  select id, client_id into v_inv, v_cli from public.invoices
   where company_id = v_co and outstanding > 1 limit 1;
  select id into v_cust from public.cash_locations
   where company_id = v_co and custodian_employee_id is not null and is_active is not false
   order by name limit 1;

  if v_inv is null or v_cust is null then
    raise notice '0315: no open invoice or custodian to prove against';
    return;
  end if;

  -- (a) REFUSES a receipt naming neither an invoice nor a client.
  v_msg := null;
  begin
    perform public.record_invoice_payment(null, 100, current_date, 'Cash', null, '0315', 0, v_cust, null);
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is distinct from 'Name an invoice or a client for this receipt' then
    raise exception '0315: a receipt naming nothing was not refused correctly — got %', coalesce(v_msg, '(accepted)');
  end if;

  -- (b) STILL refuses cash with no custodian, by the 0281 message. Proving the
  --     new argument did not disturb the old guard, not merely that it raised.
  v_msg := null;
  begin
    perform public.record_invoice_payment(v_inv, 100, current_date, 'Cash', null, '0315', 0, null, null);
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is distinct from 'Select the custodian who received the cash' then
    raise exception '0315: the custodian guard changed message or stopped firing — got %', coalesce(v_msg, '(accepted)');
  end if;

  -- (c) ACCEPTS the client-only entry point, and writes client_id.
  begin
    v_res := public.record_invoice_payment(null, 100, current_date, 'Cash', null, '0315 client entry', 0, v_cust, v_cli);
    select client_id into v_cid from public.invoice_payments
     where notes = '0315 client entry' order by created_at desc limit 1;
    raise exception 'ROLLBACK_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROOF' then
        raise exception '0315: the client-only entry point was refused — % %', sqlstate, sqlerrm;
      end if;
  end;

  if coalesce((v_res->>'invoices_touched')::int, 0) = 0 then
    raise exception '0315: the client-only receipt settled nothing: %', v_res;
  end if;
  if v_cid is distinct from v_cli then
    raise exception '0315: client_id was not written on the payment row — got %, expected %', v_cid, v_cli;
  end if;

  raise notice '0315: refuses an unnamed receipt, keeps the custodian guard, accepts a client-only receipt (%) and stamps client_id', v_res;
end $$;

do $$
declare v_n int;
begin
  select count(*) into v_n from public.invoice_payments where notes like '0315%';
  if v_n <> 0 then
    raise exception '0315: % proof row(s) survived the rollback', v_n;
  end if;
end $$;
