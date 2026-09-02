-- 0323 — an invoice raised before the month it bills for defers its revenue.
--
-- Shayan's ruling (§9.19): AR posts at invoice_date, revenue at period_start,
-- and unearned revenue carries the interval.
--
--   Invoice raised in September for October service:
--     at invoice_date   Dr Accounts Receivable / Cr Unearned Revenue
--     at period_start   Dr Unearned Revenue     / Cr Revenue
--
-- THREE THINGS THIS MIGRATION DECIDES, EACH BECAUSE READING SETTLED IT.
--
-- 1. THE BRANCH IS NARROW: it fires only when invoice_date < period_start.
--    All 9 invoices on production and all 9 on dev are ARREARS
--    (invoice_date > period_start), and today AR, revenue and sales tax all
--    post together at coalesce(period_start, invoice_date). Applying "AR at
--    invoice_date" generally would re-date the AR leg of every invoice that
--    exists, and the interval account would carry a DEBIT balance in a
--    liability — that is unbilled revenue, an asset, and no such account was
--    authorised. Arrears is left exactly as it was, and 0323 proves it.
--
-- 2. THE RECOGNITION ENTRY IS NOT WRITTEN AT INVOICE TIME. It cannot be:
--    0322 refuses any entry posting into a period that has not been reached,
--    and an October entry written in September is precisely that. So the
--    invoice posts only the deferral, and recognise_advance_revenue() posts the
--    recognition when the month arrives. That is how deferred revenue works
--    anyway — the deferral is a fact today, the recognition is a fact next
--    month — and it keeps 0322 absolute rather than carving a hole in a rule
--    ruled absolute one message earlier.
--
-- 3. run_auto_invoices IS NOT TOUCHED HERE, and that is a finding, not an
--    omission. It never writes period_start, so the service month of an
--    auto-issued invoice is only implied by invoice_date and every rule keyed
--    on period_start is inert for exactly the invoices advance_payment
--    governs. Fixing that needs surgery on its body — and dev and production
--    do not have the same body:
--
--      production  99fc7c74281ed31d3fe7b8f5506cc516  2849 chars, uses v_period
--      dev         8662cf340ad824e8c501ade31f0434b5  2546 chars, no v_period
--
--    Dev is missing 0316's rewrite of that function. A patch anchored on one
--    cannot be rehearsed on the other, and widening the anchor to match both
--    would be teaching an assertion to accept what it finds. It waits for the
--    two databases to agree, as its own migration.
--
--    Worth stating either way: auto-invoicing does not produce advance-shaped
--    invoices. For an advance client the function bills the first day of the
--    service month, so invoice_date = period_start and the deferral branch
--    correctly does not fire. A manual invoice with a future period_start is
--    what this migration is for.

-- ---------------------------------------------------------------------------
-- Step 1. The account.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_unearned_revenue_account(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_id uuid;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select id into v_id from public.chart_of_accounts
   where company_id = p_company_id and system_key = 'unearned_revenue'
   limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side,
     system_key, active, system_account, is_control)
  values
    (p_company_id, '2700', 'Unearned Revenue', 'liability', 'credit',
     'unearned_revenue', true, true, false)
  returning id into v_id;

  return v_id;
end;
$fn$;

comment on function public.ensure_unearned_revenue_account(uuid) is
  '0323: the liability that carries an advance invoice between invoice_date and period_start. Created lazily like ensure_bad_debt_account, so a company added after this migration gets one on first use.';

-- Backfill every company that exists now. Direct insert rather than through the
-- function above, because the migration runs as postgres and has no tenant
-- claim for assert_same_company to check.
insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side,
   system_key, active, system_account, is_control)
select c.id, '2700', 'Unearned Revenue', 'liability', 'credit',
       'unearned_revenue', true, true, false
  from public.companies c
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.system_key = 'unearned_revenue'
 );

