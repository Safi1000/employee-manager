-- 0157: run_auto_invoices stamped every invoice with the CALLER's company.
--
-- The loop walks clients across every company (correct — it is a cron job), but
-- the INSERT omitted company_id and let fill_company_id stamp it from the
-- session. Run from the UI while viewing company A, invoices for company B's
-- clients were created carrying company A's id. They then sit in a company whose
-- client list does not contain their client, so every per-client aggregation —
-- P&L statements, client reports, receivables — drops them, and they show up
-- nowhere at all.
--
-- The client's own company is the only correct value, and it is already selected
-- into rec.company_id for the invoice number.
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
  issued int := 0;
begin
  for rec in
    select c.id as client_id, c.company_id, c.auto_invoice_amount, c.advance_payment,
           c.contract_start, c.contract_end
      from public.clients c
     where c.auto_invoice_enabled = true
       and coalesce(c.auto_invoice_amount, 0) > 0
       and c.company_id is not null
  loop
    if rec.advance_payment then
      period_start := date_trunc('month', p_run_date)::date;
    else
      period_start := (date_trunc('month', p_run_date) - interval '1 month')::date;
    end if;

    if rec.contract_start is not null and period_start < rec.contract_start then
      continue;
    end if;
    if rec.contract_end is not null and period_start > rec.contract_end then
      continue;
    end if;

    if exists (
      select 1 from public.invoices
       where client_id = rec.client_id
         and invoice_date = period_start
         and invoice_amount = rec.auto_invoice_amount
    ) then
      continue;
    end if;

    inv_number := public.next_invoice_number(rec.company_id, period_start);

    insert into public.invoices (
      company_id, client_id, invoice_number, invoice_date, invoice_amount,
      withholding_tax, amount_received, status, notes
    ) values (
      rec.company_id, rec.client_id, inv_number, period_start, rec.auto_invoice_amount,
      0, 0, 'Pending',
      'Auto-issued for ' || to_char(period_start, 'Mon YYYY')
    );
    issued := issued + 1;
  end loop;
  return issued;
end;
$$;

grant execute on function public.run_auto_invoices(date) to authenticated;
