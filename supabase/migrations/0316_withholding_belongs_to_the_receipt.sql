-- 0316 — withholding is recognised on the RECEIPT, not on the invoice.
--
-- THE POLICY (A1, locked)
--
-- The client is billed GROSS. Withholding is not a discount the invoice grants;
-- it is tax the client deducts when it pays and remits to the FBR on our
-- behalf. It therefore becomes known at the receipt, in the amount the client
-- actually deducted — which may differ from any rate agreed in advance.
--
-- 0221 removed the withholding deduction from record_invoice_payment's
-- settlement arithmetic. 0281 wired clients.withholding_tax_rate through to
-- p_withholding so the per-receipt amount is reachable from the application.
-- 0313 established that total_due is a document figure and no balance. 0314
-- made the receivable a generated column, invoice_amount - amount_received.
--
-- What was left was the invoice-time column itself, and its writers.
--
-- THE THREE WRITERS OF invoices.withholding_tax
--
--   1. Invoices.tsx      manual add/edit form. Its help text read
--                        "Deducted from the receivable balance for this
--                        invoice" — the model A1 rejects, stated on screen.
--   2. InvoiceGenerate   wrote withholding_tax = tax_withheld_total, the same
--                        value twice on the same row.
--   3. run_auto_invoices  coalesce(clients.auto_invoice_withholding, 0)
--
-- (1) and (2) are removed in the same commit as this file. (3) is here, and it
-- is the one that gets missed: a UI-only change leaves the automated path
-- stamping withholding onto every generated invoice, which is WORSE than not
-- making the change — the field disappears from the screen and keeps being
-- written, so the number has no visible cause.
--
-- WHAT THE DELETED WRITERS WROTE THAT THE SURVIVOR DOES NOT (the 0315 rule)
--
--   Writer 2 also wrote tax_withheld_total, the DOCUMENT's withholding, which
--   the printed invoice shows and which is untouched. Only the balance-bearing
--   duplicate is gone, so no invoice prints differently.
--
--   Writer 3 read clients.auto_invoice_withholding, an AMOUNT. The survivor
--   reads clients.withholding_tax_rate, a PERCENT. They are different columns,
--   maintained separately, and a client carrying the first but not the second
--   would silently lose its prefill. Measured on crm-design (PRODUCTION)
--   before writing this:
--
--     clients with auto_invoice_enabled ............ 0
--     clients with auto_invoice_withholding > 0 .... 0
--     clients with withholding_tax_rate > 0 ........ 5
--
--   Nothing to carry across. Recorded because it was checked, not assumed —
--   the reason 0315 exists is that the equivalent question went unasked.
--
-- THE READERS, WHICH ARE THE OTHER HALF
--
-- Removing a writer without repointing the readers is how a column becomes a
-- silent zero. Three readers treated withholding_tax as a balance reducer and
-- are corrected in the same commit:
--
--   Accounting.tsx x2   the client-ledger aggregate,
--                       opening + invoiced - withholding - received.
--                       The receivable is cleared by cash and withholding
--                       TOGETHER and both are already inside amount_received,
--                       so this relieved it twice — the shape of 0313.
--   invoicePdf.ts       balance_due = amt - wht - received.
--
-- None of the three was caught by scripts/check-outstanding.mjs, whose two
-- rules were both anchored on per-invoice tokens. Rule 3 was added for the
-- aggregate form, with the deleted lines themselves as its red fixtures.
--
-- The Withholding COLUMN on the receivables screen now sums
-- invoice_payments.withholding_amount. Left pointed at the invoice it would
-- have read 0.00 for every client from today, and shown up months later as
-- missing text on a screen with no obvious cause.
--
-- MAGNITUDE, on crm-design (PRODUCTION), 2026-09-01 UTC
--
--   invoices ......................................... 9
--   with withholding_tax <> 0 ........................ 1  (FIX-SEP-CROSS, 15.00)
--   receivable overstatement removed ................. 15.00
--
-- Fifteen rupees. The correction is worth making because the mechanism is
-- wrong, not because the number is large — and a defect this cheap is one
-- nobody would ever have been forced to find.
--
-- THE COLUMN STAYS. Invoices raised before today carry real values and the
-- PDF renders them. It simply has no writer any more, and check 20 below is
-- what tells us if it acquires one.
--
-- AND A SECOND DEFECT, FOUND BY THE PROOF
--
-- run_auto_invoices DID NOT RUN AT ALL. Its local variable was named
-- period_start, and a later migration added an invoices.period_start COLUMN,
-- so this line inside the duplicate check
--
--     where invoice_date = period_start
--
-- became "42702 column reference period_start is ambiguous" and the function
-- raised on its first iteration. The variable is renamed v_period here.
--
-- Nobody saw it because the loop never has a row to iterate: no client on
-- crm-design has auto_invoice_enabled, so the generator exits before reaching
-- the ambiguous statement, returns 0, and looks like a quiet day. The defect
-- was latent from whenever period_start was added until the first client
-- switched auto-invoicing on — at which point the feature would have failed
-- with a message nobody would connect to a schema change made months earlier.
--
-- This is why direction 1 of the proof RUNS the generator against a client it
-- sets up, rather than reading the new source and calling that a test. A
-- change verified by reading would have shipped the withholding fix into a
-- function that still could not execute, and reported it as done.

