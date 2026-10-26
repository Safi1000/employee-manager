-- 0562 — a bill paid twice becomes a credit with the vendor
--
-- Asked 2026-10-26 (Gul Rahman, via Shayan): "Duplicate entry: An extra amount
-- of Rs. 2,460 was paid to Jamshaid (my mistake). Please add Rs. 2,460 to my
-- charge, as I have received the cash." Jamshaid's 4,050 bill covers tea from
-- 1 to 21 Oct; his 1,200 (1–3 Oct) and 1,260 (4–6 Oct) bills sit inside it and
-- were paid again in the 21 Oct Askari payment of 6,570. Nothing could record
-- it: reverting the payment would put 6,570 back in Askari, which the bank
-- really paid; a paid, approved bill cannot be deleted.
--
-- DECIDED 2026-10-26 (Shayan): accounts staff only (accounting.edit, the key
-- every vendor-payment function already asks); a refund is dated the day it is
-- recorded; a credit the vendor keeps is used against a bill only when someone
-- chooses to — never automatically.
--
-- THE MODEL
--   mark_bills_duplicate(bills, reason) — one vendor's paid bills that should
--     never have existed. Per bill: its payment allocations come off it (their
--     journal reversed) and the same money is re-posted from the same bank or
--     cash to 1120 Vendor Credits Receivable, so the bank's ledger does not
--     move; the bill is unapproved and deleted, which reverses its cost. Its
--     description, date, amount, client and approval are kept on the credit.
--     Net: expense down, vendor owes us, money where it was.
--   refund_vendor_credit(credit, amount, Cash|Bank, …) — the vendor hands the
--     money back: the cash location or bank goes up (apply_money_delta) and
--     the credit goes down. Dated today.
--   apply_vendor_credit(credit, bill, amount) — the credit pays (part of) one
--     open bill of the same vendor, as an allocation like any payment.
--   revert_vendor_credit_settlement(settlement) — undoes a refund or an
--     application.
--   revert_vendor_payment refuses a payment a credit was taken from, until the
--     credit is gone: reverting it would refund the full amount to the bank
--     while the credit still claimed part of it.
--
-- A credit cannot be deleted. It is finished when it is settled in full.

-- ── 1. the account ────────────────────────────────────────────────────────────
insert into public.chart_of_accounts (company_id, account_code, account_name, account_type, normal_side,
                                      system_key, system_account, is_control, notes)
select c.id, '1120', 'Vendor Credits Receivable', 'asset', 'debit', 'vendor_credits', true, false,
       '0562: money paid to a vendor on a bill that should not have been paid, owed back until refunded or used against a bill.'
  from public.companies c
 where not exists (select 1 from public.chart_of_accounts a where a.company_id = c.id and a.system_key = 'vendor_credits');

