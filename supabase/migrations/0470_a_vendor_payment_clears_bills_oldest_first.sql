-- 0470 — a vendor payment clears that vendor's bills oldest first, and a bill
-- can be partly paid.
--
-- WHAT WAS MISSING. A payable (expenses.payment_mode = 'Payable') was either
-- Pending or Paid, and settle_payable_expense paid exactly one whole bill. A
-- vendor paid a round sum against several bills — 1,500 against bills of
-- 1,000 / 2,000 / 3,000 — had no way in: the 1,000 is settled, the 2,000 is
-- 500 into being settled, and "500 into" did not exist.
--
-- THE MODEL.
--   vendor_payments  — one row per payment: vendor, amount, Cash (custodian) or
--                      Bank (account), date. The money moves ONCE for it,
--                      through apply_money_delta.
--   payable_payments — how that payment was applied: one row per bill it
--                      touched, oldest bill first (expense_date, then
--                      created_at). A bill's paid amount is the sum of its rows.
--
-- POSTING. Rule #18 of LEDGER_PHASE1_POSTING_RULES ("Payable settled: Dr
-- Accounts Payable / Cr Bank or Custodian Cash, Cash @ paid_at") applied to the
-- part of the bill actually paid: each payable_payments row posts
-- Dr ap / Cr settlement_account(...) for its own amount, dated the payment,
-- with the bill's client and branch — the same dimensions the whole-bill
-- settlement carries. No new policy: the same entry, for the amount paid.
--
-- A bill whose rows reach its amount flips to Paid (paid_at = that payment's
-- date). journal_on_expense_settlement is told to stand aside for any bill
-- with payable_payments rows, or the flip would post the WHOLE bill again.
--
-- WHAT ELSE HAD TO LEARN ABOUT IT. Custodian cash is not a stored balance; it
-- is summed from every table that moves it. A cash vendor payment is a new such
-- table, so:
--   * custodian_held_operational — subtracts cash vendor payments. cash_in_hand
--     reads it, and cash_per_location_gl_equals_operational compares it with
--     the GL; missing this would turn that check red on the first cash payment.
--   * partner_ledger — a partner-custodian's cash paying a vendor is listed.
--   * unposted_source_rows — payable_payments is a source that must post, so
--     every_source_row_posted covers it.
-- The screen-side summers (lib/custodian.ts, CashCustody) are updated in the
-- same change.
--
-- WHAT IS PROTECTED. A bill with payments against it cannot be deleted, have
-- its amount / vendor / mode changed, or be settled/reverted by the whole-bill
-- path: expense_reverse_money would refund `amount` through `paid_via`, which is
-- not how its money left. enforce_payable_payment_lock refuses all of that until
-- the payments are reverted (revert_vendor_payment), and says so.
--
-- DEFERRED — cash-basis timing of a partly paid bill. regional_pl_range,
-- regional_cash_hunger, client_statement_loaded, CashFlow and
-- RegionalPerformance date a payable at paid_at when it is Paid and ignore it
-- while Pending. A bill paid in instalments is therefore recognised on those
-- CASH-basis screens in full, on the date it becomes fully paid, rather than
-- instalment by instalment. The GL (accrual) is exact either way. If asked to
-- change: each of those readers adds `payable_payments ⋈ vendor_payments`
-- (amount at paid_on) and drops Payable+Paid expenses that have
-- payable_payments rows.
--
-- KEY. accounting.edit — what settle_payable_expense already requires for the
-- same act. DEFINER: it writes a SET of bills chosen by a predicate (the
-- vendor's open bills), so under invoker a bill RLS hid would silently receive
-- nothing and the payment would still be taken. The boundary is asserted
-- inside: permission, company of every uuid, and each bill's branch.

-- ── tables ─────────────────────────────────────────────────────────────────────
create table if not exists public.vendor_payments (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id),
  vendor_id             uuid not null references public.vendors(id),
  amount                numeric(14,2) not null check (amount > 0),
  paid_via              text not null check (paid_via in ('Cash', 'Bank')),
  paid_bank_account_id  uuid references public.bank_accounts(id),
  custodian_location_id uuid references public.cash_locations(id),
  paid_on               date not null default current_date,
  notes                 text,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  check ((paid_via = 'Bank' and paid_bank_account_id is not null and custodian_location_id is null)
      or (paid_via = 'Cash' and paid_bank_account_id is null))
);

