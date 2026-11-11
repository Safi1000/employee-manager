-- 0659 — tax deducted can be added to any receipt, and a receipt part can be moved to the right invoice
--
-- Found 11 Nov 2026 (Shayan): "after we have added any payment it doesn't let
-- me add tax to it if a cheque is cleared multiple clients like Emaar and
-- Dolmen have small payments in receivables but in actuality it is WHT that
-- they deducted." Two causes:
--   * "Add tax deducted" (record_payment_withholding) works on ONE payment
--     row. A receipt is split oldest-first into one row per invoice it
--     settles, and an older invoice with a small leftover — which is usually
--     the tax they deducted — is exactly what makes a receipt split. So the
--     button disappeared precisely when it was needed.
--   * Once a receipt has been applied to the leftover, the tax cannot be added
--     to the older payment either: the older invoice is already full.
-- Emaar, measured: September GGS-26-EMR-09 4,776,650 was paid 4,762,762 on 13
-- Oct with no tax recorded (13,888 left — their tax). The 9 Nov receipt,
-- 4,765,002 + 22,540 tax = exactly October GGS/EPK/10/26 (4,787,542), was split
-- 13,822.61 + 65.39 tax onto September and the rest onto October, so October
-- shows 13,888 open.
--
-- The change (neither function moves money; both only re-point what was
-- received and what was withheld):
--   1. set_receipt_withholding(payment ids, total tax) — the tax deducted on a
--      whole receipt, spread over its rows oldest invoice first, each row taking
--      only what its invoice has room for (a standalone row takes the rest).
--      Refuses if the receipt's invoices cannot hold that much tax.
--   2. move_receipt_part(payment, invoice) — re-points one payment row to
--      another invoice of the SAME client, with room for it. The client's AR is
--      posted per client, not per invoice (journal_on_invoice_payment), so the
--      ledger does not move; the two invoices' amount_received do.
-- Both need invoices.edit, like record_payment_withholding. Rows are amended
-- in place, so journal_on_invoice_payment re-posts a row whose tax changed and
-- the WHT-status guard re-opens a verified certificate whose amount moved.
-- invoices.amount_received changes on a closed-month invoice are already
-- allowed by the period lock (0253); payment rows keep their own dates.
--
-- Asserted on what can break, on Emaar inside a block rolled back by a
-- sentinel: moving the 9 Nov September part onto October and recording 13,888
-- tax on the 13 Oct payment leaves BOTH invoices with nothing outstanding, the
-- AR and WHT-receivable controls still green, and the receipt's total tax
-- unchanged; set_receipt_withholding then refuses one rupee more than the
-- receipt's invoices can hold. (The first dry run found that two rows on one
-- invoice could both take its room; the room is now read row by row.)

create or replace function public.move_receipt_part(p_payment_id uuid, p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  ip public.invoice_payments; v_from public.invoices; v_to public.invoices; v_n int; v_settle numeric;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('invoices.edit'); end if;
  if p_payment_id is not null then
    perform public.assert_same_company((select company_id from public.invoice_payments where id = p_payment_id));
  end if;
  if p_invoice_id is not null then
    perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id));
  end if;

  select * into ip from public.invoice_payments where id = p_payment_id for update;
  if ip.id is null then raise exception 'That payment does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(ip.branch_id);
  if ip.invoice_id is not distinct from p_invoice_id then return; end if;

  select * into v_to from public.invoices where id = p_invoice_id for update;
  if v_to.id is null then raise exception 'That invoice does not exist. Nothing has been recorded.'; end if;
  if v_to.client_id is distinct from coalesce(ip.client_id, (select client_id from public.invoices where id = ip.invoice_id)) then
    raise exception 'A payment can only be moved to another invoice of the same client. Nothing has been recorded.';
  end if;

  v_settle := ip.amount + coalesce(ip.withholding_amount, 0);
  if v_to.amount_received + v_settle > v_to.invoice_amount + 0.0001 then
    raise exception 'Invoice % has % left to settle; this payment settles %. Nothing has been recorded.',
      coalesce(v_to.invoice_number, '?'), round(v_to.invoice_amount - v_to.amount_received, 2), round(v_settle, 2)
      using errcode = '23514';
  end if;

  if ip.invoice_id is not null then
    update public.invoices set amount_received = amount_received - v_settle, updated_at = now() where id = ip.invoice_id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'The old invoice could not be adjusted. Nothing has been recorded.'; end if;
  end if;
  update public.invoices set amount_received = amount_received + v_settle, updated_at = now() where id = v_to.id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The new invoice could not be adjusted. Nothing has been recorded.'; end if;

  update public.invoice_payments set invoice_id = v_to.id where id = ip.id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The payment could not be moved. Nothing has been recorded.'; end if;
