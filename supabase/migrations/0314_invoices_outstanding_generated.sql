-- 0314 — outstanding becomes a column, so the frontend reads it instead of
-- recomputing it.
--
-- WHY A GENERATED COLUMN RATHER THAN A VIEW OR A FUNCTION
--
-- The frontend had NINE open-coded copies of this expression, eight of which
-- subtracted withholding_tax and disagreed with the ledger. They were deleted
-- and routed through one helper, and scripts/check-outstanding.mjs now fails
-- when a tenth appears. That is DETECTION.
--
-- This is PREVENTION, and it is the better half. A stored generated column
-- means the number arrives with the row. There is no second implementation to
-- diverge, because there is no second implementation: `select *` already
-- carries it into every loader that computes outstanding today
-- (Accounting.tsx:624, Invoices.tsx:217 — both `select("*")`, checked).
--
-- A view would have needed every caller repointed. A function would have needed
-- every caller to remember to call it. A column needs nobody to remember
-- anything, which is the property that survives the next developer.
--
-- GROSS, per A1 and 0221. invoice_amount less amount_received:
--
--   NOT total_due  — that is the invoice DOCUMENT total and carries the
--                    client's arrears, so summing it double-counts them (0313)
--   NOT less withholding_tax — outstanding is gross of withholding (A1)
--
-- Both columns are NOT NULL DEFAULT 0, so no coalesce is needed and the
-- expression is total. Checked on crm-design before writing this.
--
-- STORED rather than VIRTUAL because Postgres only supports STORED, and because
-- it can then be indexed if the aging queries ever need it.

alter table public.invoices
  add column if not exists outstanding numeric(16,2)
  generated always as (invoice_amount - amount_received) stored;

comment on column public.invoices.outstanding is
  'GROSS outstanding: invoice_amount - amount_received. Generated, so it cannot drift from its inputs and cannot be written. Read this instead of recomputing it — see 0314, A1 and 0221. Not total_due (0313) and not net of withholding_tax (A1).';

-- ---------------------------------------------------------------------------
-- PROOF
--
-- "Every row satisfies outstanding = invoice_amount - amount_received" is
-- VACUOUS for a generated column: the database computes it, so it cannot be
-- otherwise, and a check that cannot fail is indistinguishable from one that is
-- never evaluated (TENANT_GUARD_REPORT.md 9.6).
--
-- The property actually worth proving is that it TRACKS rather than snapshots —
-- that a payment moves it — and that it REFUSES to be written, because a column
-- that could be set by hand would be a second implementation with extra steps.
-- Both are exercised below against a real row, inside a subtransaction that is
-- rolled back by a deliberate raise.
-- ---------------------------------------------------------------------------

do $$
declare
  v_inv   uuid;
  v_amt   numeric;
  v_out0  numeric;
  v_out1  numeric;
  v_wrote boolean := false;
begin
  select id, invoice_amount, outstanding into v_inv, v_amt, v_out0
    from public.invoices
   where invoice_amount - amount_received > 1
   order by invoice_amount desc
   limit 1;

  if v_inv is null then
    raise notice '0314: no invoice with anything outstanding; proof skipped';
    return;
  end if;

  begin
    -- (a) it TRACKS: a receipt must move it, by exactly the receipt.
    update public.invoices set amount_received = amount_received + 100 where id = v_inv;
    select outstanding into v_out1 from public.invoices where id = v_inv;

    -- (b) it REFUSES to be written directly.
    begin
      execute 'update public.invoices set outstanding = 1 where id = $1' using v_inv;
      v_wrote := true;
    exception when others then
      v_wrote := false;
    end;

    raise exception 'ROLLBACK_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROOF' then
        raise exception '0314: the probe failed for the wrong reason: % %', sqlstate, sqlerrm;
      end if;
  end;

  if round(v_out0 - v_out1, 2) <> 100.00 then
    raise exception
      '0314: outstanding did not track a 100.00 receipt — moved from % to % (delta %)',
      v_out0, v_out1, round(v_out0 - v_out1, 2);
  end if;

  if v_wrote then
    raise exception '0314: outstanding accepted a direct write — it is not generated';
  end if;

  -- and it unwound
  select outstanding into v_out1 from public.invoices where id = v_inv;
  if v_out1 <> v_out0 then
    raise exception '0314: the probe did not unwind — outstanding is %, was %', v_out1, v_out0;
  end if;

  raise notice '0314: outstanding tracks (% -> % on a 100.00 receipt), refuses direct writes, and unwound',
    v_out0, v_out0 - 100;
end $$;