create table if not exists public.payable_payments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id),
  vendor_payment_id uuid not null references public.vendor_payments(id) on delete restrict,
  expense_id        uuid not null references public.expenses(id) on delete restrict,
  amount            numeric(14,2) not null check (amount > 0),
  created_at        timestamptz not null default now()
);

create index if not exists idx_vendor_payments_company on public.vendor_payments(company_id);
create index if not exists idx_vendor_payments_vendor  on public.vendor_payments(vendor_id);
create index if not exists idx_vendor_payments_custody on public.vendor_payments(custodian_location_id) where custodian_location_id is not null;
create index if not exists idx_payable_payments_expense on public.payable_payments(expense_id);
create index if not exists idx_payable_payments_payment on public.payable_payments(vendor_payment_id);
create index if not exists idx_payable_payments_company on public.payable_payments(company_id);

comment on table public.vendor_payments is
  '0470: a payment to a vendor. Written only by pay_vendor_payables / revert_vendor_payment. '
  'Cash ones are custodian cash out (custodian_held_operational).';
comment on table public.payable_payments is
  '0470: how a vendor_payment was applied to bills, oldest first. Each row posts Dr ap / Cr cash-or-bank '
  '(source payable_payments). A bill''s paid amount = sum of its rows.';

-- Read by company members; written only by the definer RPCs below (no write
-- policy exists, so a direct insert is refused by RLS).
alter table public.vendor_payments  enable row level security;
alter table public.payable_payments enable row level security;
do $mig$
declare t text;
begin
  foreach t in array array['vendor_payments', 'payable_payments'] loop
    execute format('drop policy if exists company_members_read on public.%I', t);
    execute format('drop policy if exists ssa_read on public.%I', t);
    execute format($p$create policy company_members_read on public.%I for select
      using (company_id = (select public.current_company_id()))$p$, t);
    execute format($p$create policy ssa_read on public.%I for select
      using ((select public.is_ssa_unscoped()))$p$, t);
  end loop;
end $mig$;

-- What a bill has paid and still owes. security_invoker: obeys the caller's RLS.
create or replace view public.payable_outstanding with (security_invoker = true) as
select e.id as expense_id, e.vendor_id, e.amount,
       coalesce(p.paid, 0) as paid_amount,
       case when e.payable_status = 'Paid' then 0
            else e.amount - coalesce(p.paid, 0) end as outstanding
  from public.expenses e
  left join (select expense_id, sum(amount) as paid from public.payable_payments group by expense_id) p
         on p.expense_id = e.id
 where e.payment_mode = 'Payable';

-- ── lock: a bill with payments against it moves only through the payment RPCs ──
create or replace function public.enforce_payable_payment_lock()
 returns trigger language plpgsql security definer set search_path to 'public'
as $fn$
begin
  if coalesce(current_setting('app.payable_payment', true), '') = '1' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if not exists (select 1 from public.payable_payments pp where pp.expense_id = old.id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE'
     or new.amount                is distinct from old.amount
     or new.vendor_id             is distinct from old.vendor_id
     or new.payment_mode          is distinct from old.payment_mode
     or new.payable_status        is distinct from old.payable_status
     or new.paid_via              is distinct from old.paid_via
     or new.paid_bank_account_id  is distinct from old.paid_bank_account_id
     or new.custodian_location_id is distinct from old.custodian_location_id
     or new.paid_at               is distinct from old.paid_at then
    raise exception 'This bill has vendor payments recorded against it. Revert those payments first. Nothing has been recorded.'
      using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_payable_payment_lock on public.expenses;
create trigger trg_payable_payment_lock
  before update or delete on public.expenses
  for each row execute function public.enforce_payable_payment_lock();

-- ── journal_on_expense_settlement stands aside for instalment-paid bills ──────
-- Surgery (multi-author: 0221, 0258). Anchor asserted exactly once.
do $mig$
declare
  v_src text; v_cnt int;
  a text :=
'  if coalesce(new.payment_mode, '''') <> ''Payable'' then
    return new;
  end if;
';
  r text :=
'  if coalesce(new.payment_mode, '''') <> ''Payable'' then
    return new;
  end if;

  -- 0470. A bill paid through vendor_payments posts per payable_payments row
  -- (Dr ap / Cr cash-or-bank for the part paid). Its flip to Paid, and back,
  -- must not post or reverse the WHOLE bill on top of that.
  if exists (select 1 from public.payable_payments pp where pp.expense_id = new.id) then
    return new;
  end if;
';
begin
  v_src := pg_get_functiondef('public.journal_on_expense_settlement()'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, a, ''))) / length(a);
  if v_cnt <> 1 then raise exception '0470 REFUSED: journal_on_expense_settlement anchor found % times (want 1).', v_cnt; end if;
  execute replace(v_src, a, r);
