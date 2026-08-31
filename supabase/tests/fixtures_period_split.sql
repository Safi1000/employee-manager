-- Period-split fixture — SANDBOX TESTING ORG only.
--
-- Without this, no fix to the partnership allocation is testable. Every existing
-- sandbox invoice carries invoice_date 2026-08-28 against a June or July service
-- period, so there is no period SPLIT: a report keyed on invoice_date and a
-- report keyed on service month put everything in the same place, and a correct
-- implementation is indistinguishable from a broken one. The dataset happens to
-- be the one shape that hides the defect.
--
-- Needed on EITHER path in docs/LEDGER_PHASE1_F41_DEFECT_RECORD.md §5.1 — if
-- regional_pl_range is retired, the ledger-derived replacement needs the same
-- coverage.
--
-- Idempotent: keyed on invoice_number, safe to re-run. SANDBOX ONLY — guarded.
--
-- What it creates, all for September 2026:
--
--   A  FIX-SEP-COINCIDE   Vertex Labs (South)   service 2026-09, raised 2026-09-30
--                         -> both bases agree
--   B  FIX-SEP-CROSS      Citadel Bank (North)  service 2026-09, raised 2026-10-05
--                         -> service-month basis sees it in September,
--                            invoice_date basis sees it in October
--   C  a September RECEIPT against Delta Port Authority's existing July invoice,
--      with NO September invoice for Delta
--                         -> cash-in-period with no revenue-in-period row: the
--                            §3 case, where the cs_rev-driven row set drops a
--                            cash-only client entirely
--
-- Expected discrimination for September 2026:
--   service-month revenue = A + B          (100,000 + 200,000 = 300,000)
--   invoice_date  revenue = A only         (100,000)
--   cash receipts         = C only         (Delta, 150,000)
-- A report that cannot tell these three apart is not reading the basis it claims.

do $$
declare
  v_co      uuid;
  v_vertex  uuid;
  v_citadel uuid;
  v_delta   uuid;
  v_inv     uuid;
  v_jul     uuid;
  v_gross   numeric;
  v_paid    numeric;
begin
  select id into v_co from public.companies where name = 'SANDBOX TESTING ORG';
  if v_co is null then
    raise exception 'SANDBOX TESTING ORG not found — this fixture is sandbox-only';
  end if;

  select id into v_vertex  from public.clients where company_id = v_co and name like 'Vertex%';
  select id into v_citadel from public.clients where company_id = v_co and name like 'Citadel%';
  select id into v_delta   from public.clients where company_id = v_co and name like 'Delta%';

  -- A: service month and invoice date coincide.
  if not exists (select 1 from public.invoices where invoice_number = 'FIX-SEP-COINCIDE') then
    insert into public.invoices
      (company_id, client_id, invoice_number, invoice_date, period_start, period_end,
       invoice_amount, subtotal, total_due, status,
       branch_id)
    select v_co, v_vertex, 'FIX-SEP-COINCIDE', date '2026-09-30',
           date '2026-09-01', date '2026-09-30',
           100000, 100000, 100000, 'Unpaid', c.branch_id
      from public.clients c where c.id = v_vertex
    returning id into v_inv;

    insert into public.invoice_lines (company_id, invoice_id, label, quantity, unit_rate, amount)
    values (v_co, v_inv, 'Guard deployment — September', 1, 100000, 100000);
  end if;

  -- B: September service, raised in October. The two bases disagree.
  if not exists (select 1 from public.invoices where invoice_number = 'FIX-SEP-CROSS') then
    insert into public.invoices
      (company_id, client_id, invoice_number, invoice_date, period_start, period_end,
       invoice_amount, subtotal, total_due, status,
       branch_id)
    select v_co, v_citadel, 'FIX-SEP-CROSS', date '2026-10-05',
           date '2026-09-01', date '2026-09-30',
           200000, 200000, 200000, 'Unpaid', c.branch_id
      from public.clients c where c.id = v_citadel
    returning id into v_inv;

    insert into public.invoice_lines (company_id, invoice_id, label, quantity, unit_rate, amount)
    values (v_co, v_inv, 'Guard deployment — September (billed October)', 1, 200000, 200000);
  end if;

  -- C: a September receipt against a July invoice, for a client with NO
  -- September invoice.
  --
  -- NOT via record_invoice_payment: that RPC gates on an authorised app session
  -- ("Not authorised for this company"), which a maintenance/psql session is
  -- not. Its side effects are replicated instead — the payment row plus
  -- amount_received/status — so the AR control check stays green. The journal
  -- posts either way: trg_yyy_payments_journal fires on a direct insert.
  select id, coalesce(total_due, invoice_amount), amount_received
    into v_jul, v_gross, v_paid
    from public.invoices
   where company_id = v_co and client_id = v_delta
     and period_start = date '2026-07-01'
   order by invoice_number limit 1;

  if v_jul is not null
     and not exists (select 1 from public.invoice_payments
                      where invoice_id = v_jul and payment_date = date '2026-09-15') then
    insert into public.invoice_payments
      (company_id, invoice_id, client_id, amount, payment_date, payment_mode, notes)
    values (v_co, v_jul, v_delta, 150000, date '2026-09-15', 'Bank',
            'F4.1 fixture — cash in period with no invoice in period');

    update public.invoices
       set amount_received = coalesce(amount_received, 0) + 150000,
           status = case when coalesce(amount_received, 0) + 150000 >= v_gross
                         then 'Paid' else 'Partly-Paid' end,
           updated_at = now()
     where id = v_jul;
  end if;
end $$;

-- Discrimination check: the three figures must differ, or the fixture has not
-- done its job and any fix tested against it proves nothing.
select 'service_month_revenue_sep' as measure,
       coalesce(sum(il.amount), 0) as amount
  from public.invoices i join public.invoice_lines il on il.invoice_id = i.id
 where i.company_id = (select id from public.companies where name = 'SANDBOX TESTING ORG')
   and coalesce(i.period_start, i.invoice_date) between date '2026-09-01' and date '2026-09-30'
union all
select 'invoice_date_revenue_sep',
       coalesce(sum(il.amount), 0)
  from public.invoices i join public.invoice_lines il on il.invoice_id = i.id
 where i.company_id = (select id from public.companies where name = 'SANDBOX TESTING ORG')
   and i.invoice_date between date '2026-09-01' and date '2026-09-30'
union all
select 'cash_receipts_sep',
       coalesce(sum(p.amount), 0)
  from public.invoice_payments p
 where p.company_id = (select id from public.companies where name = 'SANDBOX TESTING ORG')
   and p.payment_date between date '2026-09-01' and date '2026-09-30';