end $function$;
comment on function public.move_receipt_part(uuid, uuid) is
  '0659: re-point one payment row to another invoice of the same client (no money moves; AR is per client).';
revoke all on function public.move_receipt_part(uuid, uuid) from public, anon;
grant execute on function public.move_receipt_part(uuid, uuid) to authenticated;

create or replace function public.set_receipt_withholding(p_payment_ids uuid[], p_withholding numeric)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record; v_left numeric; v_give numeric; v_room numeric; v_n int; v_company uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('invoices.edit'); end if;
  if p_payment_ids is null or cardinality(p_payment_ids) = 0 then
    raise exception 'Choose the receipt. Nothing has been recorded.';
  end if;
  if p_withholding is null or p_withholding < 0 then
    raise exception 'Tax deducted cannot be negative. Nothing has been recorded.' using errcode = '23514';
  end if;
  select min(ip.company_id::text)::uuid into v_company from public.invoice_payments ip where ip.id = any (p_payment_ids);
  perform public.assert_same_company(v_company);
  if exists (select 1 from public.invoice_payments ip where ip.id = any (p_payment_ids) and ip.company_id <> v_company) then
    raise exception 'Those payments are not one receipt. Nothing has been recorded.';
  end if;
  if (select count(*) from public.invoice_payments where id = any (p_payment_ids)) <> cardinality(p_payment_ids) then
    raise exception 'A payment in that receipt no longer exists. Nothing has been recorded.';
  end if;

  -- First take every row's tax off its invoice, so the room below is real.
  for r in select ip.id, ip.invoice_id, ip.branch_id, coalesce(ip.withholding_amount, 0) as w
             from public.invoice_payments ip where ip.id = any (p_payment_ids) for update loop
    perform public.assert_branch_writable(r.branch_id);
    if r.w <> 0 and r.invoice_id is not null then
      update public.invoices set amount_received = amount_received - r.w, updated_at = now() where id = r.invoice_id;
    end if;
  end loop;

  -- Then give it back, oldest invoice first, each only what its invoice can hold.
  v_left := round(p_withholding, 2);
  for r in select ip.id, ip.invoice_id
             from public.invoice_payments ip left join public.invoices i on i.id = ip.invoice_id
            where ip.id = any (p_payment_ids)
            order by (ip.invoice_id is null), i.invoice_date, ip.created_at loop
    if r.invoice_id is null then
      v_give := v_left;                          -- a standalone receipt settles the client's balance
    else
      -- Read the room NOW: two rows of one receipt can sit on the same invoice,
      -- and the first row's share has already been added (caught by the dry run).
      select greatest(i.invoice_amount - i.amount_received, 0) into v_room
        from public.invoices i where i.id = r.invoice_id;
      v_give := least(v_left, v_room);
      if v_give > 0 then
        update public.invoices set amount_received = amount_received + v_give, updated_at = now() where id = r.invoice_id;
      end if;
    end if;
    update public.invoice_payments set withholding_amount = v_give where id = r.id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'A payment could not be amended. Nothing has been recorded.'; end if;
    v_left := v_left - v_give;
  end loop;

  if v_left > 0.005 then
    raise exception 'The invoices this receipt settles have room for only % of tax; % does not fit. Move the receipt to the right invoice first. Nothing has been recorded.',
      round(p_withholding - v_left, 2), round(v_left, 2) using errcode = '23514';
  end if;
