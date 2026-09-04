-- 0383 — amend and delete an invoice payment in one transaction, and put the
--        WITHHOLDING back as well as the cash.
--
-- ===========================================================================
-- THE LAST TWO CROSS-KEY FLOWS — AND THERE ARE TWO, NOT ONE
-- ===========================================================================
--
-- §4 listed handleEditPayment (Invoices.tsx:876). Reading it showed
-- handleDeletePayment sharing the same helper, reverseOldPaymentEffects, in
-- exactly the way reverseExistingPayment turned out to serve both expense edit
-- and expense delete. Same correction, same reason: the list counted helpers,
-- not the callers that reach them.
--
-- Both did three unprotected round trips — reverse the money, write the
-- payment row, re-total the invoice — with invoices.edit needed for two of
-- them and accounting.edit for the other.
--
-- ===========================================================================
-- THE DEFECT THIS FOUND, WHICH IS NOT A PERMISSION ONE
-- ===========================================================================
--
-- record_invoice_payment credits the receivable with CASH AND WITHHOLDING
-- TOGETHER: `amount_received = amount_received + settle`, where settle is
-- amount + withholding_amount. A1 — outstanding is gross, and withholding
-- clears the receivable just as cash does.
--
-- Both frontend flows undid it with the CASH ONLY:
--
--   handleEditPayment:   newReceived = amount_received - old.amount + new
--   handleDeletePayment: newReceived = amount_received - old.amount
--
-- So every edit or delete of a payment carrying withholding left the invoice
-- over-credited by exactly the withholding, and the invoice looked more paid
-- than it was — silently, and permanently, because nothing recomputes
-- amount_received from the payment rows.
--
-- On GGS today that is not yet money: no invoice_payments row carries a
-- non-zero withholding_amount, so no invoice is currently wrong. It is a live
-- defect waiting for the first client with a WHT rate, which is why it is
-- fixed here rather than logged.
--
-- These functions move `amount + withholding_amount` in both directions, read
-- off the stored row. Withholding is deliberately NOT editable: it is split
-- pro rata across invoices by record_invoice_payment and cannot be
-- re-apportioned from a single row, which is what the edit form already says.

create or replace function public.amend_invoice_payment(
  p_payment_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_payment_mode text,
  p_bank_account_id uuid default null,
  p_custodian_location_id uuid default null,
  p_notes text default null
) returns void
language plpgsql
set search_path to 'public'
as $function$
declare
  v_n     int;
  p       record;
  v_desc  text;
  v_room  numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment needs an amount greater than zero.' using errcode = 'P0001';
  end if;
  if p_payment_mode not in ('Cash', 'Bank') then
    raise exception 'A payment is received in Cash or Bank, not %.', p_payment_mode using errcode = 'P0001';
  end if;
  if p_payment_mode = 'Bank' and p_bank_account_id is null then
    raise exception 'A bank payment needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  -- 0268's rule, restated where it can be enforced: cash reaches a person, and
  -- the ledger posts to that person's account.
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

  -- 1. Take the old receipt back out — cash AND withholding.
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

  -- 2. The invoice must be able to absorb the new figure. Checked AFTER the
  --    reversal, because the room this payment itself occupied is room the new
  --    amount is allowed to reuse — the same reasoning the screen's
  --    receivedWithoutThis expressed, done where it cannot be raced.
  if p.invoice_id is not null then
    select i.invoice_amount - i.amount_received into v_room
      from public.invoices i where i.id = p.invoice_id;
    if p_amount + coalesce(p.withholding_amount, 0) > v_room + 0.0001 then
      raise exception
        'That amount exceeds what is left on the invoice (PKR %). Nothing has been recorded.', round(v_room, 2)
        using errcode = '23514';
    end if;
  end if;

  -- 3. The row.
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

  -- 4. Put the new receipt in — cash AND the unchanged withholding.
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

