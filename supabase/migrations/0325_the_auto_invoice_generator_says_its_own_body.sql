-- 0325 — one body for run_auto_invoices, on both databases, stated outright.
--
-- WHY THIS FILE EXISTS INSTEAD OF A RE-APPLY OF 0316.
--
-- Dev's run_auto_invoices is the pre-0316 body: it still reads
-- clients.auto_invoice_withholding and still names its local variable
-- period_start, which the invoices.period_start COLUMN made ambiguous. 0316
-- fixed both, on production. Re-applying 0316 to dev was the obvious way to
-- close that gap and it was approved — but 0316 also restates ledger_checks
-- wholesale, rebuilding it from ledger_checks_base plus the nine checks that
-- existed when it was written. Dev's ledger_checks currently answers 27 checks
-- plus the canary, because 0304, 0310, 0312 and 0324 amended it afterwards.
-- Re-applying 0316 would have replaced 27 checks with 9, dropped the other
-- eighteen — including revenue_recognised_in_service_month, added the same
-- afternoon — and SUCCEEDED, with the canary agreeing with itself at 0316's
-- number. That is the 0286/0288 defect that 0318 had to repair.
--
-- The general rule, now in CLAUDE.md: a function edited by more than one
-- migration has no canonical file. No single file holds its true text, so it
-- can only be amended by surgery against the live definition; restating it
-- silently discards every edit since. run_auto_invoices is the other case —
-- exactly one author (0316), whose full text is in the repo — so it can be
-- restated safely, and this file restates that text and nothing else.
--
-- THE PRECONDITION IS THE POINT. Restating is only safe if the body being
-- replaced is one we recognise. Two are known, both measured today:
--
--   8662cf340ad824e8c501ade31f0434b5   dev, pre-0316         (2546 bytes)
--   99fc7c74281ed31d3fe7b8f5506cc516   production, post-0316 (2849 bytes)
--
-- Anything else means some third edit happened that nothing recorded, and this
-- migration would be discarding it — the very failure it was written to avoid.
-- So it refuses rather than proceeds. On production this file is a no-op it can
-- prove; on dev it is the reconciliation; anywhere else it stops.
--
-- WHAT IT DELIBERATELY DOES NOT CARRY. 0316 also set a comment on
-- invoices.withholding_tax. That comment is documentation, not the blocker, and
-- pulling it in would widen this file past the one thing it is for. Dev is
-- still missing 0316 and fifteen other migrations; that backlog is logged in
-- docs/LEDGER_DEPLOYMENT_PLAN.md and is not this file's business.

-- ---------------------------------------------------------------------------
-- Precondition.
-- ---------------------------------------------------------------------------
do $precondition$
declare
  v_digest text;
begin
  select md5(pg_get_functiondef(p.oid))
    into v_digest
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_auto_invoices';

  if v_digest is null then
    raise exception
      '0325 FAILED: public.run_auto_invoices does not exist. This migration replaces a body it recognises; it does not create one from nothing.';
  end if;

  if v_digest not in ('8662cf340ad824e8c501ade31f0434b5',
                      '99fc7c74281ed31d3fe7b8f5506cc516') then
    raise exception
      '0325 FAILED: run_auto_invoices has digest %, which is neither the known pre-0316 body (8662cf34...) nor the known post-0316 body (99fc7c74...). Something edited this function that nothing in the repo describes. Restating it now would discard that edit silently. Find out what it was first.',
      v_digest;
  end if;

  raise notice '0325: replacing run_auto_invoices, prior digest %', v_digest;
end
$precondition$;

-- ---------------------------------------------------------------------------
-- The body. Verbatim from 0316, which is where it was written and the only
-- migration that has ever written it.
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

-- ---------------------------------------------------------------------------
-- Proof.
--
-- Both databases must now hold the SAME body, and it must RUN. 0316's own
-- header records why reading is not enough here: the pre-0316 body was
-- unrunnable for any client with auto-invoicing on, and every read of it looked
-- fine. So the generator is executed against a client planted for the purpose,
-- and the probe unwinds through the transaction — never through a compensating
-- write (0321). next_invoice_number computes max+1 from the invoices table
-- rather than drawing from a sequence, so nothing survives the rollback.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_digest  text;
  v_co      uuid;
  v_client  uuid;
  v_issued  int;
  v_wht     numeric;
  v_outcome text;
begin
  select md5(pg_get_functiondef('public.run_auto_invoices(date)'::regprocedure))
    into v_digest;
  if v_digest <> '99fc7c74281ed31d3fe7b8f5506cc516' then
    raise exception
      '0325 FAILED: after the replace, run_auto_invoices has digest %, not the shared body 99fc7c74... — the two databases would still disagree', v_digest;
  end if;

  select c.id into v_co
    from public.companies c
    join public.clients cl on cl.company_id = c.id
   group by c.id
   order by count(*) desc
   limit 1;
  if v_co is null then
    raise exception '0325 FAILED: no company has any clients, so the generator was never exercised';
  end if;

  begin
    insert into public.clients (company_id, name, auto_invoice_enabled,
                                auto_invoice_amount, auto_invoice_withholding,
                                advance_payment)
    values (v_co, '0325 probe client', true, 12345, 999, false)
    returning id into v_client;

    -- If the pre-0316 body were still installed this call would raise
    -- "column reference period_start is ambiguous" and never reach the assert.
    select public.run_auto_invoices(current_date) into v_issued;

    if v_issued < 1 then
      raise exception
        '0325 FAILED: the generator issued nothing for a client set up to be invoiced, so nothing below was proved';
    end if;

    select i.withholding_tax into v_wht
      from public.invoices i
     where i.client_id = v_client
     order by i.invoice_date desc
     limit 1;

    if v_wht is null then
      raise exception '0325 FAILED: the generator issued % invoice(s) but none for the probe client', v_issued;
    end if;
    if v_wht <> 0 then
      raise exception
        '0325 FAILED: the invoice was raised with withholding_tax = % for a client whose auto_invoice_withholding is 999 — the pre-0316 behaviour is still in force. Withholding belongs to the receipt (A1).',
        v_wht;
    end if;

    raise exception 'PROBE_ROLLBACK';
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome <> 'PROBE_ROLLBACK' then
    raise exception '0325 FAILED (generator probe): %', v_outcome;
  end if;

  if exists (select 1 from public.clients where name = '0325 probe client') then
    raise exception '0325 FAILED: the probe client survived the rollback';
  end if;

  raise notice '0325 OK: run_auto_invoices holds the shared body, runs, and raises gross';
end
$proof$;
