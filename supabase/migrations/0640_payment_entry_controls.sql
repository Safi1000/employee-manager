-- 0640 — controls on entering client payments.
--
-- 4 Nov 2026: Mr. Ali Saadat's 72,000 cash of 5 Oct was entered twice — on
-- 6 Oct by Shayan and again on 2 Nov by Taha — and the second copy quietly
-- settled his October invoice and put 72,000 that never arrived into Shayan's
-- custody. Nothing compared it with what was already there: the second copy
-- went to the next open invoice, so no "more than the invoice" check fired.
-- Shayan: "what else check can we add … do what you think is right"; and "yes"
-- to the custodian confirming cash recorded into his custody.
--
--   1. A likely DUPLICATE — the same client already has a payment of the same
--      amount dated within 3 days — is refused unless the person gives a
--      reason. The reason and the flag are kept on the payment.
--   2. A BACK-DATED payment — dated more than 7 days before it is entered
--      (Pakistan time) — is refused without a reason, kept and flagged the
--      same way. Both raise an alert for the super admins.
--   3. CASH INTO SOMEONE ELSE'S CUSTODY is recorded as usual but marked
--      PENDING until the custodian confirms it (or, for a custodian with no
--      login, a super admin). "Not received" raises an alert. Recording it is
--      not held back: the balance moves as before, so the books never wait on
--      a confirmation, and every pending or disputed amount is visible.
--   4. POSSIBLE DUPLICATES already in the books are listed by
--      possible_duplicate_receipts() until each is marked genuine or reversed.
--
-- Enforcement is in a BEFORE INSERT trigger on invoice_payments, so it holds
-- whichever screen or function inserts the row. The screens pass the reason
-- through record_invoice_payment_checked(), which sets it for the transaction
-- and calls record_invoice_payment unchanged — that function has many authors
-- and is not restated. A server-side insert with no signed-in user (a
-- migration, a maintenance repair) is not checked.

alter table public.invoice_payments
  add column entry_reason       text,
  add column entry_flags        text[] not null default '{}',
  add column entered_by         uuid default auth.uid(),
  add column custody_status     text not null default 'confirmed'
                                check (custody_status in ('confirmed', 'pending', 'disputed')),
  add column custody_decided_by uuid,
  add column custody_decided_at timestamptz,
  add column custody_note       text,
  add column duplicate_ok_by    uuid,
  add column duplicate_ok_at    timestamptz;
comment on column public.invoice_payments.entry_flags is
  '0640: what the entry checks found when the payment was entered — duplicate (same client, same amount, dated within 3 days of one already recorded) and/or backdated (dated more than 7 days before entry). entry_reason holds the reason given to save it anyway.';
comment on column public.invoice_payments.custody_status is
  '0640: for cash recorded into a custodian''s keeping by someone else — pending until the custodian (or a super admin, when the custodian has no login) confirms it; disputed if they say it was not received. Payments before 0640, and cash the custodian entered themselves, are confirmed.';

-- ───────────────────────── Who holds a cash location ─────────────────────────
create or replace function public._cash_location_login(p_location uuid)
returns uuid
language sql stable security definer set search_path = public
as $fn$
  -- 0640. The OFFICE login of the person who holds this cash, if they have one.
  -- A field-app login (site_supervisor) never counts: it cannot open the web,
  -- so cash waiting on it would wait for ever (Shayan's EMP-0178 field login is
  -- the only one linked to his employee record). No office login → super admins confirm.
  select coalesce(l.custodian_user_id,
                  (select p.id from public.profiles p
                    where p.employee_id = l.custodian_employee_id and coalesce(p.user_type, '') <> 'site_supervisor'
                    order by p.created_at limit 1))
    from public.cash_locations l where l.id = p_location
$fn$;
revoke all on function public._cash_location_login(uuid) from public, anon, authenticated;