-- ── 2. the tables ─────────────────────────────────────────────────────────────
create table if not exists public.vendor_credits (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  vendor_id   uuid not null references public.vendors(id),
  branch_id   uuid,
  amount      numeric not null check (amount > 0),
  reason      text not null check (length(btrim(reason)) > 0),
  bills       jsonb not null,            -- what the deleted bills were, as they were
  source_vendor_payment_ids uuid[] not null,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create table if not exists public.vendor_credit_settlements (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  credit_id   uuid not null references public.vendor_credits(id) on delete restrict,
  kind        text not null check (kind in ('refund', 'applied')),
  amount      numeric not null check (amount > 0),
  paid_via    text check (paid_via in ('Cash', 'Bank')),
  bank_account_id uuid references public.bank_accounts(id),
  custodian_location_id uuid references public.cash_locations(id),
  expense_id  uuid references public.expenses(id) on delete restrict,
  settled_on  date not null default current_date,
  notes       text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  check ((kind = 'refund' and expense_id is null
          and ((paid_via = 'Bank' and bank_account_id is not null and custodian_location_id is null)
            or (paid_via = 'Cash' and custodian_location_id is not null and bank_account_id is null)))
      or (kind = 'applied' and expense_id is not null and paid_via is null
          and bank_account_id is null and custodian_location_id is null))
);
comment on table public.vendor_credits is
  'DECIDED 2026-10-26 (0562): money a vendor owes back for bills marked duplicate. Settled by refund or by applying it to a bill, by choice. Never deleted.';

alter table public.vendor_credits enable row level security;
alter table public.vendor_credit_settlements enable row level security;
drop policy if exists company_members_read on public.vendor_credits;
create policy company_members_read on public.vendor_credits for select using (company_id = (select public.current_company_id()));
drop policy if exists ssa_read on public.vendor_credits;
create policy ssa_read on public.vendor_credits for select using ((select public.is_ssa_unscoped()));
drop policy if exists company_members_read on public.vendor_credit_settlements;
create policy company_members_read on public.vendor_credit_settlements for select using (company_id = (select public.current_company_id()));
drop policy if exists ssa_read on public.vendor_credit_settlements;
create policy ssa_read on public.vendor_credit_settlements for select using ((select public.is_ssa_unscoped()));

-- An allocation is paid by a vendor payment OR by a credit, never both.
alter table public.payable_payments alter column vendor_payment_id drop not null;
alter table public.payable_payments add column if not exists vendor_credit_settlement_id uuid
  references public.vendor_credit_settlements(id) on delete restrict;
alter table public.payable_payments drop constraint if exists payable_payments_one_source;
alter table public.payable_payments add constraint payable_payments_one_source
  check (num_nonnulls(vendor_payment_id, vendor_credit_settlement_id) = 1);

create or replace view public.vendor_credit_balances with (security_invoker = true) as
select c.id as credit_id, c.company_id, c.vendor_id, c.amount,
       coalesce(sum(s.amount), 0) as settled,
       c.amount - coalesce(sum(s.amount), 0) as remaining
  from public.vendor_credits c
  left join public.vendor_credit_settlements s on s.credit_id = c.id
 group by c.id;

-- ── 3. mark bills duplicate ───────────────────────────────────────────────────
create or replace function public.mark_bills_duplicate(p_expense_ids uuid[], p_reason text)
returns uuid
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  v_co uuid; v_vendor uuid; v_branch uuid; v_credit uuid; v_total numeric := 0;
  v_bills jsonb := '[]'::jsonb; v_vps uuid[] := '{}'; b record; a record; v_n int; v_cnt int; v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  if p_expense_ids is null or cardinality(p_expense_ids) = 0 then
    raise exception 'Choose the bills that were paid twice. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'Say why these bills are duplicates. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  -- tenant guard [resolved]: each bill's company from public.expenses (0562)
  foreach v_id in array p_expense_ids loop
    perform public.assert_same_company((select company_id from public.expenses where id = v_id));
  end loop;

  select min(e.company_id::text)::uuid, min(e.vendor_id::text)::uuid, count(distinct e.vendor_id), count(*)
    into v_co, v_vendor, v_n, v_cnt from public.expenses e where e.id = any (p_expense_ids);
  if v_co is null or v_cnt <> cardinality(p_expense_ids) then
    raise exception 'One of those bills does not exist, or you cannot see it. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if v_n <> 1 or v_vendor is null then
    raise exception 'Duplicate bills are marked one vendor at a time. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  insert into public.vendor_credits (company_id, vendor_id, amount, reason, bills, source_vendor_payment_ids, created_by)
  values (v_co, v_vendor, 0.01, btrim(p_reason), '[]'::jsonb, '{}', auth.uid())
  returning id into v_credit;

  perform set_config('app.payable_payment', '1', true);
  for b in select * from public.expenses where id = any (p_expense_ids) order by expense_date, created_at for update loop
    perform public.assert_branch_writable(b.branch_id);
    v_branch := coalesce(v_branch, b.branch_id);
    if b.payment_mode <> 'Payable' or not exists (select 1 from public.payable_payments where expense_id = b.id) then
      raise exception 'The bill "%" (%) has no payment against it. An unpaid bill is simply deleted, not marked duplicate. Nothing has been recorded.',
        b.description, b.amount using errcode = 'P0001';
    end if;

    -- Its allocations come off; the same money moves from the same place to the credit.
    for a in
      select pp.id, pp.amount, pp.vendor_payment_id, vp.paid_via, vp.paid_bank_account_id, vp.custodian_location_id
        from public.payable_payments pp join public.vendor_payments vp on vp.id = pp.vendor_payment_id
       where pp.expense_id = b.id for update of pp
    loop
      perform public.reverse_journal_for_source(v_co, 'payable_payments', a.id, current_date);
      delete from public.payable_payments where id = a.id;
      perform public.post_journal(v_co, current_date,
        'Paid twice — credit with ' || coalesce((select name from public.vendors where id = v_vendor), 'vendor') || coalesce(' · ' || b.description, ''),
        'vendor_credits', v_credit, false,
        jsonb_build_array(
          jsonb_build_object('key', 'vendor_credits', 'debit', a.amount, 'credit', 0, 'client_id', b.client_id),
          jsonb_build_object('account_id', public.settlement_account(v_co, a.paid_via, a.paid_bank_account_id, a.custodian_location_id, true),
                             'debit', 0, 'credit', a.amount)),
        b.branch_id);
      v_total := v_total + a.amount;
      if not (a.vendor_payment_id = any (v_vps)) then v_vps := v_vps || a.vendor_payment_id; end if;
    end loop;

    v_bills := v_bills || jsonb_build_object('expense_id', b.id, 'description', b.description, 'amount', b.amount,
      'expense_date', b.expense_date, 'client_id', b.client_id, 'category_id', b.category_id,
      'approved_at', b.approved_at, 'approved_by_name', b.approved_by_name, 'created_at', b.created_at);

    -- Unapproval and deletion are separate steps, as the approval lock requires.
    if b.approved_at is not null then
      update public.expenses set approved_at = null where id = b.id;
    end if;
    delete from public.expenses where id = b.id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'The bill "%" could not be removed. Nothing has been recorded.', b.description; end if;
  end loop;
  perform set_config('app.payable_payment', '', true);

  update public.vendor_credits set amount = v_total, bills = v_bills, source_vendor_payment_ids = v_vps, branch_id = v_branch
   where id = v_credit;
  return v_credit;
end $fn$;
comment on function public.mark_bills_duplicate(uuid[], text) is
  '0562 DECIDED 2026-10-26: one vendor''s paid bills that should not exist become a credit with that vendor; the money stays where it went. accounting.edit.';

-- ── 4. refund ─────────────────────────────────────────────────────────────────
create or replace function public.refund_vendor_credit(p_credit_id uuid, p_amount numeric, p_paid_via text,
  p_bank_account_id uuid default null, p_custodian_location_id uuid default null, p_notes text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $fn$
declare c public.vendor_credits; v_left numeric; v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  -- tenant guard [resolved]: each uuid's company (0562)
  perform public.assert_same_company((select company_id from public.vendor_credits where id = p_credit_id));
  if p_bank_account_id is not null then
    perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id));
  end if;
  if p_custodian_location_id is not null then
    perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id));
  end if;

  select * into c from public.vendor_credits where id = p_credit_id for update;
  if c.id is null then raise exception 'That credit does not exist. Nothing has been recorded.' using errcode = 'P0001'; end if;
  perform public.assert_branch_writable(c.branch_id);
  p_amount := round(coalesce(p_amount, 0), 2);
  select remaining into v_left from public.vendor_credit_balances where credit_id = c.id;
  if p_amount <= 0 or p_amount > v_left then
    raise exception 'A refund must be more than zero and at most what is still owed (%). Nothing has been recorded.',
      to_char(v_left, 'FM999,999,990.00') using errcode = '23514';
  end if;
  if p_paid_via = 'Bank' and p_bank_account_id is null then
    raise exception 'A refund into a bank needs the bank account. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if p_paid_via = 'Cash' and p_custodian_location_id is null then
    raise exception 'A cash refund needs the person who received it. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if p_paid_via not in ('Cash', 'Bank') then
    raise exception 'A refund comes back in Cash or Bank. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  insert into public.vendor_credit_settlements (company_id, credit_id, kind, amount, paid_via, bank_account_id,
                                                custodian_location_id, notes, created_by)
  values (c.company_id, c.id, 'refund', p_amount, p_paid_via,
          case when p_paid_via = 'Bank' then p_bank_account_id end,
          case when p_paid_via = 'Cash' then p_custodian_location_id end,
          nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;

  perform public.post_journal(c.company_id, current_date,
    'Refund from ' || coalesce((select name from public.vendors where id = c.vendor_id), 'vendor') || ' of a bill paid twice',
    'vendor_credit_settlements', v_id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', public.settlement_account(c.company_id, p_paid_via,
                           case when p_paid_via = 'Bank' then p_bank_account_id end,
                           case when p_paid_via = 'Cash' then p_custodian_location_id end, true),
                         'debit', p_amount, 'credit', 0),
      jsonb_build_object('key', 'vendor_credits', 'debit', 0, 'credit', p_amount)),
    c.branch_id);

  perform public.apply_money_delta(c.company_id, p_paid_via,
    case when p_paid_via = 'Bank' then p_bank_account_id end, p_amount, 'expense',
    'Refund from ' || coalesce((select name from public.vendors where id = c.vendor_id), 'vendor') || ' (bill paid twice)',
    case when p_paid_via = 'Cash' then p_custodian_location_id::text else v_id::text end);
  return v_id;
