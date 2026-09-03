-- 0357 — an invoice is primary or supplementary.
--
-- THE CASE. A rate increase approved on the 7th, backdated to August, billed in
-- September. Service month August, raised in September, revenue recognised in
-- August, and the ORIGINAL AUGUST INVOICE IS UNTOUCHED — it was right when it
-- was issued. This is not a correction, and treating it as one would reverse a
-- document that was correct and reissue it, destroying the record of what the
-- client was actually billed at the time.
--
-- THE RULE. `uq_invoice_contract_month` applies to PRIMARIES ONLY: one primary
-- per contract per month, any number of supplementaries against it, each linked
-- to its original and carrying a reason.
--
-- ===========================================================================
-- THE AUDIT, AS ASKED: WHAT ELSE ASSUMES ONE INVOICE PER CONTRACT PER MONTH
-- ===========================================================================
--
-- Every reader of that assumption was checked, not just the three named.
--
-- 1. THE UNIQUE INDEX itself — uq_invoice_contract_month, from 0113:
--       (contract_id, date_trunc('month', coalesce(period_start, invoice_date)))
--       where contract_id is not null
--    A second invoice for the same contract-month is refused outright today, so
--    NOTHING downstream has ever had to cope with two. Rebuilt below with
--    `and invoice_kind = 'primary'`.
--
-- 2. run_auto_invoices — DEDUPES by contract-month before inserting. It must
--    keep doing exactly that: the generator raises PRIMARIES, and a contract
--    that already has one this month must not get a second. A supplementary is
--    always a deliberate human act, never generated. Left ALONE deliberately —
--    its dedupe is correct for primaries and would be wrong if widened.
--
-- 3. InvoiceGenerate.tsx — the same dedupe in the UI:
--       invoices.some(i => i.contract_id === con.id && invoiceMonth(i) === period)
--    This is what decides whether a contract shows as "draftable" or "already
--    generated". If a SUPPLEMENTARY made a contract look already-invoiced, the
--    month's primary could never be raised. Fixed in the frontend to count
--    primaries only.
--
-- 4. post_invoice_journal — reads period_start to date revenue. Indifferent to
--    how many invoices a contract has; each posts its own revenue at its own
--    service month, which is exactly right for a backdated supplementary.
--    NO CHANGE NEEDED, and that is the finding rather than an omission.
--
-- 5. recognise_advance_revenue — keyed on the invoice, not the contract-month.
--    Same conclusion. NO CHANGE NEEDED.
--
-- 6. AGING / receivables — reads invoices individually with their own due
--    dates. A supplementary ages from its own date, which is correct: it was
--    issued later and is due later.
--
-- 7. ITEM 5's COMPLETENESS CHECK — built in 0358, and this is why the brief
--    says a supplementary alone does not count as invoiced. A month with only
--    a supplementary has no primary, which means the month was never billed and
--    the supplementary is adjusting something that does not exist.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'invoice_kind') then
    create type public.invoice_kind as enum ('primary', 'supplementary');
  end if;
end $$;

alter table public.invoices
  add column if not exists invoice_kind public.invoice_kind not null default 'primary',
  add column if not exists supplements_invoice_id uuid references public.invoices(id) on delete restrict,
  add column if not exists supplementary_reason text;

comment on column public.invoices.invoice_kind is
  '0357: primary = the month''s invoice for the contract, one only (uq_invoice_contract_month). supplementary = an additional bill against that month, e.g. a backdated rate increase. NOT a correction: the primary stays exactly as issued because it was right at the time.';
comment on column public.invoices.supplements_invoice_id is
  '0357: the primary this supplements. Required on a supplementary, forbidden on a primary. ON DELETE RESTRICT — deleting a primary that has supplementaries would orphan them.';
comment on column public.invoices.supplementary_reason is
  '0357: why this supplementary exists. Required, because "there are two invoices for August" is a question somebody will ask.';

alter table public.invoices drop constraint if exists invoices_supplementary_shape;
alter table public.invoices add constraint invoices_supplementary_shape check (
  (invoice_kind = 'primary'
     and supplements_invoice_id is null and supplementary_reason is null)
  or
  (invoice_kind = 'supplementary'
     and supplements_invoice_id is not null
     and supplementary_reason is not null and length(btrim(supplementary_reason)) >= 10)
);

-- ---------------------------------------------------------------------------
-- The uniqueness rule becomes primary-only.
-- ---------------------------------------------------------------------------
drop index if exists public.uq_invoice_contract_month;
create unique index uq_invoice_contract_month
  on public.invoices (contract_id, date_trunc('month', coalesce(period_start, invoice_date)::timestamp))
  where contract_id is not null and invoice_kind = 'primary';

comment on index public.uq_invoice_contract_month is
  '0113/0357: ONE PRIMARY per contract per service month. Supplementaries are deliberately outside it — any number may be raised against a month, each linked to its primary.';