grant execute on function public.amend_invoice_payment(uuid, numeric, date, text, uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_invoice_payment — the money back, the receivable back, the row gone.
-- ---------------------------------------------------------------------------
create or replace function public.delete_invoice_payment(p_payment_id uuid)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare v_n int; p record; v_desc text;
begin
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

grant execute on function public.delete_invoice_payment(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- PROVE IT — and prove the WITHHOLDING half specifically, because that is the
-- half both frontend flows got wrong and no existing row would have shown it.
--
-- A payment carrying a withholding component is amended, then deleted.
-- amount_received must come back to exactly where it started. Undoing the cash
-- alone leaves it high by the withholding — which is what this asserts against.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_uid   uuid;
  v_inv   uuid;
  v_cli   uuid;
  v_loc   uuid;
  v_pay   uuid;
  v_recv0 numeric; v_recv1 numeric;
  v_cash0 numeric; v_cash1 numeric;
begin
  select id into v_co from public.companies order by created_at limit 1;
  select id into v_uid from public.profiles where company_id = v_co limit 1;
  select id into v_loc from public.cash_locations where company_id = v_co limit 1;
  select id into v_cli from public.clients where company_id = v_co limit 1;
  if v_co is null or v_uid is null or v_loc is null or v_cli is null then
    raise exception '0383 FAILED: no company / profile / cash location / client to probe against.';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);

  select cash_balance into v_cash0 from public.treasury where company_id = v_co;
  if v_cash0 is null then raise exception '0383 FAILED: no treasury row to measure against.'; end if;

  -- PRODUCTION HOLDS ZERO INVOICES, so the probe makes its own rather than
  -- skipping the arm. A skipped arm is a test that reports success without
  -- having run, which is the thing supabase/tests exists to forbid. This whole
  -- block rolls back, so the invoice does not survive it.
  insert into public.invoices
    (company_id, client_id, invoice_number, invoice_date, invoice_amount, amount_received)
  values (v_co, v_cli, 'PROBE-0383', current_date, 10000, 0)
  returning id into v_inv;
  v_recv0 := 0;

  -- The starting state is BUILT here rather than taken from
  -- record_invoice_payment, deliberately: that function settles the CLIENT's
  -- oldest open invoices first, so it would not reliably land on the invoice
  -- this probe is measuring. What it produces for a single-invoice settlement
  -- is reproduced exactly — 400 cash + 100 withholding = 500 off the
  -- receivable — so the amend and delete under test see the same row they
  -- would see in production.
  insert into public.invoice_payments
    (company_id, invoice_id, client_id, amount, withholding_amount, payment_date,
     payment_mode, custodian_location_id, notes)
  values (v_co, v_inv, v_cli, 400, 100, current_date, 'Cash', v_loc, 'PROBE 0383')
  returning id into v_pay;
  update public.invoices set amount_received = amount_received + 500 where id = v_inv;
  perform public.apply_money_delta(v_co, 'Cash', null, 400, 'receipt', 'PROBE 0383', v_pay::text);

  select amount_received into v_recv1 from public.invoices where id = v_inv;
  if v_recv1 <> v_recv0 + 500 then
    raise exception '0383 FAILED: the probe could not establish its starting state (% -> %).', v_recv0, v_recv1;
  end if;

  -- Amend the cash half. The withholding rides along untouched.
  perform public.amend_invoice_payment(v_pay, 250, current_date, 'Cash', null, v_loc, 'PROBE 0383 amended');
  select amount_received into v_recv1 from public.invoices where id = v_inv;
  select cash_balance into v_cash1 from public.treasury where company_id = v_co;
  if v_recv1 <> v_recv0 + 350 then
    raise exception
      '0383 FAILED: after amending 400 -> 250, amount_received is % and should be % (250 cash + 100 withholding). The withholding was not carried through the reversal.',
      v_recv1, v_recv0 + 350;
  end if;
  if v_cash1 <> v_cash0 + 250 then
    raise exception '0383 FAILED: after amending, cash is % and should be %.', v_cash1, v_cash0 + 250;
  end if;

  perform public.delete_invoice_payment(v_pay);
  select amount_received into v_recv1 from public.invoices where id = v_inv;
  select cash_balance into v_cash1 from public.treasury where company_id = v_co;
  if v_recv1 <> v_recv0 then
    raise exception
      '0383 FAILED: after delete, amount_received is % and should be back at %. It is high by exactly the withholding if the delete undid the cash alone.',
      v_recv1, v_recv0;
  end if;
  if v_cash1 <> v_cash0 then
    raise exception '0383 FAILED: after delete, cash is % and should be back at %.', v_cash1, v_cash0;
  end if;

  raise exception
    'ROLLBACK_PROBE 0383 OK: amount_received returns to % and cash to %, with the withholding of 100 carried through both the amend and the delete.',
    v_recv0, v_cash0;
exception when others then
  if sqlerrm not like 'ROLLBACK_PROBE%' then raise; end if;
  raise notice '%', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0383 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
