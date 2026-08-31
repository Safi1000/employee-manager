-- Period-split fixture — SANDBOX TESTING ORG only.
--
-- Without this, no fix to the partnership allocation is testable. Every existing
-- sandbox invoice carries invoice_date 2026-08-28 against a June or July service
-- period, so there is no period SPLIT: a report keyed on invoice_date and one
-- keyed on service month put everything in the same place, and a correct
-- implementation is indistinguishable from a broken one. The dataset happens to
-- be the one shape that hides the defect.
--
-- Needed on EITHER path in docs/LEDGER_PHASE1_F41_DEFECT_RECORD.md section 5.1.
-- Idempotent, keyed on invoice_number. SANDBOX ONLY — guarded.
--
--   A  FIX-SEP-COINCIDE   Vertex Labs (South)   service 2026-09, raised 2026-09-30
--   B  FIX-SEP-CROSS      Citadel Bank (North)  service 2026-09, raised 2026-10-05
--   C  a September RECEIPT for Delta Port Authority, which has no September invoice
--
-- Expected discrimination for September 2026:
--   service-month revenue = A + B   (300,000)
--   invoice_date  revenue = A       (100,000)
--   cash receipts         = C       (150,000)
-- A report that cannot tell these apart is not reading the basis it claims.
--
-- =====================================================================
-- WARNING — part C does NOT go through record_invoice_payment.
--
-- That RPC refuses a maintenance session (it compares current_company_id()
-- to the invoice company and raises "Not authorised for this company").
-- The first version of this fixture hand-rolled its side effects, which
-- encoded a MODEL of the RPC rather than the RPC itself. Diffing the two
-- found four divergences — three omissions, and one row that production
-- could never have created:
--
--   RPC behaviour                                   first fixture
--   ----------------------------------------------  ----------------------
--   spreads across ALL the client open invoices,    applied to one named
--     oldest first (invoice_date, invoice_number)     invoice (the July one)
--   one invoice_payments row per invoice settled    one row
--   splits withholding pro rata per invoice         n/a (WHT 0)
--   updates invoices.amount_received                same
--   NEVER writes invoices.status                    wrote Partly-Paid
--   updates treasury.cash_balance (Cash mode) or    neither
--     bank_accounts.balance (Bank mode)
--   inserts bank_transactions kind=receipt          none
--   REQUIRES p_bank_account_id when mode=Bank       mode Bank, account NULL
--
-- The last one matters most: the RPC would have rejected that call
-- outright, so the fixture created a row the application cannot produce.
--
-- This version replicates the side effects faithfully for the single-
-- invoice Cash case, and states the ONE divergence it keeps: it settles the
-- oldest open invoice directly rather than running the full waterfall.
-- That is deliberate and safe for this fixture contract, which is only
-- "an invoice_payments row exists in September for a client with no
-- September invoice" — the section 3 case. Which invoice it settles does
-- not affect that property.
--
-- The general finding belongs in the Phase 1 record: an RPC that cannot be
-- exercised outside an authorised app session cannot be tested by anything
-- except the app.
-- =====================================================================

do $$
declare
  v_co uuid; v_vertex uuid; v_citadel uuid; v_delta uuid;
  v_inv uuid; v_target uuid; v_pay uuid; v_amt numeric := 150000;
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
       invoice_amount, subtotal, total_due, status, branch_id)
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
       invoice_amount, subtotal, total_due, status, branch_id)
    select v_co, v_citadel, 'FIX-SEP-CROSS', date '2026-10-05',
           date '2026-09-01', date '2026-09-30',
           200000, 200000, 200000, 'Unpaid', c.branch_id
      from public.clients c where c.id = v_citadel
    returning id into v_inv;
    insert into public.invoice_lines (company_id, invoice_id, label, quantity, unit_rate, amount)
    values (v_co, v_inv, 'Guard deployment — September (billed October)', 1, 200000, 200000);
  end if;

  -- C: September receipt for a client with no September invoice.
  -- Settles the OLDEST open invoice — the one the RPC waterfall reaches first.
  -- Cash mode, so no bank account is required; the Bank path the first fixture
  -- used would have been rejected by the RPC.
  select i.id into v_target
    from public.invoices i
   where i.company_id = v_co and i.client_id = v_delta
     and (i.invoice_amount - i.amount_received) > 0.0001
   order by i.invoice_date, i.invoice_number
   limit 1;

  if v_target is not null
     and not exists (select 1 from public.invoice_payments
                      where company_id = v_co and payment_date = date '2026-09-15') then

    insert into public.invoice_payments
      (company_id, invoice_id, client_id, amount, withholding_amount, payment_date,
       payment_mode, notes)
    values (v_co, v_target, v_delta, v_amt, 0, date '2026-09-15', 'Cash',
            'F4.1 fixture — cash in period with no invoice in period')
    returning id into v_pay;

    -- amount_received only. The RPC does NOT write status.
    update public.invoices
       set amount_received = amount_received + v_amt, updated_at = now()
     where id = v_target;

    update public.treasury
       set cash_balance = cash_balance + v_amt, updated_at = now()
     where company_id = v_co;
    if not found then
      insert into public.treasury (company_id, cash_balance) values (v_co, v_amt);
    end if;

    insert into public.bank_transactions
      (company_id, bank_account_id, kind, amount, cash_delta, account_delta,
       description, reference_id)
    values
      (v_co, null, 'receipt', v_amt, v_amt, 0,
       'Payment received (cash) · Delta Port Authority · 1 invoice (oldest first)',
       v_pay::text);
  end if;
