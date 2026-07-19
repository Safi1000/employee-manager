-- Fix the invoice posting so the trial balance can balance (spec section 4).
--
-- The bug (present since migration 0042): an invoice posted
--
--   DR ar           = amount - wht
--   CR revenue      = amount - wht
--   CR wht_payable  = wht        <- a credit with no matching debit
--
-- Debits totalled `net`, credits totalled `net + wht`. Every invoice carrying
-- withholding tax has been out of balance by exactly its WHT ever since, and
-- revenue was understated by the same amount. Section 4 cannot load an opening
-- trial balance on top of a ledger that keeps emitting unbalanced entries, so
-- this lands first.
--
-- The economics: the client withholds tax and remits it to FBR on our behalf.
-- We never owe that money to anyone — we have a tax credit we can claim. That
-- is an ASSET (prepaid/withheld tax), not a liability. Account 2200
-- "Withholding Tax Payable" stays for tax we genuinely owe (e.g. amounts we
-- withhold from vendors); it was simply the wrong account for this event.
--
-- Correct shape:
--
--   DR ar              = amount - wht   (what the client will actually pay us)
--   DR wht_receivable  = wht            (the tax credit, claimable)
--   CR revenue         = amount         (revenue at gross — the real figure)
--
-- Balances by construction, and revenue is no longer understated.

-- ---------------------------------------------------------------------------
-- 1. The new account, for every company.
-- ---------------------------------------------------------------------------

insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side,
   system_key, system_account, active)
select c.id, '1150', 'Withholding Tax Receivable', 'asset', 'debit',
       'wht_receivable', true, true
  from public.companies c
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.system_key = 'wht_receivable'
 );

-- ---------------------------------------------------------------------------
-- 2. Post invoices with the corrected shape.
--    Body is otherwise identical to migration 0074's version.
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_invoice()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_amt     numeric;
  v_wht     numeric;
  v_net     numeric;
  v_rev_key text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'invoices', old.id, old.invoice_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.invoice_amount is distinct from new.invoice_amount
       or coalesce(old.withholding_tax, 0) is distinct from coalesce(new.withholding_tax, 0)
       or old.branch_id is distinct from new.branch_id then
      perform public.reverse_journal_for_source(new.company_id, 'invoices', new.id, old.invoice_date);
    else
      return new;
    end if;
  end if;

  v_amt := new.invoice_amount;
  v_wht := coalesce(new.withholding_tax, 0);
  v_net := v_amt - v_wht;

  v_rev_key := 'revenue_security';
  begin
    select case when c.client_type = 'guard_deployment' then 'revenue_guard' else 'revenue_security' end
      into v_rev_key
    from public.clients c where c.id = new.client_id;
  exception when others then null;
  end;

  perform public.post_journal(
    new.company_id, new.invoice_date,
    'Invoice ' || coalesce(new.invoice_number, new.id::text),
    'invoices', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ar',             'debit', v_net, 'credit', 0),
      jsonb_build_object('key', 'wht_receivable', 'debit', v_wht, 'credit', 0),
      jsonb_build_object('key', v_rev_key,        'debit', 0,     'credit', v_amt)
    ),
    new.branch_id
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Restate the affected history.
--
-- Reverse-and-repost rather than editing the old lines in place: the wrong
-- entries were real postings, and a ledger records corrections, it does not
-- rewrite the past. Each affected invoice ends up with its original entry, a
-- mirrored reversal that nets it to zero, and a fresh correct entry.
--
-- Only invoices with WHT > 0 were ever wrong — the rest already balanced.
-- ---------------------------------------------------------------------------

do $$
declare
  r        record;
  v_rev    text;
  v_net    numeric;
  v_wht    numeric;
begin
  for r in
    select i.id, i.company_id, i.invoice_date, i.invoice_number, i.invoice_amount,
           i.withholding_tax, i.branch_id, c.client_type
      from public.invoices i
      left join public.clients c on c.id = i.client_id
     where coalesce(i.withholding_tax, 0) > 0
     order by i.invoice_date
  loop
    perform public.reverse_journal_for_source(
      r.company_id, 'invoices', r.id, r.invoice_date);

    v_wht := coalesce(r.withholding_tax, 0);
    v_net := r.invoice_amount - v_wht;
    v_rev := case when r.client_type = 'guard_deployment'
                  then 'revenue_guard' else 'revenue_security' end;

    perform public.post_journal(
      r.company_id, r.invoice_date,
      'Invoice ' || coalesce(r.invoice_number, r.id::text) || ' (WHT restatement)',
      'invoices', r.id, false,
      jsonb_build_array(
        jsonb_build_object('key', 'ar',             'debit', v_net, 'credit', 0),
        jsonb_build_object('key', 'wht_receivable', 'debit', v_wht, 'credit', 0),
        jsonb_build_object('key', v_rev,            'debit', 0,     'credit', r.invoice_amount)
      ),
      r.branch_id
    );
  end loop;
end$$;