-- ---------------------------------------------------------------------------
-- Step 2. The posting. Arrears unchanged; advance defers.
-- ---------------------------------------------------------------------------
create or replace function public.post_invoice_journal(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  inv       record;
  v_gross   numeric;
  v_tax     numeric;
  v_revenue numeric;
  v_rev_key text;
  v_date    date;
begin
  -- tenant guard [resolved]: owning company looked up from p_invoice_id via public.invoices (0242)
  if p_invoice_id is not null then perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id)); end if;

  select * into inv from public.invoices where id = p_invoice_id;
  if not found then return; end if;

  v_date    := coalesce(inv.period_start, inv.invoice_date);
  v_gross   := inv.invoice_amount;
  v_tax     := coalesce(inv.tax_added_total, 0);
  v_revenue := v_gross - v_tax;

  v_rev_key := 'revenue_security';
  begin
    select case when c.client_type = 'guard_deployment' then 'revenue_guard' else 'revenue_security' end
      into v_rev_key
      from public.clients c where c.id = inv.client_id;
  exception when others then null;
  end;

  -- 0323. ADVANCE: the invoice is raised before the month it bills for.
  -- Only the deferral is a fact today. The revenue belongs to period_start and
  -- is posted by recognise_advance_revenue() when that month arrives — writing
  -- it now would post into a period nobody has reached, which 0322 refuses.
  if inv.period_start is not null and inv.invoice_date < inv.period_start then
    perform public.ensure_unearned_revenue_account(inv.company_id);

    perform public.post_journal(
      inv.company_id, inv.invoice_date,
      'Invoice ' || coalesce(inv.invoice_number, inv.id::text) || ' (billed in advance)',
      'invoices', inv.id, false,
      jsonb_build_array(
        jsonb_build_object('key', 'ar', 'debit', v_gross, 'credit', 0,
                           'client_id', inv.client_id, 'contract_id', inv.contract_id),
        jsonb_build_object('key', 'unearned_revenue', 'debit', 0, 'credit', v_revenue,
                           'client_id', inv.client_id, 'contract_id', inv.contract_id),
        jsonb_build_object('key', 'sales_tax_payable', 'debit', 0, 'credit', v_tax,
                           'client_id', inv.client_id)
      ),
      inv.branch_id
    );
    return;
  end if;

  -- ARREARS and same-day: byte-identical to the pre-0323 behaviour.
  perform public.post_journal(
    inv.company_id, v_date,
    'Invoice ' || coalesce(inv.invoice_number, inv.id::text),
    'invoices', inv.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ar', 'debit', v_gross, 'credit', 0,
                         'client_id', inv.client_id, 'contract_id', inv.contract_id),
      jsonb_build_object('key', v_rev_key, 'debit', 0, 'credit', v_revenue,
                         'client_id', inv.client_id, 'contract_id', inv.contract_id),
      jsonb_build_object('key', 'sales_tax_payable', 'debit', 0, 'credit', v_tax,
                         'client_id', inv.client_id)
    ),
    inv.branch_id
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Step 3. The recognition run.
-- ---------------------------------------------------------------------------
create or replace function public.recognise_advance_revenue(
  p_company_id uuid,
  p_period date default null
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  inv       record;
  v_period  date;
  v_rev_key text;
  v_revenue numeric;
  v_done    int := 0;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  v_period := date_trunc('month', coalesce(p_period, current_date))::date;

  -- Refuse a period that has not been reached, here and by name. 0322 would
  -- refuse the posting anyway, but a caller deserves to be told what it asked
  -- for was impossible rather than reading a trigger's message.
  if v_period > date_trunc('month', current_date)::date then
    raise exception
      'Cannot recognise revenue for %, a period that has not been reached yet. Revenue is recognised when its service month arrives, not before. [recognise_advance_revenue]',
      to_char(v_period, 'FMMonth YYYY')
      using errcode = 'P0001';
  end if;

  for inv in
    select i.*
      from public.invoices i
     where i.company_id = p_company_id
       and i.period_start is not null
       and i.invoice_date < i.period_start
       and date_trunc('month', i.period_start)::date = v_period
       -- Not already recognised. The deferral entry carries NO revenue line, so
       -- a revenue line against this invoice is the marker that recognition has
       -- happened. Idempotent by construction rather than by a flag column
       -- somebody has to remember to set.
       and not exists (
         select 1
           from public.journal_entries je
           join public.journal_lines jl on jl.journal_entry_id = je.id
           join public.chart_of_accounts a on a.id = jl.account_id
          where je.source_table = 'invoices'
            and je.source_id = i.id
            and a.account_type = 'revenue'
            and not je.is_reversal
       )
     order by i.period_start, i.invoice_number
  loop
    v_revenue := inv.invoice_amount - coalesce(inv.tax_added_total, 0);
    if v_revenue = 0 then continue; end if;

    v_rev_key := 'revenue_security';
    begin
      select case when c.client_type = 'guard_deployment' then 'revenue_guard' else 'revenue_security' end
        into v_rev_key
        from public.clients c where c.id = inv.client_id;
    exception when others then null;
    end;

    perform public.post_journal(
      inv.company_id, inv.period_start,
      'Revenue recognised — invoice ' || coalesce(inv.invoice_number, inv.id::text),
      'invoices', inv.id, false,
      jsonb_build_array(
        jsonb_build_object('key', 'unearned_revenue', 'debit', v_revenue, 'credit', 0,
                           'client_id', inv.client_id, 'contract_id', inv.contract_id),
        jsonb_build_object('key', v_rev_key, 'debit', 0, 'credit', v_revenue,
                           'client_id', inv.client_id, 'contract_id', inv.contract_id)
      ),
      inv.branch_id
    );
    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$fn$;

comment on function public.recognise_advance_revenue(uuid, date) is
  '0323: posts Dr Unearned Revenue / Cr Revenue for advance invoices whose service month is p_period (default: the current month). Refuses a future period. Idempotent — an invoice with a revenue line already posted is skipped.';

grant execute on function public.recognise_advance_revenue(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Proof.
--
-- Everything below writes and is rolled back by a deliberate exception.
-- 0321 taught this the hard way: changing a source row makes the app reverse
-- and repost its journal entry, so a compensating write is another event and
-- the ledger records it. Unwind through the transaction, never by an undo.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_co       uuid;
  v_client   uuid;
  v_branch   uuid;
  v_inv      uuid;
  v_outcome  text;
  v_missing  int;
  v_ar       numeric;
  v_unearned numeric;
  v_rev      numeric;
  v_n        int;
  v_before   int;
  v_after    int;
  v_start    date := date_trunc('month', current_date)::date;
  v_svc      date := greatest(date_trunc('month', current_date)::date + 1, current_date);
begin
  -- Every company has the account.
  select count(*) into v_missing
    from public.companies c
   where not exists (select 1 from public.chart_of_accounts a
                      where a.company_id = c.id and a.system_key = 'unearned_revenue');
  if v_missing <> 0 then
    raise exception '0323 FAILED: % companies have no unearned_revenue account', v_missing;
  end if;

  -- A company that actually has clients, so the fixture is not company-blind.
  -- 0296 passed everywhere it was written by selecting rows it did not create.
  select i.company_id into v_co
    from public.invoices i group by i.company_id order by count(*) desc limit 1;
  if v_co is null then
    raise exception '0323 FAILED: no company has invoices, so nothing below is exercised';
  end if;
  select id, branch_id into v_client, v_branch
    from public.clients where company_id = v_co order by created_at limit 1;
  if v_client is null then
    raise exception '0323 FAILED: the chosen company has no client to invoice';
  end if;

  -- The probe bills a service date LATER IN THE CURRENT MONTH, so the invoice
  -- is advance-shaped (invoice_date < period_start) while period_start still
  -- falls in a period that has been reached — otherwise 0322 would refuse the
  -- recognition entry and this proof would be testing 0322, not 0323.
  if v_svc <= v_start then
    raise exception '0323 FAILED: today is the first of the month, so no advance shape fits inside the current period; re-run this proof on any other day';
  end if;

  begin
    insert into public.invoices
      (company_id, client_id, invoice_number, invoice_date, period_start, period_end,
       invoice_amount, tax_added_total, amount_received, status, notes, branch_id)
    values
      (v_co, v_client, '0323-PROBE', v_start, v_svc, v_svc,
       1000, 0, 0, 'Pending', '0323 probe', v_branch)
    returning id into v_inv;

    -- (a) the deferral, and ONLY the deferral.
    select coalesce(sum(jl.debit) filter (where a.system_key = 'ar'), 0),
           coalesce(sum(jl.credit) filter (where a.system_key = 'unearned_revenue'), 0),
           coalesce(sum(jl.credit) filter (where a.account_type = 'revenue'), 0)
      into v_ar, v_unearned, v_rev
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'invoices' and je.source_id = v_inv;

    if v_ar <> 1000 then
      raise exception '0323 FAILED: advance invoice debited AR % , expected 1000', v_ar;
    end if;
    if v_unearned <> 1000 then
      raise exception '0323 FAILED: advance invoice credited unearned revenue %, expected 1000', v_unearned;
    end if;
    if v_rev <> 0 then
      raise exception '0323 FAILED: advance invoice recognised % of revenue at invoice_date; it must recognise none', v_rev;
    end if;

    -- (b) the recognition run posts it, once.
    v_n := public.recognise_advance_revenue(v_co, v_svc);
    if v_n <> 1 then
      raise exception '0323 FAILED: recognition run posted % entries, expected 1', v_n;
    end if;

    select coalesce(sum(jl.credit) filter (where a.account_type = 'revenue'), 0),
           coalesce(sum(jl.debit) filter (where a.system_key = 'unearned_revenue'), 0)
      into v_rev, v_unearned
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'invoices' and je.source_id = v_inv;
    if v_rev <> 1000 or v_unearned <> 1000 then
      raise exception '0323 FAILED: after recognition revenue is % and unearned relieved is %, expected 1000 and 1000', v_rev, v_unearned;
    end if;

    -- (c) idempotent. A second run must post nothing, or a monthly job would
    -- recognise the same revenue every time it ran.
    v_n := public.recognise_advance_revenue(v_co, v_svc);
    if v_n <> 0 then
      raise exception '0323 FAILED: the recognition run is not idempotent — a second pass posted % entries', v_n;
    end if;

    raise exception 'PROBE_ROLLBACK';
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome <> 'PROBE_ROLLBACK' then
    raise exception '0323 FAILED (advance path): %', v_outcome;
  end if;

  -- (d) ARREARS IS UNTOUCHED. Re-post an existing arrears invoice and require
  -- the same account/amount shape as before: a revenue line at period_start and
  -- NO unearned revenue anywhere.
  select count(*) into v_before
    from public.journal_entries je
    join public.journal_lines jl on jl.journal_entry_id = je.id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.source_table = 'invoices' and a.system_key = 'unearned_revenue';
  if v_before <> 0 then
    raise exception '0323 FAILED: % existing invoice lines already touch unearned revenue before any advance invoice exists', v_before;
  end if;

  select count(*) into v_after
    from public.invoices i
   where i.period_start is not null and i.invoice_date > i.period_start;
  if v_after = 0 then
    raise exception '0323 FAILED: no arrears invoice exists, so the unchanged path was never exercised';
  end if;

  raise notice '0323 OK: advance defers and recognises once, % arrears invoices unaffected', v_after;
end
$proof$;