-- ---------------------------------------------------------------------------
-- WRITER 3
-- ---------------------------------------------------------------------------

create or replace function public.run_auto_invoices(p_run_date date default current_date)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  rec record;
  v_period date;
  inv_number text;
  v_contract uuid;
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
    -- 0316: v_period, not period_start. invoices gained a period_start COLUMN
    -- after this function was written, which made the unqualified references
    -- below ambiguous and the function unrunnable.
    if rec.advance_payment then
      v_period := date_trunc('month', p_run_date)::date;
    else
      v_period := (date_trunc('month', p_run_date) - interval '1 month')::date;
    end if;

    if rec.contract_start is not null and v_period < rec.contract_start then
      continue;
    end if;
    if rec.contract_end is not null and v_period > rec.contract_end then
      continue;
    end if;

    if exists (
      select 1 from public.invoices
       where client_id = rec.client_id
         and invoice_date = v_period
         and invoice_amount = rec.auto_invoice_amount
    ) then
      continue;
    end if;

    -- The contract in force for the billed period. Left null when the client has
    -- none or more than one could apply — never guessed.
    select k.id into v_contract
      from public.contracts k
     where k.client_id = rec.client_id
       and k.status = 'active'
       and k.start_date <= v_period
       and (k.is_infinite or k.end_date is null or k.end_date >= v_period)
     limit 2;
    if (select count(*) from public.contracts k
         where k.client_id = rec.client_id
           and k.status = 'active'
           and k.start_date <= v_period
           and (k.is_infinite or k.end_date is null or k.end_date >= v_period)) <> 1 then
      v_contract := null;
    end if;

    inv_number := public.next_invoice_number(rec.company_id, v_period);

    -- 0316: withholding_tax is NOT set, and clients.auto_invoice_withholding is
    -- no longer read. The invoice is raised GROSS; withholding is recorded on
    -- the receipt that carries it (A1). The column keeps its default of 0.
    insert into public.invoices (
      company_id, client_id, contract_id, invoice_number, invoice_date, invoice_amount,
      amount_received, status, notes
    ) values (
      rec.company_id, rec.client_id, v_contract, inv_number, v_period, rec.auto_invoice_amount,
      0, 'Pending',
      'Auto-issued for ' || to_char(v_period, 'Mon YYYY')
    );
    issued := issued + 1;
  end loop;
  return issued;
end;
$function$;

comment on column public.invoices.withholding_tax is
  'LEGACY, and no longer written by anything (0316). Withholding is recognised on the receipt: see invoice_payments.withholding_amount and record_invoice_payment''s p_withholding. Non-zero only on invoices raised before 2026-09-01. Never subtract it from a balance — the receivable is GROSS (A1) and is cleared by cash and withholding together, both of which are already inside amount_received.';

