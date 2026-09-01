-- HALF-LEVER — restore the 7-argument record_invoice_payment().
--
-- Written 2026-09-01, BEFORE the frontend release, for the same reason
-- EMERGENCY_LEVER.sql was: composing a rollback during an incident is how the
-- wrong thing gets typed.
--
-- WHY THIS IS ONLY HALF A LEVER
--
-- EMERGENCY_LEVER.sql is a whole one: one statement reverts assert_same_company
-- and 135 guards go inert. This is not that. The frontend release moves the
-- build and the schema together, and a build cannot be reverted by SQL.
--
--   Running this file alone does NOT restore service.
--
-- If the new build is live, it sends p_custodian_location_id, which the
-- restored 7-argument function does not accept — PostgREST answers PGRST202
-- and EVERY receipt fails, in both Bank and Cash mode. That is worse than the
-- state this file is meant to undo.
--
-- USE IT ONLY AS THE SECOND HALF OF A PAIR:
--
--   1. redeploy the previous frontend build      <- do this first
--   2. run this file                             <- then this
--
-- Either one alone leaves receipts broken. Both, in that order, return the
-- system to its pre-release state.
--
-- WHAT IT RESTORES
--
-- The pre-0281 body, taken from supabase/rollback/prod_secdef_functions_
-- 20260901.sql (the D0 capture, 257 functions, md5 28cbd4912d69b3cf96f5378bea-
-- 585dd1). Verified byte-identical to that capture by diff, the same way
-- EMERGENCY_LEVER.sql was verified against 0242c.
--
-- It does NOT drop the 8-argument function, so that rolling forward again is a
-- build deploy rather than another migration.
--
-- UNVERIFIED, AND THE ONE THING TO CHECK IF YOU EVER RUN THIS: that the two
-- overloads coexist without PostgREST returning PGRST203 (ambiguous) for a
-- 7-named-argument call. The expectation is that an exact name match beats a
-- defaulted one, but that was NOT measured on 2026-09-01 and is written here
-- as an expectation, not a fact (see TENANT_GUARD_REPORT.md 9.16). If it does
-- come back ambiguous, drop the 8-argument function as well:
--
--   drop function public.record_invoice_payment(
--     uuid, numeric, date, text, uuid, text, numeric, uuid);
--
-- MEASURED ON DEV BEFORE THE RELEASE, 2026-09-01 (see FRONTEND_RELEASE_PLAN.md
-- §2): with only the 8-argument function present, a 6- and a 7-named-argument
-- call BOTH bind via defaults. So the window this file undoes is Cash receipts
-- only, not all receipts. That is the measured fact this whole plan rests on.

-- ============================================================================
-- THE PRE-0281 BODY, extracted verbatim from the D0 capture at line 7622.
-- Not retyped. Do not edit it here; if it is wrong, the capture is wrong.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_invoice_payment(p_invoice_id uuid, p_amount numeric, p_payment_date date, p_payment_mode text, p_bank_account_id uuid, p_notes text, p_withholding numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company        uuid;
  v_client         uuid;
  v_caller_company uuid := public.current_company_id();
  v_total          numeric := 0;
  v_wht_total      numeric := 0;
  v_wht            numeric := coalesce(p_withholding, 0);
  v_first_pay      uuid;
  v_pay_id         uuid;
  v_touched        int := 0;
  v_client_name    text;
  v_desc           text;
  v_wht_share      numeric;
  rec              record;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;
  if p_payment_mode not in ('Cash', 'Bank') then
    raise exception 'Invalid payment mode';
  end if;
  if p_payment_date is null then
    raise exception 'Payment date is required';
  end if;
  if v_wht < 0 then
    raise exception 'Withholding amount cannot be negative';
  end if;

  select company_id, client_id into v_company, v_client
  from public.invoices where id = p_invoice_id;
  if v_company is null then
    raise exception 'Invoice not found';
  end if;
  if v_caller_company is distinct from v_company then
    raise exception 'Not authorised for this company';
  end if;

  if p_payment_mode = 'Bank' then
    if p_bank_account_id is null then
      raise exception 'Select a bank account for Bank payments';
    end if;
    perform 1 from public.bank_accounts where id = p_bank_account_id and company_id = v_company;
    if not found then
      raise exception 'Bank account not found for this company';
    end if;
  end if;

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
    v_wht_share := case when (p_amount + v_wht) > 0
                        then round(rec.settle * v_wht / (p_amount + v_wht), 2) else 0 end;

    insert into public.invoice_payments
      (company_id, invoice_id, amount, withholding_amount, payment_date,
       payment_mode, bank_account_id, notes)
    values
      (v_company, rec.id, rec.settle - v_wht_share, v_wht_share, p_payment_date,
       p_payment_mode, p_bank_account_id, nullif(btrim(p_notes), ''))
    returning id into v_pay_id;

    if v_first_pay is null then v_first_pay := v_pay_id; end if;

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
       payment_mode, bank_account_id, notes)
    values
      (v_company, p_invoice_id, p_amount, v_wht, p_payment_date,
       p_payment_mode, p_bank_account_id, nullif(btrim(p_notes), ''))
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
$function$
;
