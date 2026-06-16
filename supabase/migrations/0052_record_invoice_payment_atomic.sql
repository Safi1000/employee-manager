-- Prevent orphaned invoice payments.
--
-- Recording a payment used to run as separate, non-atomic browser steps:
--   insert invoice_payments  →  update invoices.amount_received  →  update
--   bank/treasury balance  →  insert bank_transactions.
-- If any step after the insert failed, the payment row (and the journal entry
-- its trigger posts) was left orphaned while the money never actually moved —
-- inflating the receivables ledger / trial balance.
--
-- This function performs the whole operation in ONE transaction, so a failure
-- rolls everything back and no orphan can be created. It also encapsulates the
-- oldest-first allocation (overpayment lands on the newest invoice, taking its
-- outstanding negative) and records the FULL amount into the chosen bank/cash.

create or replace function public.record_invoice_payment(
  p_invoice_id     uuid,
  p_amount         numeric,
  p_payment_date   date,
  p_payment_mode   text,
  p_bank_account_id uuid,
  p_notes          text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company        uuid;
  v_client         uuid;
  v_caller_company uuid := public.current_company_id();
  v_total          numeric := 0;
  v_first_pay      uuid;
  v_pay_id         uuid;
  v_touched        int := 0;
  v_client_name    text;
  v_desc           text;
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

  -- Oldest-first allocation. The newest unpaid invoice (rn = n) absorbs whatever
  -- is left after the rest, so an overpayment pushes it (and the client) negative.
  for rec in
    with u as (
      select i.id,
             (i.invoice_amount - coalesce(i.withholding_tax, 0) - i.amount_received) as outstanding,
             row_number() over (order by i.invoice_date, i.invoice_number) as rn,
             count(*) over () as n,
             coalesce(sum(i.invoice_amount - coalesce(i.withholding_tax, 0) - i.amount_received)
                        over (order by i.invoice_date, i.invoice_number
                              rows between unbounded preceding and 1 preceding), 0) as cum_before
      from public.invoices i
      where i.client_id = v_client
        and (i.invoice_amount - coalesce(i.withholding_tax, 0) - i.amount_received) > 0.0001
    )
    select id,
           case when rn = n then (p_amount - cum_before)
                else greatest(0, least(outstanding, p_amount - cum_before)) end as pay
    from u
    order by rn
  loop
    continue when rec.pay <= 0.0001;
    insert into public.invoice_payments
      (company_id, invoice_id, amount, payment_date, payment_mode, bank_account_id, notes)
    values
      (v_company, rec.id, rec.pay, p_payment_date, p_payment_mode, p_bank_account_id, nullif(btrim(p_notes), ''))
    returning id into v_pay_id;
    if v_first_pay is null then v_first_pay := v_pay_id; end if;
    update public.invoices
      set amount_received = amount_received + rec.pay, updated_at = now()
      where id = rec.id;
    v_total := v_total + rec.pay;
    v_touched := v_touched + 1;
  end loop;

  -- Nothing was outstanding: record the whole payment against the clicked
  -- invoice, taking it negative (a credit / advance).
  if v_touched = 0 then
    insert into public.invoice_payments
      (company_id, invoice_id, amount, payment_date, payment_mode, bank_account_id, notes)
    values
      (v_company, p_invoice_id, p_amount, p_payment_date, p_payment_mode, p_bank_account_id, nullif(btrim(p_notes), ''))
    returning id into v_pay_id;
    v_first_pay := v_pay_id;
    update public.invoices
      set amount_received = amount_received + p_amount, updated_at = now()
      where id = p_invoice_id;
    v_total := p_amount;
    v_touched := 1;
  end if;

  -- Move the full amount into the chosen bank/cash.
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
            || v_touched || ' invoice' || case when v_touched = 1 then '' else 's' end || ' (oldest first)';

  insert into public.bank_transactions
    (company_id, bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
  values
    (v_company, p_bank_account_id, 'receipt', v_total,
     case when p_payment_mode = 'Cash' then v_total else 0 end,
     case when p_payment_mode = 'Bank' then v_total else 0 end,
     v_desc, v_first_pay::text);

  return jsonb_build_object('total_applied', v_total, 'invoices_touched', v_touched);
end;
$$;

grant execute on function public.record_invoice_payment(uuid, numeric, date, text, uuid, text) to authenticated;