-- ---------------------------------------------------------------------------
-- CHECK 20 — the column has no writer, and we would know if it acquired one.
--
-- 0316 removed the three writers we FOUND. That is the same sentence 0268's
-- original defect was built on, so it does not get to be the last word. This
-- check tests the condition rather than the change: an invoice created from the
-- cutover onward carrying a non-zero withholding_tax means something wrote it,
-- whatever that something turns out to be.
--
-- created_at, not invoice_date. invoice_date is the billing period and can be
-- backdated freely; created_at is when the row was written, which is the only
-- thing that separates rows the old writers made from rows made after them.
-- Anchoring on invoice_date would have made the check green for any new invoice
-- backdated past the cutover, which is a check testing a proxy (report 9.6).
--
-- THE CUTOVER INSTANT, AND WHY IT IS NOT "TODAY"
--
-- The first version of this check read created_at >= '2026-09-02 00:00:00+00',
-- because the calendar on the machine writing it said 2026-09-02. The proof
-- planted a row and the check did not find it.
--
-- crm-design runs in UTC and now() was 2026-09-01 20:44Z. The local date was
-- already the 2nd in Pakistan (+05); the database's was still the 1st. A row
-- written at that moment sat BEFORE a cutover meant to be "from now on", so
-- the check was blind to every row written in the intervening five hours —
-- silently, and only in the direction that lets a defect through.
--
-- A date literal is not an instant until a timezone is attached, and the
-- timezone that matters is the DATABASE'S, never the author's. This is the
-- same failure as a guard comparing a version string: it looked right, and it
-- was right about the wrong thing.
--
-- The cutover is therefore anchored on measured data rather than on a
-- calendar. On crm-design (PRODUCTION):
--
--   newest invoice created_at ......... 2026-08-31 05:12:41Z
--   now() at time of writing .......... 2026-09-01 20:44:25Z
--   cutover chosen .................... 2026-09-01 00:00:00Z
--
-- After every row that exists, before the migration is applied, and stated
-- with the measurement that makes it true.
-- ---------------------------------------------------------------------------

