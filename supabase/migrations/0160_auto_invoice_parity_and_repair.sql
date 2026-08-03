-- 0160: auto invoices must be indistinguishable from manual ones apart from
-- having been issued by the job. Two gaps remained after 0157 fixed company_id:
--
--  1. contract_id was never set, so an auto invoice was not tied to the contract
--     it bills for the way a hand-entered one is.
--  2. withholding_tax was hardcoded to 0, ignoring clients.auto_invoice_withholding
--     — the column that exists precisely to carry it.
--
-- Also repairs the 8 rows already issued under the wrong company (and their
-- journal entries), which is why they appeared in neither company: RLS placed
-- them in the caller's company while their client lived in another, so every
-- per-client aggregation — receivables, client statements, invoice history —
-- dropped them.

update public.journal_entries j
set company_id = cl.company_id
from public.invoices i
join public.clients cl on cl.id = i.client_id
where j.source_id = i.id
  and j.company_id is distinct from cl.company_id;

update public.invoices i
set company_id = cl.company_id, updated_at = now()
from public.clients cl
where cl.id = i.client_id
  and i.company_id is distinct from cl.company_id;

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
  v_contract uuid;
  issued int := 0;
begin
  for rec in
    select c.id as client_id, c.company_id, c.auto_invoice_amount, c.advance_payment,
           c.auto_invoice_withholding, c.contract_start, c.contract_end
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

    -- The contract in force for the billed period. Left null when the client has
    -- none, or when more than one could apply — never guessed.
    v_contract := null;
    if (select count(*) from public.contracts k
         where k.client_id = rec.client_id
           and k.status = 'active'
           and k.start_date <= period_start
           and (k.is_infinite or k.end_date is null or k.end_date >= period_start)) = 1 then
      select k.id into v_contract
        from public.contracts k
       where k.client_id = rec.client_id
         and k.status = 'active'
         and k.start_date <= period_start
         and (k.is_infinite or k.end_date is null or k.end_date >= period_start);
    end if;

    inv_number := public.next_invoice_number(rec.company_id, period_start);

    insert into public.invoices (
      company_id, client_id, contract_id, invoice_number, invoice_date, invoice_amount,
      withholding_tax, amount_received, status, notes
    ) values (
      rec.company_id, rec.client_id, v_contract, inv_number, period_start, rec.auto_invoice_amount,
      coalesce(rec.auto_invoice_withholding, 0), 0, 'Pending',
      'Auto-issued for ' || to_char(period_start, 'Mon YYYY')
    );
    issued := issued + 1;
  end loop;
  return issued;
end;
$$;

grant execute on function public.run_auto_invoices(date) to authenticated;