end $$;

-- Discrimination check: the three figures must differ, or the fixture has not
-- done its job and any fix tested against it proves nothing.
select 'service_month_revenue_sep' as measure, coalesce(sum(il.amount), 0) as amount
  from public.invoices i join public.invoice_lines il on il.invoice_id = i.id
 where i.company_id = (select id from public.companies where name = 'SANDBOX TESTING ORG')
   and coalesce(i.period_start, i.invoice_date) between date '2026-09-01' and date '2026-09-30'
union all
select 'invoice_date_revenue_sep', coalesce(sum(il.amount), 0)
  from public.invoices i join public.invoice_lines il on il.invoice_id = i.id
 where i.company_id = (select id from public.companies where name = 'SANDBOX TESTING ORG')
   and i.invoice_date between date '2026-09-01' and date '2026-09-30'
union all
select 'cash_receipts_sep', coalesce(sum(p.amount), 0)
  from public.invoice_payments p
 where p.company_id = (select id from public.companies where name = 'SANDBOX TESTING ORG')
   and p.payment_date between date '2026-09-01' and date '2026-09-30';

-- Waterfall check — the shape of defect F4 has to be able to detect.
--
-- The first version of this fixture put the September receipt on STS-26-DPA-07
-- while record_invoice_payment's `order by i.invoice_date, i.invoice_number`
-- would have reached STS-26-DPA-06 first (both are dated 2026-08-28, so the
-- invoice_number tiebreak decides). Every downstream figure was still correct in
-- total and wrong per invoice: same client, same amount, same period, different
-- receivable. A report keyed on the client cannot see it; a report keyed on the
-- invoice is silently wrong.
--
-- That is exactly the class F4's per-client attribution has to survive, so it is
-- asserted here rather than only fixed.
select case
    when p.invoice_id is null then 'WATERFALL  SKIP  (no September receipt)'
    when p.invoice_id = oldest.id then 'WATERFALL  PASS  (receipt on ' || oldest.invoice_number || ', the oldest open invoice)'
    else 'WATERFALL  FAIL  (receipt on ' || wrong.invoice_number || ', oldest open is ' || oldest.invoice_number || ')'
  end as waterfall_check
from (select id from public.companies where name = 'SANDBOX TESTING ORG') co
left join lateral (
  select * from public.invoice_payments ip
   where ip.company_id = co.id and ip.payment_date = date '2026-09-15' limit 1
) p on true
left join lateral (
  select i.id, i.invoice_number from public.invoices i
   where i.company_id = co.id and i.client_id = p.client_id
     and (i.invoice_amount - i.amount_received + coalesce(p.amount, 0)
          * (case when i.id = p.invoice_id then 1 else 0 end)) > 0.0001
   order by i.invoice_date, i.invoice_number limit 1
) oldest on true
left join lateral (
  select invoice_number from public.invoices where id = p.invoice_id
) wrong on true;

-- KNOWN GAP (docs/LEDGER_PHASE1_FIXTURE_AUDIT.md, F6): invoices A and B are
-- written without contract_id, invoice_taxes, financial_year, invoice_group,
-- withholding_tax or generated — all of which InvoiceGenerate.tsx always writes.
-- contract_id is the one that bites: uq_invoice_contract_month (0113) does not
-- constrain a NULL contract, and any report reaching invoices through a contract
-- join will not see these rows. Fix before these fixtures are used to validate
-- per-client attribution.