end $fn$;

-- ── 5. apply to a bill ────────────────────────────────────────────────────────
create or replace function public.apply_vendor_credit(p_credit_id uuid, p_expense_id uuid, p_amount numeric)
returns uuid
language plpgsql security definer set search_path to 'public'
as $fn$
declare c public.vendor_credits; e public.expenses; v_left numeric; v_owed numeric; v_id uuid; v_alloc uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  -- tenant guard [resolved]: each uuid's company (0562)
  perform public.assert_same_company((select company_id from public.vendor_credits where id = p_credit_id));
  perform public.assert_same_company((select company_id from public.expenses where id = p_expense_id));

  select * into c from public.vendor_credits where id = p_credit_id for update;
  select * into e from public.expenses where id = p_expense_id for update;
  if c.id is null or e.id is null then raise exception 'That credit or bill does not exist. Nothing has been recorded.' using errcode = 'P0001'; end if;
  perform public.assert_branch_writable(e.branch_id);
  if e.vendor_id is distinct from c.vendor_id or e.payment_mode <> 'Payable' or coalesce(e.payable_status, 'Pending') = 'Paid' then
    raise exception 'A credit pays an open bill of the same vendor. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  p_amount := round(coalesce(p_amount, 0), 2);
  select remaining into v_left from public.vendor_credit_balances where credit_id = c.id;
  v_owed := e.amount - coalesce((select sum(amount) from public.payable_payments where expense_id = e.id), 0);
  if p_amount <= 0 or p_amount > v_left or p_amount > v_owed then
    raise exception 'Apply more than zero, at most the credit left (%) and at most the bill owed (%). Nothing has been recorded.',
      to_char(v_left, 'FM999,999,990.00'), to_char(v_owed, 'FM999,999,990.00') using errcode = '23514';
  end if;

  insert into public.vendor_credit_settlements (company_id, credit_id, kind, amount, expense_id, created_by)
  values (c.company_id, c.id, 'applied', p_amount, e.id, auth.uid()) returning id into v_id;

  perform set_config('app.payable_payment', '1', true);
  insert into public.payable_payments (company_id, vendor_credit_settlement_id, expense_id, amount)
  values (c.company_id, v_id, e.id, p_amount) returning id into v_alloc;
  perform public.post_journal(c.company_id, current_date,
    'Payable paid from credit' || coalesce(' — ' || e.description, '') || ' · ' || coalesce((select name from public.vendors where id = c.vendor_id), 'vendor'),
    'payable_payments', v_alloc, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ap', 'debit', p_amount, 'credit', 0, 'client_id', e.client_id),
      jsonb_build_object('key', 'vendor_credits', 'debit', 0, 'credit', p_amount)),
    e.branch_id);
  if p_amount >= v_owed then
    update public.expenses set payable_status = 'Paid', paid_at = now(), updated_at = now() where id = e.id;
  end if;
  perform set_config('app.payable_payment', '', true);
  return v_id;
