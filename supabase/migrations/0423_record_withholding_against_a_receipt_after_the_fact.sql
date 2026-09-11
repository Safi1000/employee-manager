-- 0423: record_payment_withholding() — set the withholding on a receipt that
-- has already been recorded.
--
-- WHY THIS EXISTS. Withholding is entered on the Record Payment form, at the
-- moment the receipt is written, and a client does not always tell you what
-- they deducted on the day they pay. When it is missed the receipt stands at
-- zero withholding for ever: the only way to fix it was a hand-written UPDATE,
-- and a hand-written UPDATE gets HALF of it right, which is worse than not
-- doing it at all. See below.
--
-- WHY A BARE UPDATE IS WRONG. `record_invoice_payment` settles an invoice by
-- cash AND withholding together — A1: the receivable is gross, and the client
-- keeping 103,989 for the FBR clears 103,989 of what they owe exactly as cash
-- would. So the insert moves `invoices.amount_received` by `amount + wht`.
-- Amending `invoice_payments.withholding_amount` alone therefore leaves the
-- invoice reading as under-received by precisely the tax that was withheld —
-- and nothing goes red, because both rows are individually well-formed. This
-- function moves the two in one transaction or moves neither.
--
-- WHAT IT DOES NOT TOUCH, DELIBERATELY:
--
--   * THE BANK / CASH BALANCE. No money moves when withholding is recorded —
--     the cash that arrived already arrived. `amount` is untouched here and so
--     is every balance. This is the one amendment on this table that is NOT a
--     money movement, which is why it does not go near `apply_money_delta`.
--   * THE GENERAL LEDGER. `journal_on_invoice_payment` already carries an arm
--     reading `coalesce(old.withholding_amount,0) is distinct from
--     coalesce(new.withholding_amount,0)` — it reverses the old entry and
--     reposts Dr settlement + Dr WHT receivable / Cr AR on the new figures. So
--     the UPDATE below is the whole GL instruction. Posting here as well would
--     double it.
--
-- SINGLE ROW, NAMED BY ID. The receipt is chosen by primary key, not by a
-- predicate, so the row-count assert makes a hidden row a REFUSAL rather than a
-- quietly smaller result. That is what makes SECURITY DEFINER acceptable here
-- (see the set-operation note in CLAUDE.md) — but the gate is still stated
-- inside the body rather than inherited.
--
-- PERMISSION. `invoices.edit`, matching `record_invoice_payment`: this amends a
-- receipt against an invoice, which is the same act at a later moment. No new
-- permission key, so nothing to add to PERMISSION_GROUPS / permission_keys.
--
-- TENANT GUARD. `p_payment_id` is the only uuid parameter and it is resolved,
-- not claimed. Note the shape of the assert below: the company is looked up
-- INSIDE the assert_same_company() call rather than passed as a variable read
-- earlier. That is not styling — tenant_guard_covered() matches the parameter
-- name within the call text, so a guard written as
-- `assert_same_company(v_company)` is a real guard that the DETECTOR CANNOT
-- SEE, and tenant_guard_gaps() would report this function as an open hole. The
-- guard has to be written in the form the checker reads, and the assertion at
-- the foot of this file is what proves it was.

create or replace function public.record_payment_withholding(
  p_payment_id  uuid,
  p_withholding numeric
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company      uuid;
  v_invoice      uuid;
  v_old          numeric;
  v_amount       numeric;
  v_delta        numeric;
  v_inv_amount   numeric;
  v_inv_received numeric;
  v_inv_number   text;
  v_n            int;
begin
  perform public.require_perm('invoices.edit');

  if p_withholding is null or p_withholding < 0 then
    raise exception 'Withholding amount cannot be negative'
      using errcode = '23514',
            hint = 'Pass 0 to clear the withholding on this receipt.';
  end if;

  select ip.company_id, ip.invoice_id, coalesce(ip.withholding_amount, 0), ip.amount
    into v_company, v_invoice, v_old, v_amount
  from public.invoice_payments ip
  where ip.id = p_payment_id
  for update;

  if v_company is null then
    raise exception 'Receipt not found'
      using errcode = '23514',
            hint = 'The receipt may have been deleted since this screen was loaded.';
  end if;
  -- tenant guard [resolved]: owning company looked up from p_payment_id via
  -- public.invoice_payments. Written inline so tenant_guard_gaps() can read it.
  perform public.assert_same_company(
    (select ip2.company_id from public.invoice_payments ip2 where ip2.id = p_payment_id));

  v_delta := p_withholding - v_old;
  if v_delta = 0 then
    return jsonb_build_object(
      'changed', false, 'withholding', p_withholding, 'delta', 0, 'invoice_id', v_invoice);
  end if;

  -- The invoice half. A standalone receipt (invoice_id null) settles the
  -- client's balance rather than a document, so there is nothing here to move —
  -- the receivables screen reads a standalone receipt as amount + withholding
  -- directly.
  if v_invoice is not null then
    select i.invoice_amount, i.amount_received, i.invoice_number
      into v_inv_amount, v_inv_received, v_inv_number
    from public.invoices i
    where i.id = v_invoice
    for update;

    if v_inv_received + v_delta > v_inv_amount + 0.0001 then
      raise exception
        'Withholding of % would settle more than invoice % is worth: % received of %',
        p_withholding, coalesce(v_inv_number, '?'),
        round(v_inv_received + v_delta, 2), round(v_inv_amount, 2)
        using errcode = '23514',
              hint = 'Check the figure the client deducted. A receipt cannot clear more than the invoice.';
    end if;

    update public.invoices
       set amount_received = amount_received + v_delta,
           updated_at = now()
     where id = v_invoice;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'Expected to settle exactly one invoice, settled %', v_n;
    end if;
  end if;

  update public.invoice_payments
     set withholding_amount = p_withholding
   where id = p_payment_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'Expected to amend exactly one receipt, amended %', v_n;
  end if;

  return jsonb_build_object(
    'changed', true,
    'withholding', p_withholding,
    'delta', v_delta,
    'invoice_id', v_invoice);
end;
$function$;

comment on function public.record_payment_withholding(uuid, numeric) is
  'Set the withholding on an already-recorded receipt, moving invoices.amount_received '
  'by the same delta in the same transaction (A1: the receivable is cleared by cash and '
  'withholding together). No balance moves — no cash arrives when withholding is recorded. '
  'The GL is reposted by journal_on_invoice_payment''s withholding arm, not here. '
  'DECIDED: gated on invoices.edit, the same key as record_invoice_payment.';

revoke all on function public.record_payment_withholding(uuid, numeric) from public;
grant execute on function public.record_payment_withholding(uuid, numeric) to authenticated;

-- Replay guard: this file is create-or-replace plus grants, all idempotent, and
-- it reads nothing it changes. Replaying it against an already-migrated
-- database is a no-op.
do $$
begin
  if to_regprocedure('public.record_payment_withholding(uuid, numeric)') is null then
    raise exception '0423 did not create record_payment_withholding';
  end if;
end;
$$;

-- The guard above is only as good as the detector's ability to read it. This
-- asserts the detector agrees — for this function and for every other one.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