end $function$;
comment on function public.set_receipt_withholding(uuid[], numeric) is
  '0659: the tax deducted on a whole receipt, spread over its rows oldest invoice first within each invoice''s room.';
revoke all on function public.set_receipt_withholding(uuid[], numeric) from public, anon;
grant execute on function public.set_receipt_withholding(uuid[], numeric) to authenticated;

do $mig$
declare
  v_co uuid; v_sept uuid := '9365fecc-b096-4af7-8976-483393f10de3'; v_oct uuid := '2ad8a105-67b3-426e-84ba-be33b31c1150';
  v_p13oct uuid := '48910d9b-cf6e-466a-863f-336bc0b5a533';
  v_p9nov_sept uuid := 'b6fbd5c3-c0d5-47f9-8572-eacf2903e14c'; v_p9nov_oct uuid := '7a6775de-bcc5-4692-a737-9727ebe3085a';
  v_msg text; v_ok boolean := false; v_ar0 numeric; v_ar1 numeric; v_wht0 numeric; v_wht1 numeric;
begin
  select company_id into v_co from public.invoices where id = v_sept;
  if v_co is null or (select invoice_id from public.invoice_payments where id = v_p9nov_sept) is distinct from v_sept then
    raise notice '0659: Emaar''s rows are no longer as measured; the rolled-back test is skipped.';
  else
    select c.difference into v_ar0 from public.ledger_checks_base(v_co) c where c.check_name = 'ar_control_equals_open_invoices';
    select c.difference into v_wht0 from public.ledger_checks_base(v_co) c where c.check_name = 'wht_receivable_equals_deductions_less_cprs';
    begin
      perform public.move_receipt_part(v_p9nov_sept, v_oct);
      update public.invoice_payments set withholding_amount = 13888 where id = v_p13oct;      -- what record_payment_withholding does to the row
      update public.invoices set amount_received = amount_received + 13888 where id = v_sept;  -- and to its invoice
      if (select round(outstanding, 2) from public.invoices where id = v_sept) <> 0
         or (select round(outstanding, 2) from public.invoices where id = v_oct) <> 0 then
        raise exception '0659 REFUSED: after the Emaar correction an invoice still shows something outstanding.';
      end if;
      if (select sum(withholding_amount) from public.invoice_payments where id in (v_p9nov_sept, v_p9nov_oct)) <> 22540 then
        raise exception '0659 REFUSED: the 9 Nov receipt''s tax is no longer 22,540 after the move.';
      end if;
      select c.difference into v_ar1 from public.ledger_checks_base(v_co) c where c.check_name = 'ar_control_equals_open_invoices';
      select c.difference into v_wht1 from public.ledger_checks_base(v_co) c where c.check_name = 'wht_receivable_equals_deductions_less_cprs';
      if abs(coalesce(v_ar1, 0)) > abs(coalesce(v_ar0, 0)) + 0.005 or abs(coalesce(v_wht1, 0)) > abs(coalesce(v_wht0, 0)) + 0.005 then
        raise exception '0659 REFUSED: the AR or WHT control is further from passing after the correction (AR % -> %, WHT % -> %).', v_ar0, v_ar1, v_wht0, v_wht1;
      end if;
      -- the receipt's tax can be restated, and one rupee more is refused.
      perform public.set_receipt_withholding(array[v_p9nov_sept, v_p9nov_oct], 22540);
      begin
        perform public.set_receipt_withholding(array[v_p9nov_sept, v_p9nov_oct], 22541);
        v_msg := '0659_NOT_REFUSED';
      exception when others then v_msg := sqlerrm;
      end;
      if v_msg not like 'The invoices this receipt settles have room for only 22540.00 of tax; 1.00 does not fit.%' then
        raise exception '0659 REFUSED: over-full tax was not refused with its own message; got: %', v_msg;
      end if;
      v_ok := true;
      raise exception '0659_SENTINEL';
    exception when others then
      if sqlerrm <> '0659_SENTINEL' then raise; end if;
    end;
    if not v_ok then raise exception '0659 REFUSED: the rolled-back test did not complete.'; end if;
  end if;

  if exists (select 1 from public.security_gaps()) then raise exception '0659 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0659 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $mig$;