create or replace function public.withholding_written_after_cutover(p_company_id uuid)
returns table(invoice_id uuid, invoice_number text, created_at timestamptz, withholding_tax numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select i.id, i.invoice_number, i.created_at, i.withholding_tax
    from public.invoices i
   where i.company_id = p_company_id
     and i.created_at >= timestamptz '2026-09-01 00:00:00+00'
     and coalesce(i.withholding_tax, 0) <> 0
   order by i.created_at;
$function$;

comment on function public.withholding_written_after_cutover(uuid) is
  'Invoices written on or after the 0316 cutover that still carry an invoice-time withholding_tax. Must be empty: A1 recognises withholding on the receipt, and 0316 removed the three writers. A row here means a fourth writer exists.';

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric,
              difference numeric, passed boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with real_checks as (
    select b.check_name, b.expected, b.actual, b.difference, b.passed
      from public.ledger_checks_base(p_company_id) b
     where b.check_name <> 'checks_evaluated'
    union all
    select 'cash_per_location_gl_equals_operational'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.custodian_held_operational(p_company_id) h
     where abs(h.difference) > 0.005
    union all
    select 'every_source_row_posted'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.unposted_source_rows(p_company_id)
    union all
    select 'bank_per_account_gl_equals_operational'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.bank_held_operational(p_company_id) b
     where abs(b.difference) > 0.005
    union all
    select 'no_negative_custodian_balance'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.negative_custodian_balances(p_company_id)
    union all
    select 'profit_allocation_exhausts_pool'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.profit_allocation_over_allocated(p_company_id)
    union all
    select 'payroll_accrual_matches_attendance'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.payroll_attendance_drift(p_company_id)
    union all
    -- Company-independent by nature: it reads the catalogue, not the data. It
    -- lives here anyway because this is the surface anyone actually calls, and
    -- a detector nothing calls is the defect 0288 exists to find.
    select 'total_due_not_read_as_a_balance'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.total_due_read_as_a_balance()
    union all
    select 'no_invoice_time_withholding'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.withholding_written_after_cutover(p_company_id)
  )
  select * from real_checks
  union all
  -- 20 = the number of REAL checks. The function returns one more row than
  -- this — the canary itself. Bump the constant deliberately when adding a
  -- check; never to make this row green.
  select 'checks_evaluated'::text,
         20::numeric,
         (select count(*) from real_checks)::numeric,
         (select count(*) from real_checks)::numeric - 20,
         (select count(*) from real_checks) = 20;
$function$;

-- ---------------------------------------------------------------------------
-- PROOF, in both directions.
--
-- Direction 1: run_auto_invoices no longer reads auto_invoice_withholding, and
--   an invoice it raises for a client that HAS one comes out at 0.
-- Direction 2: check 20 is capable of going red — a post-cutover invoice with
--   a non-zero withholding_tax is found.
--
-- A green check that has never been shown red is indistinguishable from one
-- that cannot fail. Both run inside a subtransaction unwound by a deliberate
-- raise, against a real company.
-- ---------------------------------------------------------------------------

do $$
declare
  v_co       uuid;
  v_client   uuid;
  v_issued   int;
  v_wht      numeric;
  v_red      int;
  v_green    int;
  v_n        int;
  v_evaluated boolean;
begin
  select id into v_co from public.companies order by created_at limit 1;
  if v_co is null then
    raise notice '0316: no company; proof skipped';
    return;
  end if;

  begin
    -- Direction 2 first, because it needs no setup: plant a post-cutover
    -- invoice carrying withholding and confirm the check finds it.
    select id into v_client from public.clients where company_id = v_co limit 1;
    if v_client is null then
      raise exception 'ROLLBACK_NO_CLIENT';
    end if;

    insert into public.invoices
      (company_id, client_id, invoice_number, invoice_date, invoice_amount,
       withholding_tax, amount_received, status, created_at)
    values
      (v_co, v_client, '0316-PROOF-RED', current_date, 1000, 25, 0, 'Pending', now());

    select count(*) into v_red from public.withholding_written_after_cutover(v_co);

    delete from public.invoices where invoice_number = '0316-PROOF-RED';

    select count(*) into v_green from public.withholding_written_after_cutover(v_co);

    -- Direction 1: give a client an auto-invoice amount AND a withholding
    -- amount, run the generator, and read back what it wrote.
    update public.clients
       set auto_invoice_enabled = true,
           auto_invoice_amount = 12345,
           auto_invoice_withholding = 999,
           advance_payment = false,
           contract_start = null,
           contract_end = null
     where id = v_client;

    select public.run_auto_invoices(current_date) into v_issued;
    select coalesce(max(coalesce(withholding_tax, 0)), -1) into v_wht
      from public.invoices
     where client_id = v_client and invoice_amount = 12345;

    select count(*) into v_n from public.ledger_checks(v_co);
    select passed into v_evaluated
      from public.ledger_checks(v_co) where check_name = 'checks_evaluated';

    raise exception 'ROLLBACK_PROOF';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_NO_CLIENT' then
        raise notice '0316: no client on the first company; proof skipped';
        return;
      end if;
      if sqlerrm <> 'ROLLBACK_PROOF' then
        raise exception '0316: the probe failed for the wrong reason: % %', sqlstate, sqlerrm;
      end if;
  end;

  if v_red < 1 then
    raise exception
      '0316: check 20 did not find a planted post-cutover withholding row — it cannot fail';
  end if;
  if v_green <> 0 then
    raise exception
      '0316: check 20 reports % rows with the planted row removed', v_green;
  end if;
  if v_issued < 1 then
    raise exception
      '0316: run_auto_invoices issued nothing, so direction 1 proved nothing';
  end if;
  if v_wht <> 0 then
    raise exception
      '0316: run_auto_invoices wrote withholding_tax = % for a client whose auto_invoice_withholding is 999',
      v_wht;
  end if;
  if v_n <> 21 then
    raise exception '0316: ledger_checks returns % rows, 21 expected (20 checks + canary)', v_n;
  end if;
  if not v_evaluated then
    raise exception '0316: checks_evaluated is red — the count and the constant disagree';
  end if;

  -- and it unwound
  if exists (select 1 from public.invoices where invoice_number = '0316-PROOF-RED') then
    raise exception '0316: the probe did not unwind';
  end if;

  raise notice
    '0316: check 20 goes red on a planted row (%) and green without it; run_auto_invoices issued % invoice(s) at withholding_tax = % despite auto_invoice_withholding = 999; ledger_checks evaluates % checks',
    v_red, v_issued, v_wht, v_n - 1;
end $$;