end $mig$;

-- ── custodian_held_operational: cash vendor payments leave the custodian ──────
do $mig$
declare
  v_src text; v_cnt int;
  a text :=
'         - coalesce((select sum(e.amount) from public.expenses e
                      where e.custodian_location_id = l.id), 0)
';
  r text :=
'         - coalesce((select sum(e.amount) from public.expenses e
                      where e.custodian_location_id = l.id), 0)
         - coalesce((select sum(vp.amount) from public.vendor_payments vp
                      where vp.paid_via = ''Cash'' and vp.custodian_location_id = l.id), 0)
';
begin
  v_src := pg_get_functiondef('public.custodian_held_operational(uuid)'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, a, ''))) / length(a);
  if v_cnt <> 1 then raise exception '0470 REFUSED: custodian_held_operational anchor found % times (want 1).', v_cnt; end if;
  execute replace(v_src, a, r);
end $mig$;

-- ── partner_ledger: a partner-custodian's cash paying a vendor is listed ──────
do $mig$
declare
  v_src text; v_cnt int;
  a text :=
'    union all
    select a.advance_date::date, ''ADVANCE'', a.amount, 0::numeric, ''CUSTODY:ADVANCE''::text, null::uuid
';
  r text :=
'    union all
    select vp.paid_on, ''VENDOR PAYMENT — '' || coalesce(v.name, ''vendor''),
           vp.amount, 0::numeric, ''CUSTODY:VENDOR_PAYMENT''::text, null::uuid
      from public.vendor_payments vp join ploc on ploc.id = vp.custodian_location_id
      left join public.vendors v on v.id = vp.vendor_id
     where vp.paid_via = ''Cash'' and vp.paid_on between v_from and v_to
    union all
    select a.advance_date::date, ''ADVANCE'', a.amount, 0::numeric, ''CUSTODY:ADVANCE''::text, null::uuid
';
begin
  v_src := pg_get_functiondef('public.partner_ledger(uuid,date,date)'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, a, ''))) / length(a);
  if v_cnt <> 1 then raise exception '0470 REFUSED: partner_ledger anchor found % times (want 1).', v_cnt; end if;
  execute replace(v_src, a, r);
end $mig$;

-- ── unposted_source_rows: payable_payments must post ──────────────────────────
do $mig$
declare
  v_src text; v_cnt int;
  a text :=
'    select ''cash_deposits'', cd.id, cd.amount, cd.deposit_date from public.cash_deposits cd where cd.company_id = p_company_id
';
  r text :=
'    select ''cash_deposits'', cd.id, cd.amount, cd.deposit_date from public.cash_deposits cd where cd.company_id = p_company_id
    union all
    -- 0470. Each application of a vendor payment to a bill posts Dr ap / Cr cash-or-bank.
    select ''payable_payments'', pp.id, pp.amount, vp.paid_on
      from public.payable_payments pp join public.vendor_payments vp on vp.id = pp.vendor_payment_id
     where pp.company_id = p_company_id
';
begin
  v_src := pg_get_functiondef('public.unposted_source_rows(uuid)'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, a, ''))) / length(a);
  if v_cnt <> 1 then raise exception '0470 REFUSED: unposted_source_rows anchor found % times (want 1).', v_cnt; end if;
  execute replace(v_src, a, r);
end $mig$;

