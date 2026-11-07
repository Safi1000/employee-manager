-- 0646 — reviewing a payment is not editing it: the period lock lets the
-- review stamps on invoice_payments change in a closed month.
--
-- Shayan, 7 Nov 2026: marking Tiges MZD's 23 Sep payment "Genuine" (0640's
-- duplicate check) failed with "Period for 2026-09-23 is closed. New / edited
-- transactions in a closed month are not allowed" — September was closed on
-- 5 Nov. enforce_period_lock carries a carve-out list of columns that may
-- change in a closed month for payslips, invoices, advances, expenses and
-- cheques, and NONE for invoice_payments, so any UPDATE of a September
-- payment was refused — including stamps that move no money and post nothing.
-- confirm_cash_custody (also 0640) had the same trap waiting for the first
-- custodian to confirm cash dated in a closed month.
--
-- The carve-out added here is ONLY those stamps:
--   duplicate_ok_by, duplicate_ok_at                      — "it was a genuine second payment"
--   custody_status, custody_decided_by/_at, custody_note  — the custodian's confirmation
--   notes                                                 — annotation, as for every other table
-- Amount, date, mode, accounts, client, invoice and tax stay locked exactly as
-- before. The INSERT carve-out for invoice_payments stays deliberately absent (0237).
--
-- enforce_period_lock has many authors (0237, 0253, 0255, 0269, 0310, 0322),
-- so this is surgery on the live text, each anchor asserted to appear once.

do $surgery$
declare
  v_def text := pg_get_functiondef('public.enforce_period_lock'::regproc);
  a1 constant text := E'  v_open     text[];\n';
  a2 constant text := $a$when 'cheques'  then c_cheque_open$a$;
  n int;
begin
  n := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  if n <> 1 then raise exception '0646 REFUSED: the v_open declaration in enforce_period_lock appears % times, expected once.', n; end if;
  n := (length(v_def) - length(replace(v_def, a2, ''))) / length(a2);
  if n <> 1 then raise exception '0646 REFUSED: the cheques arm in enforce_period_lock appears % times, expected once.', n; end if;
  if position('c_payment_open' in v_def) > 0 then
    raise exception '0646 REFUSED: enforce_period_lock already has a payment carve-out — something changed it since this was written.';
  end if;
  v_def := replace(v_def, a1, $r$  -- invoice_payments: review stamps only — they move no money and post nothing. 0646.
  c_payment_open constant text[] := array[
    'notes', 'duplicate_ok_by', 'duplicate_ok_at',
    'custody_status', 'custody_decided_by', 'custody_decided_at', 'custody_note'
  ];
$r$ || a1);
  v_def := replace(v_def, a2, a2 || $r$
                when 'invoice_payments' then c_payment_open$r$);
  execute v_def;
end
$surgery$;

-- ───────────────────────── Tests (rolled back) ─────────────────────────
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_pay  uuid;
  v_msg text; v_ran int := 0;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    -- Any payment in a closed month that is still unreviewed.
    select ip.id into v_pay from public.invoice_payments ip
     where public.is_period_closed(ip.company_id, ip.payment_date) and ip.duplicate_ok_at is null
     order by ip.payment_date desc limit 1;
    if v_pay is null then raise exception '0646 REFUSED: no unreviewed payment in a closed month to test with.'; end if;

    -- 1. The review stamp goes through in a closed month.
    update public.invoice_payments set duplicate_ok_by = v_boss, duplicate_ok_at = now() where id = v_pay;
    v_ran := v_ran + 1;

    -- 2. The money does not: an amount change is still refused, in the lock's own words.
    v_msg := null;
    begin update public.invoice_payments set amount = amount + 1 where id = v_pay;
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like 'Period for % is closed. New / edited transactions in a closed month are not allowed%' then
      raise exception '0646 REFUSED: changing a closed-month payment''s amount was not refused by the lock (%).', coalesce(v_msg, 'no error');
    end if;
    v_ran := v_ran + 1;

    -- 3. Nor does the date.
    v_msg := null;
    begin update public.invoice_payments set payment_date = payment_date + 1 where id = v_pay;
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like '%is closed%' then
      raise exception '0646 REFUSED: moving a closed-month payment''s date was not refused (%).', coalesce(v_msg, 'no error');
    end if;
    v_ran := v_ran + 1;

    perform set_config('request.jwt.claims', '{}', true);
    if v_ran <> 3 then raise exception '0646 REFUSED: % of 3 assertions ran.', v_ran; end if;
    raise exception '0646-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0646-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0646 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0646 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