end $fn$;

-- ── 6. revert a settlement ────────────────────────────────────────────────────
create or replace function public.revert_vendor_credit_settlement(p_settlement_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare s public.vendor_credit_settlements; c public.vendor_credits; a record; v_n int;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  -- tenant guard [resolved]: the settlement's company (0562)
  perform public.assert_same_company((select company_id from public.vendor_credit_settlements where id = p_settlement_id));
  select * into s from public.vendor_credit_settlements where id = p_settlement_id for update;
  if s.id is null then raise exception 'That refund or application does not exist. Nothing has been recorded.' using errcode = 'P0001'; end if;
  select * into c from public.vendor_credits where id = s.credit_id;
  perform public.assert_branch_writable(c.branch_id);

  if s.kind = 'refund' then
    perform public.reverse_journal_for_source(s.company_id, 'vendor_credit_settlements', s.id, current_date);
    perform public.apply_money_delta(s.company_id, s.paid_via, s.bank_account_id, -s.amount, 'expense',
      'Refund reverted · ' || coalesce((select name from public.vendors where id = c.vendor_id), 'vendor'),
      case when s.paid_via = 'Cash' then s.custodian_location_id::text else s.id::text end);
  else
    perform set_config('app.payable_payment', '1', true);
    for a in select pp.id, pp.expense_id from public.payable_payments pp where pp.vendor_credit_settlement_id = s.id for update loop
      perform public.reverse_journal_for_source(s.company_id, 'payable_payments', a.id, current_date);
      update public.expenses set payable_status = 'Pending', paid_at = null, updated_at = now()
       where id = a.expense_id and payable_status = 'Paid';
      delete from public.payable_payments where id = a.id;
    end loop;
    perform set_config('app.payable_payment', '', true);
  end if;
  delete from public.vendor_credit_settlements where id = s.id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The settlement could not be removed. Nothing has been recorded.'; end if;
end $fn$;

revoke all on function public.mark_bills_duplicate(uuid[], text) from public, anon;
revoke all on function public.refund_vendor_credit(uuid, numeric, text, uuid, uuid, text) from public, anon;
revoke all on function public.apply_vendor_credit(uuid, uuid, numeric) from public, anon;
revoke all on function public.revert_vendor_credit_settlement(uuid) from public, anon;
grant execute on function public.mark_bills_duplicate(uuid[], text) to authenticated;
grant execute on function public.refund_vendor_credit(uuid, numeric, text, uuid, uuid, text) to authenticated;
grant execute on function public.apply_vendor_credit(uuid, uuid, numeric) to authenticated;
grant execute on function public.revert_vendor_credit_settlement(uuid) to authenticated;

-- ── 7. revert_vendor_payment refuses a payment a credit was taken from ────────
-- Several authors (0470, 0504, 0506, 0507): surgery, anchor asserted once.
do $surgery$
declare
  v_def text := pg_get_functiondef('public.revert_vendor_payment(uuid)'::regprocedure);
  v_anchor constant text := 'select * into v_vp from public.vendor_payments where id = p_vendor_payment_id for update;';
  v_n int;
begin
  if position('0562' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0562 REFUSED: the anchor appears % times in revert_vendor_payment.', v_n; end if;
  execute replace(v_def, v_anchor, v_anchor || E'\n' ||
    '  -- 0562: part of this payment became a credit with the vendor; reverting it' || E'\n' ||
    '  -- would refund the whole payment while the credit still claims part of it.' || E'\n' ||
    '  if exists (select 1 from public.vendor_credits vc where p_vendor_payment_id = any (vc.source_vendor_payment_ids)) then' || E'\n' ||
    '    raise exception ''Part of this payment was for bills marked as paid twice and is now a credit with the vendor. It cannot be reverted. Nothing has been recorded.'' using errcode = ''P0001'';' || E'\n' ||
    '  end if;');
end $surgery$;

-- ── 8. proof, rolled back: Jamshaid's two bills, refunded to Gul Rahman ───────
do $proof$
declare
  c_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  c_bills constant uuid[] := array['a183f65a-68e7-4a57-aa1e-6ac1bbb1c22f', '633dbb64-8783-4a08-ac5c-178010b510da']::uuid[];
  c_askari constant uuid := '1df9eaa6-afdb-48d1-8f8e-8c69ba867787';
  v_gul uuid; v_credit uuid; v_ref uuid; v_bank_before numeric; v_bank_gl_before numeric; v_bank_gl uuid;
  v_exp_before numeric; v_vc_gl numeric; v_msg text;
begin
  if (select count(*) from public.expenses where id = any (c_bills)) <> 2 then
    raise notice '0562: Jamshaid''s two bills are no longer there — proof skipped.';
    return;
  end if;
  v_gul := '5534c2a0-6d50-4d92-bd33-e6ab0cc85a0e';  -- Gul Rehman's cash
  v_bank_gl := public.bank_account_gl(c_co, c_askari);
  begin
    select balance into v_bank_before from public.bank_accounts where id = c_askari;
    select coalesce(sum(debit - credit), 0) into v_bank_gl_before from public.journal_lines where account_id = v_bank_gl;
    select coalesce(sum(jl.debit - jl.credit), 0) into v_exp_before
      from public.journal_lines jl join public.chart_of_accounts a on a.id = jl.account_id where a.company_id = c_co and a.account_type = 'expense';

    v_credit := public.mark_bills_duplicate(c_bills, 'Inside the 4,050 bill for 1–21 Oct (Gul Rahman, 26 Oct)');
    if (select amount from public.vendor_credits where id = v_credit) <> 2460 then raise exception '0562 PROOF: credit is not 2,460.'; end if;
    if (select balance from public.bank_accounts where id = c_askari) <> v_bank_before then raise exception '0562 PROOF: Askari''s stored balance moved.'; end if;
    if (select coalesce(sum(debit - credit), 0) from public.journal_lines where account_id = v_bank_gl) <> v_bank_gl_before then
      raise exception '0562 PROOF: Askari''s ledger moved.';
    end if;
    if (select coalesce(sum(jl.debit - jl.credit), 0) from public.journal_lines jl join public.chart_of_accounts a on a.id = jl.account_id
         where a.company_id = c_co and a.account_type = 'expense') <> v_exp_before - 2460 then
      raise exception '0562 PROOF: expenses did not fall by 2,460.';
    end if;
    -- The 6,570 payment cannot be reverted now — asserted on the message.
    begin
      perform public.revert_vendor_payment('5a497795-0c01-4622-b3d3-d74728e6e37b');
      raise exception '0562 PROOF: the payment was reverted.';
    exception when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg not like 'Part of this payment was for bills marked as paid twice%' then raise exception '0562 PROOF: wrong refusal: %', v_msg; end if;
    end;
    begin
      v_ref := public.refund_vendor_credit(v_credit, 2460, 'Cash', null, v_gul, 'Handed back to Gul Rahman');
      if (select remaining from public.vendor_credit_balances where credit_id = v_credit) <> 0 then raise exception '0562 PROOF: credit not cleared.'; end if;
      select coalesce(sum(jl.debit - jl.credit), 0) into v_vc_gl from public.journal_lines jl
        join public.chart_of_accounts a on a.id = jl.account_id where a.company_id = c_co and a.system_key = 'vendor_credits';
      if v_vc_gl <> 0 then raise exception '0562 PROOF: 1120 is % after the refund, not 0.', v_vc_gl; end if;
    end;
    raise exception 'ROLLBACK-0562';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> 'ROLLBACK-0562' then raise; end if;
  end;
  if (select count(*) from public.expenses where id = any (c_bills)) <> 2 then raise exception '0562: the proof did not roll back.'; end if;
end $proof$;

do $$
begin
  if exists (select 1 from public.tenant_guard_gaps() where function_name in
      ('mark_bills_duplicate', 'refund_vendor_credit', 'apply_vendor_credit', 'revert_vendor_credit_settlement')) then
    raise exception '0562 REFUSED: tenant_guard_gaps names a new function.';
  end if;
end $$;