-- ── pay_vendor_payables ────────────────────────────────────────────────────────
create or replace function public.pay_vendor_payables(
  p_vendor_id             uuid,
  p_amount                numeric,
  p_paid_via              text,
  p_paid_bank_account_id  uuid default null,
  p_custodian_location_id uuid default null,
  p_expense_id            uuid default null,   -- pay only this bill's balance
  p_notes                 text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_company uuid;
  v_vp      public.vendor_payments%rowtype;
  v_left    numeric;
  v_open    numeric;
  v_take    numeric;
  v_alloc   uuid;
  v_vendor  text;
  b         record;
  v_applied jsonb := '[]'::jsonb;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;

  -- Tenant guard: every uuid handed in.
  perform public.assert_same_company((select company_id from public.vendors where id = p_vendor_id));
  if p_paid_bank_account_id is not null then
    perform public.assert_same_company((select company_id from public.bank_accounts where id = p_paid_bank_account_id));
  end if;
  if p_custodian_location_id is not null then
    perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id));
  end if;
  if p_expense_id is not null then
    perform public.assert_same_company((select company_id from public.expenses where id = p_expense_id));
  end if;

  select v.company_id, v.name into v_company, v_vendor from public.vendors v where v.id = p_vendor_id;
  if v_company is null then
    raise exception 'That vendor does not exist, or you cannot see it. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  p_amount := round(coalesce(p_amount, 0), 2);
  if p_amount <= 0 then
    raise exception 'Enter an amount greater than zero. Nothing has been recorded.' using errcode = '23514';
  end if;
  if p_paid_via not in ('Cash', 'Bank') then
    raise exception 'A vendor is paid in Cash or Bank, not %. Nothing has been recorded.', p_paid_via using errcode = 'P0001';
  end if;
  if p_paid_via = 'Bank' and p_paid_bank_account_id is null then
    raise exception 'Paying by bank needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if p_paid_via = 'Cash' and p_custodian_location_id is null then
    raise exception 'Paying in cash needs the office-staff member who paid it. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  -- The vendor's open bills, oldest first, locked so two payments cannot
  -- apply themselves to the same balance.
  select coalesce(sum(o.outstanding), 0) into v_open
    from public.payable_outstanding o
    join public.expenses e on e.id = o.expense_id
   where e.vendor_id = p_vendor_id and e.company_id = v_company
     and coalesce(e.payable_status, 'Pending') <> 'Paid'
     and (p_expense_id is null or e.id = p_expense_id);
  if p_amount > v_open then
    raise exception 'That is more than is owed (% outstanding). Nothing has been recorded.', to_char(v_open, 'FM999,999,999,990.00')
      using errcode = '23514';
  end if;

  insert into public.vendor_payments (company_id, vendor_id, amount, paid_via, paid_bank_account_id,
                                      custodian_location_id, paid_on, notes, created_by)
  values (v_company, p_vendor_id, p_amount, p_paid_via,
          case when p_paid_via = 'Bank' then p_paid_bank_account_id end,
          case when p_paid_via = 'Cash' then p_custodian_location_id end,
          current_date, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning * into v_vp;

  perform set_config('app.payable_payment', '1', true);
  v_left := p_amount;
  for b in
    select e.id, e.amount, e.client_id, e.branch_id, e.description,
           e.amount - coalesce((select sum(pp.amount) from public.payable_payments pp where pp.expense_id = e.id), 0) as owed
      from public.expenses e
     where e.vendor_id = p_vendor_id and e.company_id = v_company
       and e.payment_mode = 'Payable'
       and coalesce(e.payable_status, 'Pending') <> 'Paid'
       and (p_expense_id is null or e.id = p_expense_id)
     order by e.expense_date, e.created_at, e.id
     for update of e
  loop
    exit when v_left <= 0;
    continue when b.owed <= 0;
    perform public.assert_branch_writable(b.branch_id);

    v_take := least(v_left, b.owed);
    insert into public.payable_payments (company_id, vendor_payment_id, expense_id, amount)
    values (v_company, v_vp.id, b.id, v_take)
    returning id into v_alloc;

    perform public.post_journal(
      v_company, v_vp.paid_on,
      'Payable paid' || coalesce(' — ' || b.description, '') || ' · ' || coalesce(v_vendor, 'vendor'),
      'payable_payments', v_alloc, false,
      jsonb_build_array(
        jsonb_build_object('key', 'ap', 'debit', v_take, 'credit', 0, 'client_id', b.client_id),
        jsonb_build_object('account_id',
          public.settlement_account(v_company, p_paid_via, v_vp.paid_bank_account_id, v_vp.custodian_location_id, true),
          'debit', 0, 'credit', v_take)),
      b.branch_id);

    if v_take >= b.owed then
      update public.expenses set
        payable_status = 'Paid',
        paid_at = now(),
        updated_at = now()
      where id = b.id;
    end if;

    v_applied := v_applied || jsonb_build_object('expense_id', b.id, 'amount', v_take, 'settled', v_take >= b.owed);
    v_left := v_left - v_take;
  end loop;
  perform set_config('app.payable_payment', '', true);

  if v_left <> 0 then
    raise exception 'The payment could not be applied in full (% left over). Nothing has been recorded.', v_left
      using errcode = 'P0001';
  end if;

  -- The money moves once, for the whole payment.
  perform public.apply_money_delta(
    v_company, p_paid_via, v_vp.paid_bank_account_id, -p_amount,
    'expense', 'Vendor payment (' || lower(p_paid_via) || ') · ' || coalesce(v_vendor, 'vendor'),
    v_vp.id::text);

  return jsonb_build_object('vendor_payment_id', v_vp.id, 'applied', v_applied);
end;
$function$;

-- ── revert_vendor_payment ──────────────────────────────────────────────────────
create or replace function public.revert_vendor_payment(p_vendor_payment_id uuid)
 returns void
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_vp  public.vendor_payments%rowtype;
  a     record;
  v_n   int;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  perform public.assert_same_company((select company_id from public.vendor_payments where id = p_vendor_payment_id));

  select * into v_vp from public.vendor_payments where id = p_vendor_payment_id for update;
  if not found then
    raise exception 'That vendor payment does not exist, or you cannot see it. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  perform set_config('app.payable_payment', '1', true);
  for a in
    select pp.id, pp.expense_id, e.branch_id
      from public.payable_payments pp join public.expenses e on e.id = pp.expense_id
     where pp.vendor_payment_id = v_vp.id
     for update of pp
  loop
    perform public.assert_branch_writable(a.branch_id);
    perform public.reverse_journal_for_source(v_vp.company_id, 'payable_payments', a.id, current_date);
    update public.expenses set payable_status = 'Pending', paid_at = null, updated_at = now()
     where id = a.expense_id and payable_status = 'Paid';
    delete from public.payable_payments where id = a.id;
  end loop;
  perform set_config('app.payable_payment', '', true);

  delete from public.vendor_payments where id = v_vp.id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'The vendor payment could not be removed. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  perform public.apply_money_delta(
    v_vp.company_id, v_vp.paid_via, v_vp.paid_bank_account_id, v_vp.amount,
    'expense', 'Vendor payment reverted (' || lower(v_vp.paid_via) || ')',
    v_vp.id::text);
