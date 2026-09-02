-- 0326 — the auto-invoice generator writes down the month it is billing for.
--
-- A4 recognises revenue at the SERVICE MONTH: invoices.period_start. 0323 made
-- an invoice raised ahead of its service month defer revenue into
-- unearned_revenue and recognise it when that month arrives. 0324 added the
-- detector that refuses to guess: an invoice with revenue posted and no
-- period_start is REPORTED, not defaulted to invoice_date, because defaulting
-- would answer the question with a value nobody asserted (§9.18).
--
-- run_auto_invoices never wrote period_start. It has always known the month —
-- v_period is computed at the top of every loop iteration and used for the
-- invoice number, the duplicate test and the description — it simply was not
-- recording it. Every invoice it raises from here on would land in 0324's
-- report as "the invoice states no service month". The generator is the one
-- writer that can never be unsure of the answer, so it states it.
--
-- WHY THIS IS SURGERY AND 0325 WAS A RESTATEMENT. Both files touch the same
-- function; the difference is how many migrations have edited it. Before 0325,
-- run_auto_invoices had exactly one author and its full text lived in 0316, so
-- restating it discarded nothing. After 0325 it has two, and this file must
-- therefore amend the LIVE definition rather than state a body of its own —
-- otherwise the next migration inherits a function with three authors and no
-- canonical file, which is the position ledger_checks is already in.
--
-- The precondition asserts the body being amended is the shared one 0325
-- installed. If it is not, 0325 has not run here, or something else has edited
-- the function, and the anchor below would be landing somewhere unknown.
--
-- period_end is written too. All nine invoices on production carry both, so a
-- generator that filled one and left the other null would be introducing a
-- shape no existing row has.

-- ---------------------------------------------------------------------------
-- Surgery.
-- ---------------------------------------------------------------------------
do $surgery$
declare
  v_src text;
  v_digest text;
  v_hits int;
  v_anchor constant text :=
'    insert into public.invoices (
      company_id, client_id, contract_id, invoice_number, invoice_date, invoice_amount,
      amount_received, status, notes
    ) values (
      rec.company_id, rec.client_id, v_contract, inv_number, v_period, rec.auto_invoice_amount,
      0, ''Pending'',';
  v_new constant text :=
'    -- 0326: the service month is STATED, not inferred. v_period is the month
    -- being billed and always has been; leaving period_start null made every
    -- auto-issued invoice a finding in revenue_outside_service_month.
    insert into public.invoices (
      company_id, client_id, contract_id, invoice_number, invoice_date, invoice_amount,
      period_start, period_end,
      amount_received, status, notes
    ) values (
      rec.company_id, rec.client_id, v_contract, inv_number, v_period, rec.auto_invoice_amount,
      v_period, (v_period + interval ''1 month'' - interval ''1 day'')::date,
      0, ''Pending'',';
begin
  select md5(pg_get_functiondef('public.run_auto_invoices(date)'::regprocedure)),
         pg_get_functiondef('public.run_auto_invoices(date)'::regprocedure)
    into v_digest, v_src;

  if position('0326' in v_src) > 0 then
    raise notice '0326: already applied, leaving run_auto_invoices alone';
    return;
  end if;

  if v_digest <> '99fc7c74281ed31d3fe7b8f5506cc516' then
    raise exception
      '0326 FAILED: run_auto_invoices has digest %, not the shared body 99fc7c74... that 0325 installs. Apply 0325 first, or find out what edited this function — the anchor below would otherwise land somewhere unknown.',
      v_digest;
  end if;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      '0326 FAILED: the invoices insert anchor appears % times in run_auto_invoices, expected exactly 1 — do not guess where period_start belongs',
      v_hits;
  end if;

  v_src := replace(v_src, v_anchor, v_new);
  execute v_src;
end
$surgery$;

-- ---------------------------------------------------------------------------
-- Proof.
--
-- Not "the source now contains period_start" — that is reading, and 0316's own
-- header records what reading missed. The generator is RUN against a client
-- planted for the purpose, the invoice it raises is inspected, and 0324's
-- detector is asked whether it has anything to say about it. Then the whole
-- probe unwinds through the transaction (0321).
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_co       uuid;
  v_client   uuid;
  v_issued   int;
  v_inv      record;
  v_expected date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_findings int;
  v_outcome  text;
begin
  if position('0326' in pg_get_functiondef('public.run_auto_invoices(date)'::regprocedure)) = 0 then
    raise exception '0326 FAILED: the surgery did not land — run_auto_invoices carries no 0326 marker';
  end if;

  select c.id into v_co
    from public.companies c
    join public.clients cl on cl.company_id = c.id
   group by c.id
   order by count(*) desc
   limit 1;
  if v_co is null then
    raise exception '0326 FAILED: no company has any clients, so the generator was never exercised';
  end if;

  begin
    insert into public.clients (company_id, name, auto_invoice_enabled,
                                auto_invoice_amount, advance_payment)
    values (v_co, '0326 probe client', true, 4321, false)
    returning id into v_client;

    select public.run_auto_invoices(current_date) into v_issued;

    select i.id, i.invoice_date, i.period_start, i.period_end
      into v_inv
      from public.invoices i
     where i.client_id = v_client
     limit 1;

    if v_inv.id is null then
      raise exception
        '0326 FAILED: the generator issued % invoice(s) but none for the probe client', v_issued;
    end if;

    if v_inv.period_start is distinct from v_expected then
      raise exception
        '0326 FAILED: period_start is %, expected % — the month billed in arrears for a run on %',
        v_inv.period_start, v_expected, current_date;
    end if;

    if v_inv.period_end is distinct from
       (v_expected + interval '1 month' - interval '1 day')::date then
      raise exception
        '0326 FAILED: period_end is %, expected the last day of %',
        v_inv.period_end, to_char(v_expected, 'FMMonth YYYY');
    end if;

    -- The end of the chain: 0324 must have nothing to say about an invoice this
    -- generator raised. Before this migration it would have reported it as
    -- stating no service month.
    select count(*) into v_findings
      from public.revenue_outside_service_month(v_co) d
     where d.invoice_id = v_inv.id;
    if v_findings <> 0 then
      raise exception
        '0326 FAILED: revenue_outside_service_month reports % finding(s) against an invoice the generator just raised', v_findings;
    end if;

    raise exception 'PROBE_ROLLBACK';
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome <> 'PROBE_ROLLBACK' then
    raise exception '0326 FAILED (generator probe): %', v_outcome;
  end if;

  if exists (select 1 from public.clients where name = '0326 probe client') then
    raise exception '0326 FAILED: the probe client survived the rollback';
  end if;

  raise notice '0326 OK: auto-issued invoices state their service month, and 0324 is quiet about them';
end
$proof$;