-- ───────────────────────── The checks, at insert ─────────────────────────
create or replace function public.guard_invoice_payment_entry()
returns trigger
language plpgsql security definer set search_path = public
as $fn$
declare
  v_client uuid;
  v_reason text := nullif(btrim(coalesce(current_setting('app.payment_entry_reason', true), '')), '');
  v_flags  text[] := '{}';
  v_dup    record;
  v_days   int;
  v_name   text;
begin
  -- 0640. Only what a signed-in person enters is checked.
  if auth.uid() is null or public.is_maintenance_session() then return new; end if;

  v_client := coalesce(new.client_id, (select i.client_id from public.invoices i where i.id = new.invoice_id));
  select q.amount, q.payment_date, q.created_at,
         (select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = q.entered_by) as who
    into v_dup
    from public.invoice_payments q
   where q.client_id = v_client and q.amount = new.amount
     and abs(q.payment_date - new.payment_date) <= 3
     and q.created_at < now()          -- not another part of this same receipt
   order by q.created_at desc limit 1;
  if found then v_flags := v_flags || 'duplicate'::text; end if;

  v_days := (now() at time zone 'Asia/Karachi')::date - new.payment_date;
  if v_days > 7 then v_flags := v_flags || 'backdated'::text; end if;

  if cardinality(v_flags) > 0 and coalesce(length(v_reason), 0) < 5 then
    select name into v_name from public.clients where id = v_client;
    if 'duplicate' = any(v_flags) then
      raise exception 'ENTRY CHECK: % already has a payment of PKR % dated % (entered % by %). If this is a second payment, give a reason to save it.',
        coalesce(v_name, 'This client'), to_char(v_dup.amount, 'FM999,999,999,990'), to_char(v_dup.payment_date, 'DD Mon YYYY'),
        to_char(v_dup.created_at at time zone 'Asia/Karachi', 'DD Mon'), coalesce(v_dup.who, 'someone')
        using errcode = 'P0001';
    end if;
    raise exception 'ENTRY CHECK: this payment is dated % (% days ago). Give a reason for entering it late.',
      to_char(new.payment_date, 'DD Mon YYYY'), v_days using errcode = 'P0001';
  end if;

  new.entry_flags := v_flags;
  new.entry_reason := case when cardinality(v_flags) > 0 then v_reason end;
  new.entered_by := auth.uid();

  -- Pending unless the person entering is the one who would confirm it: the
  -- custodian's office login, or a super admin where the custodian has none.
  if new.payment_mode = 'Cash' and new.custodian_location_id is not null
     and not (public._cash_location_login(new.custodian_location_id) is not distinct from auth.uid()
              or (public._cash_location_login(new.custodian_location_id) is null
                  and public.current_role()::text in ('super_admin', 'super_super_admin'))) then
    new.custody_status := 'pending';
  end if;
  return new;
end
$fn$;
create trigger trg_invoice_payment_entry_guard before insert on public.invoice_payments
  for each row execute function public.guard_invoice_payment_entry();

create or replace function public.alert_invoice_payment_entry()
returns trigger
language plpgsql security definer set search_path = public
as $fn$
declare v_msg text;
begin
  -- 0640. A payment saved past a check tells the super admins once.
  select coalesce(c.name, 'A client') || ': PKR ' || to_char(new.amount, 'FM999,999,999,990') || ' dated '
         || to_char(new.payment_date, 'DD Mon YYYY') || ' was entered by '
         || coalesce((select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = new.entered_by), 'someone')
         || ' as ' || array_to_string(new.entry_flags, ' and ') || ' — reason: ' || coalesce(new.entry_reason, '—')
    into v_msg from public.clients c where c.id = new.client_id;
  perform public.raise_alert(new.company_id, 'warning', 'receivables', v_msg, 'invoice_payments', new.id, new.branch_id);
  return new;