end;
$function$;

revoke all on function public.pay_vendor_payables(uuid, numeric, text, uuid, uuid, uuid, text) from public, anon;
revoke all on function public.revert_vendor_payment(uuid) from public, anon;
grant execute on function public.pay_vendor_payables(uuid, numeric, text, uuid, uuid, uuid, text) to authenticated;
grant execute on function public.revert_vendor_payment(uuid) to authenticated;
grant select on public.payable_outstanding to authenticated;

-- ── verification ───────────────────────────────────────────────────────────────
-- Each guarded failure is asked about directly, not inferred from a total.
do $mig$
declare v_n int;
begin
  if position('payable_payments' in pg_get_functiondef('public.journal_on_expense_settlement()'::regprocedure)) = 0 then
    raise exception '0470 FAILED: journal_on_expense_settlement does not stand aside for instalment-paid bills.';
  end if;
  if position('vendor_payments' in pg_get_functiondef('public.custodian_held_operational(uuid)'::regprocedure)) = 0 then
    raise exception '0470 FAILED: custodian_held_operational does not subtract cash vendor payments.';
  end if;
  if position('vendor_payments' in pg_get_functiondef('public.partner_ledger(uuid,date,date)'::regprocedure)) = 0 then
    raise exception '0470 FAILED: partner_ledger does not list vendor payments.';
  end if;
  if position('payable_payments' in pg_get_functiondef('public.unposted_source_rows(uuid)'::regprocedure)) = 0 then
    raise exception '0470 FAILED: unposted_source_rows does not cover payable_payments.';
  end if;
  select count(*) into v_n from public.branch_guard_gaps() g
   where g.function_name in ('pay_vendor_payables', 'revert_vendor_payment');
  if v_n <> 0 then
    raise exception '0470 FAILED: branch_guard_gaps() lists the new payment functions % time(s).', v_n;
  end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0470 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
