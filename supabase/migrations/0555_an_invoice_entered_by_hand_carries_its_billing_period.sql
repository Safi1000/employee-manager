-- 0555 — an invoice entered by hand carries its billing period
--
-- Reported 2026-10-26 (Shayan): posting the partnership run says three clients
-- have no invoice, "even tho they have been check again". The three are
-- Bank of AJK, Emaar DHA ISB and HMC Taxila for September; each HAS its
-- September invoice (GGS-26-BOAJK-10, GGS-26-EMR-09, GGS-26-HMC-09).
--
-- The cause: the "Add invoice" form on the Invoices page saves the invoice's
-- month (invoice_date, the 1st) but never its billing period — period_start
-- and period_end stay empty. partnership_uninvoiced_clients (0358, 0436) finds
-- a contract's invoice by the start of its billing period, so an invoice
-- without one is invisible to it, and the client reads as never billed. The
-- generator sets the period; the hand-entry path did not. Twelve September
-- invoices, created 7–21 October, carry no period.
--
-- So:
--   * fill_invoice_period (BEFORE INSERT, named to fire ahead of
--     trg_invoice_matches_period): a primary invoice that arrives without a
--     period takes it from its contract's billing period for the invoice's
--     month; an invoice with no contract takes the calendar month. Every path
--     is covered, not one form.
--   * The eleven that can be filled are filled — dates only, no amount. Each
--     re-posts its journal at the same month and amount (journal_on_invoice
--     reverses and posts on a period change), so revenue does not move.
--   * GGS-26-WSP-09 (Waheed Shahzad Plastic Works, Lahore) is left as it is: a
--     September invoice on a contract that starts 9 October has no September
--     billing period to take. It is named in the notice for Shayan to settle.
--
-- Asserted: no client is "never billed" for September any more; each filled
-- invoice keeps its amount and service month; its revenue in the ledger is
-- unchanged; a hand-entered invoice now arrives with its period.

create or replace function public.fill_invoice_period()
returns trigger
language plpgsql set search_path to 'public'
as $function$
declare v_m date; v_s date; v_e date; v_n int;
begin
  if new.period_start is not null or coalesce(new.invoice_kind::text, 'primary') <> 'primary' or new.invoice_date is null then
    return new;
  end if;
  v_m := date_trunc('month', new.invoice_date)::date;
  if new.contract_id is null then
    new.period_start := v_m;
    new.period_end := (v_m + interval '1 month - 1 day')::date;
    return new;
  end if;
  select count(*), min(p.period_start), min(p.period_end) into v_n, v_s, v_e
    from public.contract_periods(new.contract_id, 'billing', (v_m + interval '2 month')::date) p
   where p.service_month = v_m;
  if v_n = 1 then
    new.period_start := v_s;
    new.period_end := v_e;
  end if;
  -- No period, or more than one, in that month: left empty for a person to
  -- decide; the period checks name it.
  return new;
end $function$;
comment on function public.fill_invoice_period() is
  '0555. A primary invoice arriving without a billing period takes its contract''s period for the invoice month (or '
  'the calendar month with no contract), so a hand-entered invoice is never invisible to the uninvoiced-client check.';

drop trigger if exists trg_aab_invoices_fill_period on public.invoices;
create trigger trg_aab_invoices_fill_period before insert on public.invoices
  for each row execute function public.fill_invoice_period();

do $mig$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  r record; v_s date; v_e date; v_n int; v_rev_before numeric; v_rev_after numeric;
  v_filled int := 0;
begin
  for r in
    select i.id, i.invoice_number, i.contract_id, i.invoice_amount, i.service_month, date_trunc('month', i.invoice_date)::date m
      from public.invoices i
     where i.company_id = v_co and i.period_start is null and i.invoice_kind = 'primary'
  loop
    if r.contract_id is null then
      v_s := r.m; v_e := (r.m + interval '1 month - 1 day')::date; v_n := 1;
    else
      select count(*), min(p.period_start), min(p.period_end) into v_n, v_s, v_e
        from public.contract_periods(r.contract_id, 'billing', (r.m + interval '2 month')::date) p
       where p.service_month = r.m;
    end if;
    if v_n <> 1 then
      raise notice '0555: % left without a period — its contract has % billing period(s) in %.', r.invoice_number, v_n, to_char(r.m, 'Mon YYYY');
      continue;
    end if;

    select coalesce(sum(jl.credit - jl.debit), 0) into v_rev_before
      from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'invoices' and je.source_id = r.id and a.account_type = 'revenue';

    update public.invoices set period_start = v_s, period_end = v_e where id = r.id;

    select coalesce(sum(jl.credit - jl.debit), 0) into v_rev_after
      from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'invoices' and je.source_id = r.id and a.account_type = 'revenue';
    if v_rev_after <> v_rev_before then
      raise exception '0555 REFUSED: % moved revenue from % to % when its period was filled.', r.invoice_number, v_rev_before, v_rev_after;
    end if;
    if (select invoice_amount from public.invoices where id = r.id) <> r.invoice_amount
       or (select service_month from public.invoices where id = r.id) <> r.service_month then
      raise exception '0555 REFUSED: % changed amount or service month.', r.invoice_number;
    end if;
    v_filled := v_filled + 1;
  end loop;

  if exists (select 1 from public.partnership_uninvoiced_clients(v_co, '2026-09-01')) then
    raise exception '0555 REFUSED: September still lists a client as never billed: %',
      (select json_agg(u.client_name) from public.partnership_uninvoiced_clients(v_co, '2026-09-01') u);
  end if;
  raise notice '0555: % invoices given their billing period; September has no unbilled client.', v_filled;
end $mig$;

-- A hand-entered invoice now arrives with its period (rolled back).
do $proof$
declare v_id uuid; v_ps date;
begin
  begin
    insert into public.invoices (company_id, client_id, contract_id, invoice_number, invoice_date, invoice_amount, amount_received)
    select k.company_id, k.client_id, k.id, '0555-PROOF', '2026-10-01', 1000, 0
      from public.contracts k where k.contract_code = 'CON-0007'   -- HMC, October not yet invoiced
    returning id, period_start into v_id, v_ps;
    if v_ps is distinct from '2026-10-01' then raise exception '0555 REFUSED: a hand-entered invoice arrived with period %.', v_ps; end if;
    raise exception '0555-SENTINEL';
  exception when others then
    if sqlerrm <> '0555-SENTINEL' then raise; end if;
  end;
end $proof$;
