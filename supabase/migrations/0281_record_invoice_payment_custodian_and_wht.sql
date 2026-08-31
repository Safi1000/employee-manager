-- 0281 — record_invoice_payment() names the custodian, and takes the client's
-- withholding rate as its default.
--
-- ============================================================================
-- PART 1 — A REGRESSION 0268 INTRODUCED, FOUND BY PROBING RATHER THAN BY FAILING
-- ============================================================================
--
-- 0268 added:
--
--   invoice_payments_cash_names_a_location
--     check (payment_mode <> 'Cash' or custodian_location_id is not null)
--
-- `record_invoice_payment()` inserts its `invoice_payments` rows WITHOUT a
-- custodian. So since 0268, **every cash receipt through the application has
-- been refused**:
--
--   CASH RECEIPT REFUSED: 23514 new row for relation "invoice_payments"
--   violates check constraint "invoice_payments_cash_names_a_location"
--
-- This is the mirror image of the defect 0268 was written to stop, and it is
-- instructive: 0268 proved its constraint could REFUSE a bad row, and never
-- proved the good path still worked. **A constraint needs both proofs.**
-- Demonstrating that a rule rejects what it should is only half of it; the other
-- half is that everything it should accept still passes, and the only way to
-- know is to exercise the real call path.
--
-- Recorded as a standing rule: A CONSTRAINT PROVED ONLY BY WHAT IT REFUSES IS
-- HALF PROVED.
--
-- ============================================================================
-- PART 2 — WIRING clients.withholding_tax_rate
-- ============================================================================
--
-- The direction-2 sweep found `clients.withholding_tax_rate` written by
-- Clients.tsx, displayed back, and read by no function or view. Meanwhile
-- `p_withholding` already existed on this RPC and the frontend never passed it,
-- so A1's per-receipt withholding was unreachable from the application: the
-- rate was maintained and drove nothing, and the field it should drive was
-- never filled.
--
-- NULL and ZERO now mean different things, deliberately:
--
--   p_withholding => null   use the client's withholding_tax_rate
--   p_withholding => 0      this receipt has no withholding
--   p_withholding => 1234   this exact amount
--
-- A caller that means "none" must say 0. Silence means "apply the agreed rate",
-- which is the only reading under which storing a rate per client does anything
-- at all. The frontend passes an explicit value from a prefilled, editable
-- field, so the derivation is a safety net rather than the normal path.

drop function if exists public.record_invoice_payment(uuid, numeric, date, text, uuid, text, numeric);

create or replace function public.record_invoice_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_payment_mode text,
  p_bank_account_id uuid,
  p_notes text,
  p_withholding numeric default null,
  p_custodian_location_id uuid default null)
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
  -- tenant guard [resolved]: owning company looked up from p_invoice_id via public.invoices (0242b)
  if p_invoice_id is not null then perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id)); end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;
  if p_payment_mode not in ('Cash', 'Bank') then
    raise exception 'Invalid payment mode';
  end if;
  if p_payment_date is null then
    raise exception 'Payment date is required';
  end if;

  select company_id, client_id into v_company, v_client
  from public.invoices where id = p_invoice_id;
  if v_company is null then
    raise exception 'Invoice not found';
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
  for rec in
    with u as (
      select i.id,
             (i.invoice_amount - i.amount_received) as outstanding,
             row_number() over (order by i.invoice_date, i.invoice_number) as rn,
             count(*) over () as n,
             coalesce(sum(i.invoice_amount - i.amount_received)
                        over (order by i.invoice_date, i.invoice_number
                              rows between unbounded preceding and 1 preceding), 0) as cum_before
      from public.invoices i
      where i.client_id = v_client
        and (i.invoice_amount - i.amount_received) > 0.0001
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
      (company_id, invoice_id, amount, withholding_amount, payment_date,
       payment_mode, bank_account_id, custodian_location_id, notes)
    values
      (v_company, rec.id, rec.settle - v_wht_share, v_wht_share, p_payment_date,
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
    insert into public.invoice_payments
      (company_id, invoice_id, amount, withholding_amount, payment_date,
       payment_mode, bank_account_id, custodian_location_id, notes)
    values
      (v_company, p_invoice_id, p_amount, v_wht, p_payment_date,
       p_payment_mode, p_bank_account_id, p_custodian_location_id, nullif(btrim(p_notes), ''))
    returning id into v_pay_id;
    v_first_pay := v_pay_id;
    update public.invoices
      set amount_received = amount_received + p_amount + v_wht, updated_at = now()
      where id = p_invoice_id;
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

comment on function public.record_invoice_payment(uuid, numeric, date, text, uuid, text, numeric, uuid) is
  'Records a client receipt across open invoices oldest first. p_custodian_location_id is REQUIRED for Cash (0268/0281). p_withholding: null = use the client''s withholding_tax_rate, 0 = none, a number = that amount.';

-- ---------------------------------------------------------------------------
-- BOTH proofs, which is the point of this migration.
-- ---------------------------------------------------------------------------

do $$
declare
  v_co   uuid := (select id from public.companies where name = 'SANDBOX TESTING ORG');
  v_uid  uuid; v_inv uuid; v_cust uuid; v_res jsonb; v_refused boolean := false;
begin
  if v_co is null then
    raise notice '0281: no sandbox company; proofs skipped';
    return;
  end if;

  select p.id into v_uid from public.profiles p
   where coalesce(p.view_as_company, p.company_id) = v_co limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  select id into v_inv from public.invoices
   where company_id = v_co and (invoice_amount - amount_received) > 1 limit 1;
  select id into v_cust from public.cash_locations
   where company_id = v_co and custodian_employee_id is not null and is_active is not false
   order by name limit 1;

  if v_inv is null or v_cust is null then
    raise notice '0281: no open invoice or custodian to prove against';
    return;
  end if;

  -- (a) REFUSES what it should: cash with no custodian.
  begin
    perform public.record_invoice_payment(v_inv, 100, current_date, 'Cash', null, '0281 proof', 0, null);
  exception when others then v_refused := true;
  end;
  if not v_refused then
    raise exception '0281: a custodian-less cash receipt was ACCEPTED';
  end if;

  -- (b) ACCEPTS what it should: the same receipt, custodian named. This is the
  -- half 0268 did not prove, and the half that was broken.
  --
  -- Run inside a subtransaction and rolled back by a deliberate raise. The
  -- receipt spreads oldest-first across every open invoice for the client, so
  -- unwinding it by hand would mean reproducing the waterfall — a model of the
  -- RPC rather than the RPC, which is the exact mistake the fixture audit
  -- found. A savepoint undoes it precisely. `v_res` is plpgsql memory and
  -- survives the rollback; the database changes do not.
  begin
    v_res := public.record_invoice_payment(v_inv, 100, current_date, 'Cash', null, '0281 proof', 0, v_cust);
    raise exception 'ROLLBACK_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROOF' then
        raise exception '0281: the GOOD path was refused — % %', sqlstate, sqlerrm;
      end if;
  end;

  if coalesce((v_res->>'invoices_touched')::int, 0) = 0 then
    raise exception '0281: the good path returned no settlement: %', v_res;
  end if;
  raise notice '0281: cash receipt with a custodian ACCEPTED (rolled back) — %', v_res;
end $$;