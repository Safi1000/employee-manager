-- Item 3: auto-invoicing keeps the flat per-client amount logic, but is now
-- gated on the client having an ACTIVE contract covering the billing period
-- (instead of the clients.contract_start/end window), and applies the client's
-- withholding_tax_rate to the issued invoice. Advance/arrears timing and the
-- idempotency guard are preserved from the original 0018 implementation.
--
-- The inert contract-level `contracts.auto_invoice_enabled` checkbox is removed
-- from the UI separately; generation remains driven by clients.auto_invoice_enabled.

create or replace function public.run_auto_invoices(p_run_date date default current_date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  period_start date;
  inv_number text;
  wht numeric;
  issued int := 0;
begin
  for rec in
    select c.id as client_id, c.company_id, c.auto_invoice_amount, c.advance_payment,
           coalesce(c.withholding_tax_rate, 0) as wht_rate
      from public.clients c
     where c.auto_invoice_enabled = true
       and coalesce(c.auto_invoice_amount, 0) > 0
  loop
    -- Advance: invoice the CURRENT month at start of month.
    -- Arrears: invoice the PREVIOUS month at start of run month.
    if rec.advance_payment then
      period_start := date_trunc('month', p_run_date)::date;
    else
      period_start := (date_trunc('month', p_run_date) - interval '1 month')::date;
    end if;

    -- Gate: only issue when the client has an active contract covering the period.
    if not exists (
      select 1 from public.contracts ct
       where ct.client_id = rec.client_id
         and ct.status = 'active'
         and ct.start_date <= period_start
         and (ct.end_date is null or ct.end_date >= period_start)
    ) then
      continue;
    end if;

    -- Idempotency: don't double-issue for the same (client, period_start, amount).
    if exists (
      select 1 from public.invoices
       where client_id = rec.client_id
         and invoice_date = period_start
         and invoice_amount = rec.auto_invoice_amount
    ) then
      continue;
    end if;

    wht := round(rec.auto_invoice_amount * rec.wht_rate / 100.0, 2);
    inv_number := public.next_invoice_number(rec.company_id, period_start);

    insert into public.invoices (
      client_id, invoice_number, invoice_date, invoice_amount,
      withholding_tax, amount_received, status, notes
    ) values (
      rec.client_id, inv_number, period_start, rec.auto_invoice_amount,
      wht, 0, 'Pending',
      'Auto-issued for ' || to_char(period_start, 'Mon YYYY')
    );
    issued := issued + 1;
  end loop;
  return issued;
end;
$$;

grant execute on function public.run_auto_invoices(date) to authenticated;