end
$fn$;
create trigger trg_invoice_payment_entry_alert after insert on public.invoice_payments
  for each row when (cardinality(new.entry_flags) > 0) execute function public.alert_invoice_payment_entry();

-- ───────────────────────── What the screens call ─────────────────────────
create or replace function public.payment_entry_warnings(p_client_id uuid, p_amount numeric, p_payment_date date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $fn$
declare v_dups jsonb; v_days int;
begin
  -- 0640. What the entry checks would say, before saving — read only.
  if not public.has_perm('invoices.edit') then raise exception 'permission denied: invoices.edit required' using errcode = '42501'; end if;
  -- tenant guard [resolved]: owning company looked up from p_client_id via public.clients
  perform public.assert_same_company((select company_id from public.clients where id = p_client_id));
  select coalesce(jsonb_agg(jsonb_build_object(
           'amount', q.amount, 'payment_date', q.payment_date,
           'entered_on', (q.created_at at time zone 'Asia/Karachi')::date,
           'entered_by', (select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = q.entered_by),
           'invoice', (select i.invoice_number from public.invoices i where i.id = q.invoice_id))
         order by q.created_at desc), '[]'::jsonb)
    into v_dups
    from public.invoice_payments q
   where q.client_id = p_client_id and q.amount = p_amount and abs(q.payment_date - p_payment_date) <= 3;
  v_days := (now() at time zone 'Asia/Karachi')::date - p_payment_date;
  return jsonb_build_object('duplicates', v_dups, 'backdated_days', case when v_days > 7 then v_days else 0 end);
end
$fn$;
revoke all on function public.payment_entry_warnings(uuid, numeric, date) from public, anon;
grant execute on function public.payment_entry_warnings(uuid, numeric, date) to authenticated;

-- INVOKER on purpose: it only carries the reason into the transaction and calls
-- record_invoice_payment, which does every permission and company check itself.
create or replace function public.record_invoice_payment_checked(
  p_invoice_id uuid, p_amount numeric, p_payment_date date, p_payment_mode text, p_bank_account_id uuid, p_notes text,
  p_withholding numeric default null, p_custodian_location_id uuid default null, p_client_id uuid default null,
  p_entry_reason text default null)
returns jsonb
language plpgsql security invoker set search_path = public
as $fn$
begin
  perform set_config('app.payment_entry_reason', coalesce(p_entry_reason, ''), true);
  return public.record_invoice_payment(p_invoice_id, p_amount, p_payment_date, p_payment_mode, p_bank_account_id, p_notes,
                                       p_withholding, p_custodian_location_id, p_client_id);
end
$fn$;
revoke all on function public.record_invoice_payment_checked(uuid, numeric, date, text, uuid, text, numeric, uuid, uuid, text) from public, anon;
grant execute on function public.record_invoice_payment_checked(uuid, numeric, date, text, uuid, text, numeric, uuid, uuid, text) to authenticated;
comment on function public.record_invoice_payment_checked(uuid, numeric, date, text, uuid, text, numeric, uuid, uuid, text) is
  '0640: record_invoice_payment with the reason for saving a likely duplicate or a back-dated payment. The checks themselves are the trigger on invoice_payments.';

-- ───────────────────────── Custodians confirm cash ─────────────────────────
create or replace function public.cash_awaiting_confirmation()
returns table(payment_id uuid, client_name text, invoice_number text, amount numeric, payment_date date,
              entered_on date, entered_by text, custodian text, can_confirm boolean)
language sql stable security definer set search_path = public
as $fn$
  -- 0640. Cash recorded into someone's keeping by someone else, not yet confirmed.
  -- A custodian sees their own; a super admin sees all, and confirms for those with no login.
  select p.id, c.name, i.invoice_number, p.amount, p.payment_date,
         (p.created_at at time zone 'Asia/Karachi')::date,
         (select coalesce(nullif(btrim(pr.full_name), ''), pr.email) from public.profiles pr where pr.id = p.entered_by),
         l.name,
         (public._cash_location_login(l.id) = auth.uid()
          or (public._cash_location_login(l.id) is null and public.current_role()::text in ('super_admin', 'super_super_admin')))
    from public.invoice_payments p
    join public.cash_locations l on l.id = p.custodian_location_id
    join public.clients c on c.id = p.client_id
    left join public.invoices i on i.id = p.invoice_id
   where p.custody_status = 'pending'
     and p.company_id = public.current_company_id()
     and (public._cash_location_login(l.id) = auth.uid()
          or public.current_role()::text in ('super_admin', 'super_super_admin')
          or public.has_perm('invoices.edit'))
   order by p.created_at
$fn$;
revoke all on function public.cash_awaiting_confirmation() from public, anon;
grant execute on function public.cash_awaiting_confirmation() to authenticated;

create or replace function public.confirm_cash_custody(p_payment_id uuid, p_received boolean, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $fn$
declare p record; v_holder uuid; v_n int;
begin
  -- tenant guard [resolved]: owning company looked up from p_payment_id via public.invoice_payments
  perform public.assert_same_company((select company_id from public.invoice_payments where id = p_payment_id));
  perform public.assert_branch_writable((select branch_id from public.invoice_payments where id = p_payment_id));
  select ip.*, c.name as client_name, l.name as custodian_name into p
    from public.invoice_payments ip
    join public.cash_locations l on l.id = ip.custodian_location_id
    join public.clients c on c.id = ip.client_id
   where ip.id = p_payment_id;
  if p.id is null then raise exception 'That payment does not exist.'; end if;
  if p.custody_status <> 'pending' then raise exception 'That cash is already %.', p.custody_status; end if;
  v_holder := public._cash_location_login(p.custodian_location_id);
  -- The custodian confirms; a super admin only where the custodian has no login.
  if not (v_holder = auth.uid()
          or (v_holder is null and public.current_role()::text in ('super_admin', 'super_super_admin') and public.has_perm('invoices.edit'))) then
    raise exception 'Only % can confirm cash recorded into their keeping.', p.custodian_name using errcode = '42501';
  end if;
  if not p_received and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Say what happened — the note is how the office follows it up.';
  end if;
  update public.invoice_payments
     set custody_status = case when p_received then 'confirmed' else 'disputed' end,
         custody_decided_by = auth.uid(), custody_decided_at = now(), custody_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_payment_id and custody_status = 'pending';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'Expected to update one payment, updated %', v_n; end if;
  if not p_received then
    perform public.raise_alert(p.company_id, 'warning', 'receivables',
      p.custodian_name || ' says cash of PKR ' || to_char(p.amount, 'FM999,999,999,990') || ' from ' || p.client_name
      || ' dated ' || to_char(p.payment_date, 'DD Mon YYYY') || ' was not received: ' || btrim(p_note),
      'invoice_payments', p.id, p.branch_id);
  end if;
end
$fn$;
revoke all on function public.confirm_cash_custody(uuid, boolean, text) from public, anon;
grant execute on function public.confirm_cash_custody(uuid, boolean, text) to authenticated;

-- ───────────────────────── Duplicates already in the books ─────────────────────────
create or replace function public.possible_duplicate_receipts()
returns table(payment_id uuid, earlier_id uuid, client_name text, amount numeric,
              payment_date date, earlier_date date, entered_on date, earlier_entered_on date,
              entered_by text, earlier_entered_by text, invoice_number text, earlier_invoice text)
language sql stable security definer set search_path = public
as $fn$
  -- 0640. Two payments from one client of the same amount dated within 3 days,
  -- the later not yet marked genuine (or saved past the check with a reason).
  select b.id, a.id, c.name, b.amount, b.payment_date, a.payment_date,
         (b.created_at at time zone 'Asia/Karachi')::date, (a.created_at at time zone 'Asia/Karachi')::date,
         (select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = b.entered_by),
         (select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = a.entered_by),
         (select i.invoice_number from public.invoices i where i.id = b.invoice_id),
         (select i.invoice_number from public.invoices i where i.id = a.invoice_id)
    from public.invoice_payments b
    join public.invoice_payments a
      on a.client_id = b.client_id and a.amount = b.amount and a.id <> b.id
     and abs(a.payment_date - b.payment_date) <= 3
     and (a.created_at, a.id) < (b.created_at, b.id)
    join public.clients c on c.id = b.client_id
   where b.company_id = public.current_company_id()
     and (public.has_perm('invoices.view') or public.has_perm('invoices.edit') or public.has_perm('accountant.view'))
     and b.duplicate_ok_at is null
     and not ('duplicate' = any(b.entry_flags) and b.entry_reason is not null)
   order by b.created_at desc
$fn$;
revoke all on function public.possible_duplicate_receipts() from public, anon;
grant execute on function public.possible_duplicate_receipts() to authenticated;

create or replace function public.mark_receipt_not_duplicate(p_payment_id uuid)
returns void
language plpgsql security definer set search_path = public
as $fn$
declare v_n int;
begin
  perform public.require_perm('invoices.edit');
  -- tenant guard [resolved]: owning company looked up from p_payment_id via public.invoice_payments
  perform public.assert_same_company((select company_id from public.invoice_payments where id = p_payment_id));
  perform public.assert_branch_writable((select branch_id from public.invoice_payments where id = p_payment_id));
  update public.invoice_payments set duplicate_ok_by = auth.uid(), duplicate_ok_at = now()
   where id = p_payment_id and duplicate_ok_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'That payment is not waiting to be checked.'; end if;
end
$fn$;
revoke all on function public.mark_receipt_not_duplicate(uuid) from public, anon;
grant execute on function public.mark_receipt_not_duplicate(uuid) to authenticated;

-- ───────────────────────── Tests (rolled back) ─────────────────────────
-- On Mr. Ali Saadat's open October invoice (GGS-26-MAND-11, 72,000 owed).
-- Shayan holds the "Shayan Ahmed" cash; Taha holds "Taha Bin Arshad".
do $test$
declare
  v_boss   constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_taha   constant uuid := '47f6d298-c3a3-4fd6-bd56-b8805af4ad63';
  v_hr     constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_client constant uuid := '12efcd9b-db3a-4140-90f1-f9ef4f2b988a';
  v_mine   constant uuid := '7d6ec80c-f26f-4117-9517-e572fc1662d7';
  v_inv    uuid;
  v_tahas  uuid;
  v_today  date := (now() at time zone 'Asia/Karachi')::date;
  v_msg    text;
  v_w      jsonb;
  v_id     uuid;
  v_n      int;
  v_ran    int := 0;
begin
  begin
    select id into v_inv from public.invoices where invoice_number = 'GGS-26-MAND-11';
    select id into v_tahas from public.cash_locations where name = 'Taha Bin Arshad';
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);

    -- 1. A first payment into your own keeping: no flags, confirmed.
    perform public.record_invoice_payment_checked(v_inv, 1111, v_today, 'Cash', null, null, 0, v_mine, null, null);
    select id into v_id from public.invoice_payments where invoice_id = v_inv and amount = 1111 order by created_at desc limit 1;
    if not exists (select 1 from public.invoice_payments where id = v_id and entry_flags = '{}' and custody_status = 'confirmed' and entered_by = v_boss) then
      raise exception '0640 REFUSED: a plain payment into your own keeping was flagged or left pending.';
    end if;
    v_ran := v_ran + 1;

    -- The next checks need the first row to look already saved (it is, in a real second call).
    update public.invoice_payments set created_at = now() - interval '1 hour' where id = v_id;

    -- 2. The same amount again is refused without a reason, in the check's own words …
    v_w := public.payment_entry_warnings(v_client, 1111, v_today);
    if jsonb_array_length(v_w -> 'duplicates') <> 1 then raise exception '0640 REFUSED: the warning did not find the earlier payment (%).', v_w; end if;
    v_msg := null;
    begin perform public.record_invoice_payment_checked(v_inv, 1111, v_today, 'Cash', null, null, 0, v_mine, null, null);
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like 'ENTRY CHECK: Mr. Ali Saadat Mandwala Chakri already has a payment of PKR 1,111 dated %' then
      raise exception '0640 REFUSED: a likely duplicate was saved without a reason (%).', coalesce(v_msg, 'no error');
    end if;
    -- … and calling the old function directly does not get round it.
    v_msg := null;
    begin perform public.record_invoice_payment(v_inv, 1111, v_today, 'Cash', null, null, 0, v_mine, null);
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like 'ENTRY CHECK:%' then raise exception '0640 REFUSED: the check was bypassed by calling record_invoice_payment directly (%).', coalesce(v_msg, 'no error'); end if;
    v_ran := v_ran + 1;

    -- 3. With a reason it saves, flagged, and the super admins are told.
    perform public.record_invoice_payment_checked(v_inv, 1111, v_today, 'Cash', null, null, 0, v_mine, null, 'Paid twice — two separate months');
    select id into v_id from public.invoice_payments where invoice_id = v_inv and amount = 1111 and 'duplicate' = any(entry_flags);
    if v_id is null or (select entry_reason from public.invoice_payments where id = v_id) <> 'Paid twice — two separate months' then
      raise exception '0640 REFUSED: the duplicate saved with a reason is not flagged with it.';
    end if;
    if not exists (select 1 from public.alerts where ref_id = v_id and message like '%as duplicate — reason: Paid twice%') then
      raise exception '0640 REFUSED: no alert for a payment saved past the duplicate check.';
    end if;
    v_ran := v_ran + 1;

    -- 4. A payment dated 30 days ago needs a reason, and is flagged back-dated.
    v_msg := null;
    begin perform public.record_invoice_payment_checked(v_inv, 2222, v_today - 30, 'Cash', null, null, 0, v_mine, null, null);
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like 'ENTRY CHECK: this payment is dated % (30 days ago). Give a reason for entering it late.' then
      raise exception '0640 REFUSED: a back-dated payment was saved without a reason (%).', coalesce(v_msg, 'no error');
    end if;
    perform public.record_invoice_payment_checked(v_inv, 2222, v_today - 30, 'Cash', null, null, 0, v_mine, null, 'Receipt book entry found late');
    if not exists (select 1 from public.invoice_payments where invoice_id = v_inv and amount = 2222 and entry_flags = '{backdated}') then
      raise exception '0640 REFUSED: the back-dated payment is not flagged.';
    end if;
    v_ran := v_ran + 1;

    -- 5. Cash you record into Taha's keeping waits for Taha — not for you.
    perform public.record_invoice_payment_checked(v_inv, 3333, v_today, 'Cash', null, null, 0, v_tahas, null, null);
    select id into v_id from public.invoice_payments where invoice_id = v_inv and amount = 3333;
    if (select custody_status from public.invoice_payments where id = v_id) <> 'pending' then
      raise exception '0640 REFUSED: cash recorded into someone else''s keeping is not pending.';
    end if;
    v_msg := null;
    begin perform public.confirm_cash_custody(v_id, true); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Only Taha Bin Arshad can confirm cash recorded into their keeping.' then
      raise exception '0640 REFUSED: someone other than the custodian confirmed (%).', coalesce(v_msg, 'no error');
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_taha, 'role', 'authenticated')::text, true);
    select count(*) into v_n from public.cash_awaiting_confirmation() where payment_id = v_id and can_confirm;
    if v_n <> 1 then raise exception '0640 REFUSED: Taha does not see the cash waiting for him (%).', v_n; end if;
    v_msg := null;
    begin perform public.confirm_cash_custody(v_id, false, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Say what happened — the note is how the office follows it up.' then raise exception '0640 REFUSED: "not received" was accepted with no note (%).', coalesce(v_msg, 'no error'); end if;
    perform public.confirm_cash_custody(v_id, false, 'Never handed to me');
    if (select custody_status from public.invoice_payments where id = v_id) <> 'disputed'
       or not exists (select 1 from public.alerts where ref_id = v_id and message like 'Taha Bin Arshad says cash of PKR 3,333%Never handed to me') then
      raise exception '0640 REFUSED: "not received" did not mark the cash disputed and alert the office.';
    end if;
    -- The Ali Saadat case: Taha records cash into Shayan's keeping. Shayan has
    -- no linked office login, so it waits for a super admin, and he confirms.
    perform public.record_invoice_payment_checked(v_inv, 5555, v_today, 'Cash', null, null, 0, v_mine, null, null);
    select id into v_id from public.invoice_payments where invoice_id = v_inv and amount = 5555;
    if (select custody_status from public.invoice_payments where id = v_id) <> 'pending' then
      raise exception '0640 REFUSED: cash Taha recorded into Shayan''s keeping is not pending.';
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform public.confirm_cash_custody(v_id, true, null);
    if (select custody_status from public.invoice_payments where id = v_id) <> 'confirmed' then
      raise exception '0640 REFUSED: the super admin could not confirm cash for a custodian with no office login.';
    end if;
    v_ran := v_ran + 1;

    -- 6. A duplicate already in the books (entered with no check) is listed until marked genuine.
    execute 'reset role';
    perform set_config('request.jwt.claims', '{}', true);
    insert into public.invoice_payments (company_id, invoice_id, client_id, amount, payment_date, payment_mode, custodian_location_id, created_at)
    values ('7f7899a0-edd2-4491-a40d-f81b54c68d1e', v_inv, v_client, 4444, v_today, 'Cash', v_mine, now() - interval '2 hours'),
           ('7f7899a0-edd2-4491-a40d-f81b54c68d1e', v_inv, v_client, 4444, v_today, 'Cash', v_mine, now() - interval '1 hour');
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select payment_id into v_id from public.possible_duplicate_receipts() where amount = 4444;
    if v_id is null then raise exception '0640 REFUSED: a duplicate already in the books is not listed.'; end if;
    perform public.mark_receipt_not_duplicate(v_id);
    if exists (select 1 from public.possible_duplicate_receipts() where amount = 4444) then
      raise exception '0640 REFUSED: a duplicate marked genuine is still listed.';
    end if;
    v_ran := v_ran + 1;

    -- 7. A login without invoices.edit cannot use the warnings or mark a receipt.
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = null, permissions = array['attendance.view'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null;
    begin perform public.payment_entry_warnings(v_client, 1, v_today); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'permission denied: invoices.edit required' then raise exception '0640 REFUSED: a login without invoices.edit read the warnings (%).', coalesce(v_msg, 'no error'); end if;
    select count(*) into v_n from public.possible_duplicate_receipts();
    if v_n <> 0 then raise exception '0640 REFUSED: a login without invoice access sees possible duplicates.'; end if;
    v_ran := v_ran + 1;

    perform set_config('request.jwt.claims', '{}', true);
    if v_ran <> 7 then raise exception '0640 REFUSED: % of 7 assertions ran.', v_ran; end if;
    raise exception '0640-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0640-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0640 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0640 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps() g where g.function_name in
      ('payment_entry_warnings', 'record_invoice_payment_checked', 'cash_awaiting_confirmation', 'confirm_cash_custody',
       'possible_duplicate_receipts', 'mark_receipt_not_duplicate', '_cash_location_login')) then
    raise exception '0640 REFUSED: branch_guard_gaps() reports one of the new functions.';
  end if;
end $test$;