-- ---------------------------------------------------------------------------
-- A supplementary must belong to the SAME contract and the SAME service month
-- as the primary it supplements. Without this, "supplementary" becomes a way to
-- attach any invoice to any other and the uniqueness rule is bypassed rather
-- than exempted.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_supplementary_matches_primary()
returns trigger
language plpgsql
as $fn$
declare p record;
begin
  if new.invoice_kind <> 'supplementary' then
    return new;
  end if;

  select id, contract_id, client_id, invoice_kind,
         date_trunc('month', coalesce(period_start, invoice_date))::date as m
    into p
    from public.invoices where id = new.supplements_invoice_id;

  if not found then
    raise exception 'The invoice this supplements does not exist.' using errcode = 'P0001';
  end if;
  if p.invoice_kind <> 'primary' then
    raise exception
      'A supplementary must supplement a PRIMARY invoice, not another supplementary. Link it to the month''s original.'
      using errcode = 'P0001';
  end if;
  if p.contract_id is distinct from new.contract_id then
    raise exception
      'A supplementary must be on the same contract as the invoice it supplements.'
      using errcode = 'P0001';
  end if;
  if p.client_id is distinct from new.client_id then
    raise exception
      'A supplementary must be for the same client as the invoice it supplements.'
      using errcode = 'P0001';
  end if;
  if p.m is distinct from date_trunc('month', coalesce(new.period_start, new.invoice_date))::date then
    raise exception
      'A supplementary must carry the SAME service month as the invoice it supplements (%). A backdated rate increase is billed in the month it is raised but SERVED in the original month — set period_start, not invoice_date.',
      to_char(p.m, 'FMMonth YYYY')
      using errcode = 'P0001';
  end if;

  return new;
end;
$fn$;

comment on function public.enforce_supplementary_matches_primary() is
  '0357: a supplementary must share its primary''s contract, client and SERVICE month, and must supplement a primary rather than another supplementary. Without this, the kind column would be a way around uq_invoice_contract_month instead of a documented exception to it.';

drop trigger if exists trg_supplementary_matches_primary on public.invoices;
create trigger trg_supplementary_matches_primary
  before insert or update on public.invoices
  for each row execute function public.enforce_supplementary_matches_primary();

create index if not exists invoices_supplements_idx
  on public.invoices (supplements_invoice_id)
  where supplements_invoice_id is not null;

-- ---------------------------------------------------------------------------
-- Probe.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid := (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD');
  v_cl uuid; v_ct uuid; v_p uuid; v_msg text;
begin
  if v_co is null then raise notice '0357: GGS absent; probe skipped.'; return; end if;
  select c.id, c.client_id into v_ct, v_cl
    from public.contracts c join public.clients cl on cl.id = c.client_id
   where cl.company_id = v_co limit 1;
  if v_ct is null then raise notice '0357: no contract to probe; skipped.'; return; end if;

  begin
    insert into public.invoices (company_id, client_id, contract_id, invoice_number, invoice_date, period_start,
                                 invoice_amount, status)
    values (v_co, v_cl, v_ct, 'PROBE-0357-P', '2026-08-05', '2026-08-01', 1000, 'Unpaid')
    returning id into v_p;

    -- A second PRIMARY for the same contract-month must still be refused.
    begin
      insert into public.invoices (company_id, client_id, contract_id, invoice_number, invoice_date, period_start,
                                 invoice_amount, status)
      values (v_co, v_cl, v_ct, 'PROBE-0357-P2', '2026-08-20', '2026-08-01', 500, 'Unpaid');
      raise exception '0357 FAILED: a second PRIMARY for the same contract-month was accepted.';
    exception when others then
      v_msg := sqlerrm;
      if v_msg like '0357 FAILED%' then raise; end if;
    end;

    -- A supplementary for the same month, raised in September, IS allowed.
    insert into public.invoices (company_id, client_id, contract_id, invoice_number, invoice_date, period_start,
                                 invoice_amount, status, invoice_kind,
                                 supplements_invoice_id, supplementary_reason)
    values (v_co, v_cl, v_ct, 'PROBE-0357-S1', '2026-09-07', '2026-08-01', 250, 'Unpaid', 'supplementary',
            v_p, 'Rate increase approved 7 Sept, backdated to August');

    -- And a SECOND supplementary, because any number are permitted.
    insert into public.invoices (company_id, client_id, contract_id, invoice_number, invoice_date, period_start,
                                 invoice_amount, status, invoice_kind,
                                 supplements_invoice_id, supplementary_reason)
    values (v_co, v_cl, v_ct, 'PROBE-0357-S2', '2026-09-09', '2026-08-01', 90, 'Unpaid', 'supplementary',
            v_p, 'Second adjustment, also backdated to August');

    -- A supplementary carrying a DIFFERENT service month must be refused.
    begin
      insert into public.invoices (company_id, client_id, contract_id, invoice_number, invoice_date, period_start,
                                 invoice_amount, status, invoice_kind,
                                 supplements_invoice_id, supplementary_reason)
      values (v_co, v_cl, v_ct, 'PROBE-0357-S3', '2026-09-10', '2026-09-01', 10, 'Unpaid', 'supplementary',
              v_p, 'Wrong service month, should be refused');
      raise exception '0357 FAILED: a supplementary with a different service month was accepted.';
    exception when others then
      v_msg := sqlerrm;
      if v_msg like '0357 FAILED%' then raise; end if;
      if v_msg not like '%SAME service month%' then
        raise exception '0357 FAILED: wrong refusal for a mismatched service month — got %', v_msg;
      end if;
    end;

    -- A supplementary with no reason must be refused.
    begin
      insert into public.invoices (company_id, client_id, contract_id, invoice_number, invoice_date, period_start,
                                   invoice_amount, status, invoice_kind, supplements_invoice_id)
      values (v_co, v_cl, v_ct, 'PROBE-0357-S4', '2026-09-11', '2026-08-01', 10, 'Unpaid', 'supplementary', v_p);
      raise exception '0357 FAILED: a supplementary with no reason was accepted.';
    exception when others then
      v_msg := sqlerrm;
      if v_msg like '0357 FAILED%' then raise; end if;
    end;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0357: probe passed — one primary, many supplementaries, same month, reason required.';
  end;
end $$;
