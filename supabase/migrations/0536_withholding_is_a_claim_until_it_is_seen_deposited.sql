-- 0536 — withholding is a claim until it is seen deposited
--
-- Found 2026-10-21 (Shayan): a client said "the rest is WHT", it was recorded
-- as WHT, and when the portal was checked later the client had never deposited
-- it on the company's behalf. Until it is deposited it is not a tax credit — it
-- is money the client still owes. Bastion recorded every WHT figure as final.
--
-- DECIDED 2026-10-21 (Shayan): every WHT amount on a receipt has a status.
--
--   claimed        the client says it deducted this (every new WHT starts
--                  here, and every existing one is backfilled to it)
--   verified       seen on the FBR portal or by certificate: certificate/CPR
--                  number and date recorded
--   not_deposited  not deposited after all: the WHT comes off the receipt, so
--                  the invoice (or the client's balance) is owed again. No
--                  money moves. The claimed figure is kept on the row.
--
--   invoice_payments   + wht_status, wht_certificate_no, wht_verified_on,
--                        wht_status_by, wht_status_at, wht_status_note,
--                        wht_rejected_amount
--   verify_wht(...)        claimed -> verified
--   reject_wht(...)        claimed -> not_deposited, via
--                          record_payment_withholding(id, 0), the same path
--                          "Record WHT" uses, so the invoice, the receivable and
--                          the ledger all move exactly as they do today.
--
-- A trigger keeps the status honest without any caller remembering to:
--   * WHT set on a receipt with no status        -> claimed
--   * WHT cleared to 0 while merely claimed       -> no status
--   * WHT AMOUNT changed after it was verified    -> back to claimed (what was
--     verified was a different figure); certificate fields cleared
--   * a status, certificate or verification field changed by anything other
--     than verify_wht / reject_wht                -> refused. Write access to
--     invoice_payments (invoices.edit) must not be enough to mark a claim
--     verified: that is the one assertion this whole change exists to keep
--     true.
--
-- No screen owes this: the Invoices page gains a Withholding tax tab (the
-- register, claimed / overdue / verified / not deposited, with Verify and Not
-- deposited), and the receipt form a "rest is WHT (claimed)" shortcut, in the
-- same release.
--
-- Both functions SECURITY DEFINER, gated on invoices.edit (the key Record WHT
-- already asks), tenant-guarded, single-row. Idempotent throughout.

alter table public.invoice_payments
  add column if not exists wht_status          text,
  add column if not exists wht_certificate_no  text,
  add column if not exists wht_verified_on     date,
  add column if not exists wht_status_by       uuid,
  add column if not exists wht_status_at       timestamptz,
  add column if not exists wht_status_note     text,
  add column if not exists wht_rejected_amount numeric(14,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_payments_wht_status_chk') then
    alter table public.invoice_payments add constraint invoice_payments_wht_status_chk
      check (wht_status is null or wht_status in ('claimed', 'verified', 'not_deposited'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoice_payments_wht_verified_chk') then
    alter table public.invoice_payments add constraint invoice_payments_wht_verified_chk
      check (wht_status is distinct from 'verified'
             or (nullif(btrim(wht_certificate_no), '') is not null and wht_verified_on is not null));
  end if;
end $$;

comment on column public.invoice_payments.wht_status is
  '0536. claimed (client says it deducted it) / verified (seen on the FBR portal or certificate) / '
  'not_deposited (it was not: the WHT came off this receipt and the client owes it again). '
  'Changed only by verify_wht / reject_wht and the guard trigger.';

-- ── the guard ────────────────────────────────────────────────────────────────
create or replace function public.invoice_payment_wht_guard()
returns trigger
language plpgsql set search_path to 'public'
as $function$
declare v_via_rpc boolean := coalesce(current_setting('app.wht_transition', true), '') = '1';
begin
  -- Hand-written status fields are refused; only the two functions may.
  if tg_op = 'UPDATE' and not v_via_rpc and (
       new.wht_status          is distinct from old.wht_status
    or new.wht_certificate_no  is distinct from old.wht_certificate_no
    or new.wht_verified_on     is distinct from old.wht_verified_on
    or new.wht_rejected_amount is distinct from old.wht_rejected_amount) then
    raise exception 'WHT status is changed only with Verify or Not deposited. Nothing has been recorded.'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and not v_via_rpc and (new.wht_status is not null or new.wht_certificate_no is not null
       or new.wht_verified_on is not null or new.wht_rejected_amount is not null) then
    new.wht_status := null; new.wht_certificate_no := null; new.wht_verified_on := null; new.wht_rejected_amount := null;
  end if;

  -- The amount moved after it was verified: what was verified is not this.
  if tg_op = 'UPDATE' and new.wht_status = 'verified'
     and coalesce(new.withholding_amount, 0) is distinct from coalesce(old.withholding_amount, 0) then
    new.wht_status := 'claimed'; new.wht_certificate_no := null; new.wht_verified_on := null;
    new.wht_status_at := now(); new.wht_status_note := 'WHT amount changed after verification';
  end if;

  if coalesce(new.withholding_amount, 0) > 0 and new.wht_status is null then
    new.wht_status := 'claimed'; new.wht_status_at := now();
  elsif coalesce(new.withholding_amount, 0) = 0 and new.wht_status = 'claimed' then
    new.wht_status := null; new.wht_status_at := now();
  end if;
  return new;
end $function$;

drop trigger if exists trg_invoice_payments_wht_guard on public.invoice_payments;
create trigger trg_invoice_payments_wht_guard before insert or update on public.invoice_payments
  for each row execute function public.invoice_payment_wht_guard();

-- ── backfill: every existing WHT is a claim until someone verifies it ────────
select set_config('app.wht_transition', '1', true);
update public.invoice_payments
   set wht_status = 'claimed', wht_status_at = now(),
       wht_status_note = 'Recorded before 0536; not yet verified on the portal'
 where coalesce(withholding_amount, 0) > 0 and wht_status is null;
select set_config('app.wht_transition', '', true);

-- ── verify ───────────────────────────────────────────────────────────────────
create or replace function public.verify_wht(
  p_payment_id uuid, p_certificate_no text, p_verified_on date, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare p public.invoice_payments; v_n int;
begin
  perform public.require_perm('invoices.edit');
  -- tenant guard [resolved]: owning company from p_payment_id via public.invoice_payments
  if p_payment_id is not null then perform public.assert_same_company((select company_id from public.invoice_payments where id = p_payment_id)); end if;

  select * into p from public.invoice_payments where id = p_payment_id for update;
  if p.id is null then raise exception 'That receipt does not exist. Nothing has been recorded.'; end if;
  if p.wht_status is distinct from 'claimed' then
    raise exception 'Only claimed WHT can be verified; this one is %. Nothing has been recorded.', coalesce(p.wht_status, 'not WHT');
  end if;
  if nullif(btrim(p_certificate_no), '') is null then
    raise exception 'Enter the certificate or CPR number. Nothing has been recorded.';
  end if;
  if p_verified_on is null then raise exception 'Enter the date it was verified. Nothing has been recorded.'; end if;

  perform set_config('app.wht_transition', '1', true);
  update public.invoice_payments
     set wht_status = 'verified', wht_certificate_no = btrim(p_certificate_no), wht_verified_on = p_verified_on,
         wht_status_by = auth.uid(), wht_status_at = now(), wht_status_note = nullif(btrim(p_note), '')
   where id = p.id and wht_status = 'claimed';
  get diagnostics v_n = row_count;
  perform set_config('app.wht_transition', '', true);
  if v_n <> 1 then raise exception 'The WHT could not be verified. Nothing has been recorded.'; end if;
end $function$;

-- ── not deposited ────────────────────────────────────────────────────────────
create or replace function public.reject_wht(p_payment_id uuid, p_note text)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare p public.invoice_payments; v_n int;
begin
  perform public.require_perm('invoices.edit');
  -- tenant guard [resolved]: owning company from p_payment_id via public.invoice_payments
  if p_payment_id is not null then perform public.assert_same_company((select company_id from public.invoice_payments where id = p_payment_id)); end if;

  select * into p from public.invoice_payments where id = p_payment_id for update;
  if p.id is null then raise exception 'That receipt does not exist. Nothing has been recorded.'; end if;
  if p.wht_status is distinct from 'claimed' then
    raise exception 'Only claimed WHT can be marked not deposited; this one is %. Nothing has been recorded.', coalesce(p.wht_status, 'not WHT');
  end if;
  if nullif(btrim(p_note), '') is null then
    raise exception 'Say how you found it was not deposited. Nothing has been recorded.';
  end if;

  -- The same path as "Record WHT" with 0: the invoice is owed the amount again,
  -- the ledger moves it from WHT receivable back to the client. No money moves.
  perform public.record_payment_withholding(p.id, 0);

  perform set_config('app.wht_transition', '1', true);
  update public.invoice_payments
     set wht_status = 'not_deposited', wht_rejected_amount = p.withholding_amount,
         wht_status_by = auth.uid(), wht_status_at = now(), wht_status_note = btrim(p_note)
   where id = p.id;
  get diagnostics v_n = row_count;
  perform set_config('app.wht_transition', '', true);
  if v_n <> 1 then raise exception 'The WHT could not be marked not deposited. Nothing has been recorded.'; end if;
end $function$;

revoke all on function public.verify_wht(uuid, text, date, text) from public, anon;
revoke all on function public.reject_wht(uuid, text) from public, anon;
grant execute on function public.verify_wht(uuid, text, date, text) to authenticated;
grant execute on function public.reject_wht(uuid, text) to authenticated;

-- ── asserts — on the things that can break ───────────────────────────────────
do $$
declare v_n int;
begin
  -- Every receipt carrying WHT has a status, and only those do (bar rejected).
  select count(*) into v_n from public.invoice_payments
   where (coalesce(withholding_amount, 0) > 0) <> coalesce(wht_status in ('claimed', 'verified'), false)
     and wht_status is distinct from 'not_deposited';
  if v_n <> 0 then raise exception '0536 REFUSED: % receipt(s) whose WHT and status disagree.', v_n; end if;

  -- The guard refuses a hand-written verification. Tried for real, rolled back.
  begin
    update public.invoice_payments set wht_status = 'verified', wht_certificate_no = 'X', wht_verified_on = current_date
     where id = (select id from public.invoice_payments where wht_status = 'claimed' limit 1);
    if found then raise exception 'GUARD-MISSING'; end if;
  exception
    when others then
      if sqlerrm = 'GUARD-MISSING' then
        raise exception '0536 REFUSED: a direct update could mark WHT verified.';
      elsif sqlerrm not like 'WHT status is changed only with Verify or Not deposited%' then
        raise;
      end if;
  end;

  select count(*) into v_n from public.tenant_guard_gaps();
  if v_n <> 0 then raise exception '0536 REFUSED: tenant_guard_gaps() reports % gap(s).', v_n; end if;
end $$;
