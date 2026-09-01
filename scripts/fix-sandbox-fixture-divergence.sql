-- Correct the divergent period-split fixture data in SANDBOX TESTING ORG.
--
-- NOT APPLIED. Dry run first (section 1), apply only after reading it (section 2).
--
-- The first version of supabase/tests/fixtures_period_split.sql hand-rolled
-- record_invoice_payment's side effects and got four things wrong. The FILE is
-- corrected; the SANDBOX still holds the divergent row, and re-running the
-- corrected fixture will NOT repair it — the fixture is idempotent on
-- "a payment already exists on 2026-09-15", so it will simply skip.
--
-- Six corrections, one of which touches a posted journal entry.
--
--   1  invoice_payments.payment_mode   'Bank' -> 'Cash'
--        The RPC requires p_bank_account_id for Bank mode; the row has NULL.
--        It is a row production could not have created.
--   2  invoice_payments.invoice_id     DPA-07 -> DPA-06
--        Both invoices are dated 2026-08-28, so the RPC's
--        `order by i.invoice_date, i.invoice_number` tiebreak reaches DPA-06.
--        The fixture settled the wrong invoice.
--   3  invoices STS-26-DPA-07          amount_received 150000 -> 0,
--                                      status 'Partly-Paid' -> 'Delivered'
--        The RPC NEVER writes invoices.status. Every other sandbox invoice of
--        that batch is 'Delivered'; DPA-07 is the only 'Partly-Paid' and the
--        fixture is the only thing that could have made it so.
--   4  invoices STS-26-DPA-06          amount_received 0 -> 150000
--        status deliberately untouched — the RPC does not write it.
--   5  treasury.cash_balance           1955990.13 -> 2105990.13
--        The RPC moves cash on Cash mode. The fixture moved nothing.
--   6  bank_transactions               insert the missing receipt row
--        cash_delta +150000, account_delta 0, bank_account_id NULL.
--
-- And the consequence nobody asked for: because the row said 'Bank',
-- trg_yyy_payments_journal posted the receipt to the BANK control account.
--
--    entry 81e38a78-bde2-4360-bd15-1d5d1a2b404c, period 2026-09-01, posted
--      bank  Dr 150,000.00
--      ar    Cr 150,000.00   (client dimension set)
--
-- With no bank_accounts.balance movement and no bank_transactions row, the
-- sandbox ledger currently claims 150,000 of bank money the operational tables
-- have never heard of. ledger_checks stays green because the AR control
-- reconciles against invoice_payments and THERE IS NO CHECK TYING THE BANK
-- CONTROL ACCOUNT TO bank_accounts + bank_transactions. That gap is recorded in
-- docs/LEDGER_PHASE1_FIXTURE_AUDIT.md and is worth a ninth ledger_checks item.
--
-- Correction 7 repoints that journal line bank -> cash. It mutates a POSTED
-- entry, so it runs under the maintenance protocol, and it is the reason
-- section 2 is a single transaction rather than a set of statements.


-- =====================================================================
-- SECTION 1 — DRY RUN. Read-only. Shows every value before and after.
-- =====================================================================

with co as (select id from public.companies where name = 'SANDBOX TESTING ORG'),
pay as (select p.* from public.invoice_payments p, co
         where p.company_id = co.id and p.payment_date = date '2026-09-15'),
tgt as (select i.id, i.invoice_number
          from public.invoices i, co, pay
         where i.company_id = co.id and i.client_id = pay.client_id
           and (i.invoice_amount - i.amount_received) > 0.0001
         order by i.invoice_date, i.invoice_number limit 1)
select * from (
  select 1 as seq, 'payment.payment_mode' as field,
         (select payment_mode from pay) as is_now, 'Cash' as should_be
  union all
  select 2, 'payment.invoice_id -> invoice',
         (select i.invoice_number from public.invoices i, pay where i.id = pay.invoice_id),
         (select invoice_number from tgt)
  union all
  select 3, 'DPA-07.amount_received',
         (select amount_received::text from public.invoices where invoice_number = 'STS-26-DPA-07'),
         '0.00'
  union all
  select 4, 'DPA-07.status',
         (select status from public.invoices where invoice_number = 'STS-26-DPA-07'),
         'Delivered'
  union all
  select 5, 'DPA-06.amount_received',
         (select amount_received::text from public.invoices where invoice_number = 'STS-26-DPA-06'),
         '150000.00'
  union all
  select 6, 'DPA-06.status  (must NOT change)',
         (select status from public.invoices where invoice_number = 'STS-26-DPA-06'),
         (select status from public.invoices where invoice_number = 'STS-26-DPA-06')
  union all
  select 7, 'treasury.cash_balance',
         (select t.cash_balance::text from public.treasury t, co where t.company_id = co.id),
         (select (t.cash_balance + 150000)::text from public.treasury t, co where t.company_id = co.id)
  union all
  select 8, 'bank_transactions on 2026-09-15',
         (select count(*)::text from public.bank_transactions b, co
           where b.company_id = co.id and b.created_at::date = date '2026-09-15'),
         '1'
  union all
  select 9, 'journal debit account (entry 81e38a78)',
         (select a.system_key from public.journal_lines jl
            join public.chart_of_accounts a on a.id = jl.account_id
           where jl.journal_entry_id = '81e38a78-bde2-4360-bd15-1d5d1a2b404c'
             and jl.debit > 0),
         'cash'
) x order by seq;

-- Sanity: the AR control must be unchanged by all of this. The payment amount
-- and client do not move, only which invoice it lands on, so AR is invariant.
-- Run ledger_checks before and after and diff — every row must be identical.
select check_name, actual, passed
  from public.ledger_checks((select id from public.companies where name = 'SANDBOX TESTING ORG'))
 order by check_name;


-- =====================================================================
-- SECTION 2 — APPLY. One transaction. Read section 1 first.
-- =====================================================================
--
-- Requires a superuser / BYPASSRLS session_user: correction 7 mutates a posted
-- journal entry and is_maintenance_session() gates on session_user, not
-- current_user.

/*
begin;
set local app.ledger_maintenance = 'on';

do $$
declare
  v_co   uuid;
  v_pay  public.invoice_payments%rowtype;
  v_old  uuid;
  v_new  uuid;
  v_cash uuid;
  v_amt  numeric;
begin
  select id into v_co from public.companies where name = 'SANDBOX TESTING ORG';
  if v_co is null then
    raise exception 'SANDBOX TESTING ORG not found — this script is sandbox-only';
  end if;

  select * into v_pay from public.invoice_payments
   where company_id = v_co and payment_date = date '2026-09-15';
  if v_pay.id is null then
    raise notice 'No 2026-09-15 payment — nothing to correct.';
    return;
  end if;
  if v_pay.payment_mode = 'Cash' then
    raise notice 'Already corrected — payment is Cash mode. Nothing to do.';
    return;
  end if;

  v_old := v_pay.invoice_id;
  v_amt := v_pay.amount;

  -- The invoice the RPC's waterfall would actually have reached first, computed
  -- as the RPC computes it rather than hardcoded, so this stays correct if the
  -- sandbox invoice set changes.
  select i.id into v_new
    from public.invoices i
   where i.company_id = v_co and i.client_id = v_pay.client_id
     and i.id <> v_old
     and (i.invoice_amount - i.amount_received) > 0.0001
   order by i.invoice_date, i.invoice_number
   limit 1;
  if v_new is null then
    raise exception 'No older open invoice for the client — re-read section 1 before forcing this';
  end if;

  -- 3: unwind the wrong invoice. status back to the batch value, which the RPC
  --    would never have written in the first place.
  update public.invoices
     set amount_received = amount_received - v_amt,
         status = 'Delivered',
         updated_at = now()
   where id = v_old;

  -- 4: apply to the right one. status untouched, deliberately.
  update public.invoices
     set amount_received = amount_received + v_amt,
         updated_at = now()
   where id = v_new;

  -- 1 + 2
  update public.invoice_payments
     set invoice_id = v_new, payment_mode = 'Cash', bank_account_id = null
   where id = v_pay.id;

  -- 5
  update public.treasury
     set cash_balance = cash_balance + v_amt, updated_at = now()
   where company_id = v_co;

  -- 6
  insert into public.bank_transactions
    (company_id, bank_account_id, kind, amount, cash_delta, account_delta,
     description, reference_id)
  values
    (v_co, null, 'receipt', v_amt, v_amt, 0,
     'Payment received (cash) · Delta Port Authority · 1 invoice (oldest first)',
     v_pay.id::text);

  -- 7: the posted entry debited bank because the row claimed Bank mode.
  select id into v_cash from public.chart_of_accounts
   where company_id = v_co and system_key = 'cash';
  if v_cash is null then
    raise exception 'No cash control account for the sandbox — cannot repoint the journal line';
  end if;

  update public.journal_lines jl
     set account_id = v_cash
    from public.journal_entries je
   where je.id = jl.journal_entry_id
     and je.company_id = v_co
     and je.source_table = 'invoice_payments'
     and je.source_id = v_pay.id
     and jl.debit > 0;

  raise notice 'Corrected: payment % moved to invoice %, Cash mode, journal repointed to cash.',
    v_pay.id, v_new;
end $$;

-- Must be identical to the section 1 reading. The payment's amount and client
-- never moved, so nothing here may shift.
select check_name, actual, passed
  from public.ledger_checks((select id from public.companies where name = 'SANDBOX TESTING ORG'))
 order by check_name;

-- commit;   -- uncomment deliberately, after reading the check output above
rollback;
*/
