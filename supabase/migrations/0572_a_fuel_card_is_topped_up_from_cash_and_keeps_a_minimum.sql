-- 0572 — a fuel card is topped up from cash too, and keeps a minimum balance
--
-- DECIDED 2026-10-28 (Shayan), over Zafar Iqbal's October fuel sheet and the
-- Attock statement for card ••7724:
--   * "We top it up 10,000": a float card is a wallet topped back up each
--     month. The cash handed over for it IS the top-up — cash → card, an asset
--     moving, not an expense. The fuel is spent as the card is used, and that
--     spending is the bills (the trip-sheet lines) against the card.
--   * Zafar's October 9,239 was cash actually paid; it was entered today as a
--     cash expense ("Monthly Fuel Expense Sheet 01.10–31.10", pending approval).
--   * Transition "From 23 Oct only": the card exists in Bastion from its
--     23 Oct opening (2,277.74, Attock). So the 9,239 becomes a top-up from
--     Zafar's cash custody, dated 28 Oct, and only the sheet lines AFTER the
--     opening become bills on the card. Lines up to 23 Oct stay where they
--     are: paid for by September's top-up already booked on 13 Oct.
--   * A trip line is charged to a client only when it names one client
--     ("Client only if single"); otherwise it is a general (region) cost.
--   * "From now onwards no office petrol is reimbursed if it is through cash
--     only allowed to expense it through card thats why it is important to
--     maintain a minimum balance in it" — the cash-petrol refusal is on the
--     Expenses screen (same commit); the minimum is fuel_cards.min_balance,
--     set per card, and the Fuel Cards screen flags a card below it.
--
-- What this changes:
--   * fuel_card_loads: a load comes from a bank OR a cash custodian — exactly
--     one (bank_account_id becomes nullable; custodian_location_id added).
--   * load_fuel_card_from_cash — new: apply_money_delta('Cash'), Dr card /
--     Cr the custodian's cash account (settlement_account, as a cash expense
--     credits it).
--   * reverse_fuel_card_load (0542 its only author) — restated behind a digest
--     precondition, to give the money back to whichever side it came from.
--   * custodian_held_operational (many authors) — surgery: a cash top-up comes
--     out of the custodian's operational cash, exactly as the cash expense it
--     replaces did. Anchor asserted once.
--   * fuel_cards.min_balance + set_fuel_card_min_balance (accounting.edit, the
--     key every fuel-card money write already asks).
--   * Zafar's October: the pending 9,239 cash expense is deleted through
--     delete_expense (its money and journal reversed), the same 9,239 is
--     loaded onto ••7724 from his custody on 28 Oct, and four bills go on the
--     card for 24–27 Oct (1,698.54).
--
-- Asserted on what can break:
--   (1) Zafar's custody — operational and GL — is exactly where it was: the
--       cash left once, as a top-up instead of an expense;
--   (2) the company's cash in hand did not move;
--   (3) card ••7724 holds 2,277.74 + 9,239 − 1,698.54 = 9,818.20;
--   (4) the pending expense is gone, and October's fuel expense fell by
--       9,239 − 1,698.54 = 7,540.46 (the pre-23-Oct lines, already paid for);
--   (5) no tenant or branch guard gaps.

-- ── loads from cash ─────────────────────────────────────────────────────────
alter table public.fuel_card_loads alter column bank_account_id drop not null;
alter table public.fuel_card_loads
  add column if not exists custodian_location_id uuid references public.cash_locations(id);
alter table public.fuel_card_loads drop constraint if exists fuel_card_loads_one_source;
alter table public.fuel_card_loads add constraint fuel_card_loads_one_source
  check (num_nonnulls(bank_account_id, custodian_location_id) = 1);
comment on column public.fuel_card_loads.custodian_location_id is
  '0572: a top-up paid in cash from this custodian''s custody (the bank_account_id is then null). Exactly one source per load.';

create or replace function public.load_fuel_card_from_cash(
  p_fuel_card_id uuid, p_custodian_location_id uuid, p_amount numeric, p_loaded_on date, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
  declare c public.fuel_cards; v_loc public.cash_locations; v_id uuid; v_desc text; v_je uuid;
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
    -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
    if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
    -- tenant guard [resolved]: owning company from p_custodian_location_id via public.cash_locations
    if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;

    select * into c from public.fuel_cards where id = p_fuel_card_id;
    if c.id is null or c.role <> 'float' or not c.is_active then
      raise exception 'Only an active company float card is topped up here. An allowance is paid onto a card from payroll. Nothing has been recorded.' using errcode = 'P0001';
    end if;
    perform public.assert_branch_writable(c.branch_id);
    select * into v_loc from public.cash_locations where id = p_custodian_location_id;
    if v_loc.id is null or v_loc.company_id is distinct from c.company_id
       or (v_loc.custodian_employee_id is null and v_loc.custodian_partner_id is null) then
      raise exception 'Choose the person whose cash paid for the top-up. Nothing has been recorded.' using errcode = 'P0001';
    end if;
    if p_amount is null or p_amount <= 0 then raise exception 'The top-up must be more than zero. Nothing has been recorded.' using errcode = 'P0001'; end if;
    if p_loaded_on is null then raise exception 'Enter the date of the top-up. Nothing has been recorded.' using errcode = 'P0001'; end if;

    insert into public.fuel_card_loads (company_id, fuel_card_id, custodian_location_id, amount, loaded_on, note)
    values (c.company_id, c.id, v_loc.id, round(p_amount, 2), p_loaded_on, nullif(btrim(p_note), ''))
    returning id into v_id;

    v_desc := 'Fuel card topped up from cash — ' || c.label || ' · ' || v_loc.name || coalesce(' · ' || nullif(btrim(p_note), ''), '');
    perform public.apply_money_delta(c.company_id, 'Cash', null, -round(p_amount, 2), 'fuel_card', v_desc, v_id::text);
    v_je := public.post_journal(c.company_id, p_loaded_on, v_desc, 'fuel_card_loads', v_id, false,
      jsonb_build_array(
        jsonb_build_object('account_id', c.coa_account_id, 'debit', round(p_amount, 2), 'credit', 0),
        jsonb_build_object('account_id', public.settlement_account(c.company_id, 'Cash', null, v_loc.id), 'debit', 0, 'credit', round(p_amount, 2))),
      c.branch_id);
    update public.fuel_card_loads set journal_id = v_je where id = v_id;
    return v_id;
  end $$;
comment on function public.load_fuel_card_from_cash(uuid, uuid, numeric, date, text) is
  '0572: top up a float card from a custodian''s cash. Cash → card: Dr the card''s 1020.NN, Cr the custodian''s cash account. Not an expense.';
revoke all on function public.load_fuel_card_from_cash(uuid, uuid, numeric, date, text) from public, anon;
grant execute on function public.load_fuel_card_from_cash(uuid, uuid, numeric, date, text) to authenticated;

-- ── reversing a load gives the money back to where it came from ─────────────
do $restate$
declare v_h text := md5(pg_get_functiondef('public.reverse_fuel_card_load(uuid, text)'::regprocedure));
begin
  if position('0572' in pg_get_functiondef('public.reverse_fuel_card_load(uuid, text)'::regprocedure)) > 0 then return; end if;  -- replay
  if v_h <> '0135411a32fcd653cbb3aaf021c5a718' then
    raise exception '0572 REFUSED: reverse_fuel_card_load is not the body 0542 wrote (md5 %); an unrecorded edit would be lost by restating it.', v_h;
  end if;
  execute $f$
create or replace function public.reverse_fuel_card_load(p_load_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $body$
  declare l public.fuel_card_loads; c public.fuel_cards; v_bal numeric; v_n int;
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
    -- tenant guard [resolved]: owning company from p_load_id via public.fuel_card_loads
    if p_load_id is not null then perform public.assert_same_company((select company_id from public.fuel_card_loads where id = p_load_id)); end if;
    if length(btrim(coalesce(p_reason, ''))) < 5 then
      raise exception 'Say why this load is being reversed (a few words at least).' using errcode = 'P0001';
    end if;
    select * into l from public.fuel_card_loads where id = p_load_id for update;
    if l.id is null then raise exception 'That load does not exist.' using errcode = 'P0001'; end if;
    select * into c from public.fuel_cards where id = l.fuel_card_id;
    perform public.assert_branch_writable(c.branch_id);
    select coalesce(sum(jl.debit - jl.credit), 0) into v_bal from public.journal_lines jl where jl.account_id = c.coa_account_id;
    if v_bal < l.amount - 0.005 then
      raise exception 'The card holds PKR % — less than this load of PKR %, so part of it has been spent. Reverse the bills first.',
        to_char(v_bal, 'FM999,999,990'), to_char(l.amount, 'FM999,999,990') using errcode = 'P0001';
    end if;
    -- 0572: back to the side it came from — the bank, or the custodian's cash.
    if l.custodian_location_id is not null then
      perform public.apply_money_delta(l.company_id, 'Cash', null, l.amount, 'fuel_card',
        'Fuel card top-up reversed — ' || c.label || ' · ' || btrim(p_reason), l.id::text);
    else
      perform public.apply_money_delta(l.company_id, 'Bank', l.bank_account_id, l.amount, 'fuel_card',
        'Fuel card load reversed — ' || c.label || ' · ' || btrim(p_reason), l.id::text);
    end if;
    perform public.reverse_journal_for_source(l.company_id, 'fuel_card_loads', l.id, l.loaded_on);
    delete from public.fuel_card_loads where id = l.id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'The load could not be reversed.' using errcode = 'P0001'; end if;
  end $body$
$f$;
end $restate$;

-- ── a cash top-up leaves the custodian's operational cash ───────────────────
do $surgery$
declare
  v_def text := pg_get_functiondef('public.custodian_held_operational(uuid)'::regprocedure);
  v_anchor constant text := E'\n           as operational\n';
  v_n int;
begin
  if position('0572' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0572 REFUSED: the operational anchor appears % times in custodian_held_operational.', v_n; end if;
  execute replace(v_def, v_anchor,
E'\n         - coalesce((select sum(fl.amount) from public.fuel_card_loads fl   -- 0572: a fuel card topped up from this cash\n' ||
E'                      where fl.custodian_location_id = l.id and (not v_posted or fl.loaded_on > v_cut)), 0)' ||
v_anchor);
end $surgery$;

-- ── a card keeps a minimum ──────────────────────────────────────────────────
alter table public.fuel_cards add column if not exists min_balance numeric
  check (min_balance is null or min_balance >= 0);
comment on column public.fuel_cards.min_balance is
  '0572: the least a float card should hold (office petrol is paid on the card only, from 29 Oct 2026). Set on the Fuel Cards screen; a card below it is flagged there for a top-up. Null = no minimum set.';

create or replace function public.set_fuel_card_min_balance(p_fuel_card_id uuid, p_min_balance numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
  declare c public.fuel_cards; v_n int;
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
    -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
    if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
    select * into c from public.fuel_cards where id = p_fuel_card_id;
    if c.id is null or c.role <> 'float' then
      raise exception 'A minimum balance is set on a company float card only. Nothing has been changed.' using errcode = 'P0001';
    end if;
    perform public.assert_branch_writable(c.branch_id);
    if p_min_balance is not null and p_min_balance < 0 then
      raise exception 'The minimum cannot be below zero. Nothing has been changed.' using errcode = 'P0001';
    end if;
    update public.fuel_cards set min_balance = round(p_min_balance, 2), updated_at = now() where id = c.id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'The card could not be updated. Nothing has been changed.' using errcode = 'P0001'; end if;
  end $$;
revoke all on function public.set_fuel_card_min_balance(uuid, numeric) from public, anon;
grant execute on function public.set_fuel_card_min_balance(uuid, numeric) to authenticated;

-- ── Zafar's October onto card ••7724 ────────────────────────────────────────
do $zafar$
declare
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_exp  constant uuid := '89a8fb6b-f6f0-443d-ae28-3a7d213a1860';
  v_loc  constant uuid := '3d042bb5-2348-4d86-9c12-49e593de4f9a';   -- Zafar Iqbal's custody
  v_fuel constant uuid := 'ecee23a6-4d40-45e1-8c26-1c0c3c47c3ae';   -- Transportation & Fuel
  v_card uuid;
  v_op0 numeric; v_gl0 numeric; v_cash0 numeric; v_fuel0 numeric;
  v_op1 numeric; v_gl1 numeric; v_cash1 numeric; v_fuel1 numeric; v_bal numeric;
begin
  select id into v_card from public.fuel_cards where company_id = v_co and card_last4 = '7724' and role = 'float';
  if v_card is null then raise exception '0572 REFUSED: card ••7724 not found.'; end if;
  if exists (select 1 from public.fuel_card_loads where fuel_card_id = v_card and custodian_location_id = v_loc and loaded_on = '2026-10-28') then
    return;  -- replay
  end if;
  if not exists (select 1 from public.expenses where id = v_exp and amount = 9239 and payment_mode = 'Cash'
                  and custodian_location_id = v_loc and approved_at is null and fuel_card_id is null) then
    raise exception '0572 REFUSED: the pending 9,239 cash fuel expense is not as recorded (changed or approved since).';
  end if;

  select operational, gl into v_op0, v_gl0 from public.custodian_held_operational(v_co) where cash_location_id = v_loc;
  select cash_balance into v_cash0 from public.treasury where company_id = v_co;
  select coalesce(sum(amount), 0) into v_fuel0 from public.expenses
   where company_id = v_co and category_id = v_fuel and expense_date between '2026-10-01' and '2026-10-31';

  perform public.delete_expense(v_exp);
  perform public.load_fuel_card_from_cash(v_card, v_loc, 9239, '2026-10-28',
    'October top-up, Zafar''s fuel sheet 01–31 Oct (was entered as a cash expense on 28 Oct)');
  perform public.record_fuel_card_bill(v_card, 454.97, '2026-10-24', v_fuel, 'd71fb2a3-d8d4-488f-a43b-41056d6ee6fa', null,
    'Fuel sheet (Zafar) 24 Oct — GGS–Raising Sun & back, GGS–Dolmen & back · 36 km');
  perform public.record_fuel_card_bill(v_card, 492.88, '2026-10-25', v_fuel, null, null,
    'Fuel sheet (Zafar) 25 Oct — GGS–Emaar–AWT–Dolmen–GGS · 39 km');
  perform public.record_fuel_card_bill(v_card, 543.43, '2026-10-26', v_fuel, null, null,
    'Fuel sheet (Zafar) 26 Oct — GGS–Humak PS–Dolmen–DHA-3–MIU–AWT–Emaar–Dolmen City · 43 km');
  perform public.record_fuel_card_bill(v_card, 207.26, '2026-10-27', v_fuel, '79ddc2fe-d119-4b18-8a73-6a807029bdb6', null,
    'Fuel sheet (Zafar) 27 Oct — GGS–Sweet Palace–GGS · 16.4 km');

  select operational, gl into v_op1, v_gl1 from public.custodian_held_operational(v_co) where cash_location_id = v_loc;
  select cash_balance into v_cash1 from public.treasury where company_id = v_co;
  select coalesce(sum(amount), 0) into v_fuel1 from public.expenses
   where company_id = v_co and category_id = v_fuel and expense_date between '2026-10-01' and '2026-10-31';
  select coalesce(sum(jl.debit - jl.credit), 0) into v_bal
    from public.journal_lines jl where jl.account_id = (select coa_account_id from public.fuel_cards where id = v_card);

  if v_op1 is distinct from v_op0 or v_gl1 is distinct from v_gl0 then
    raise exception '0572 REFUSED: Zafar''s custody moved — operational % → %, GL % → %.', v_op0, v_op1, v_gl0, v_gl1;
  end if;
  if v_cash1 is distinct from v_cash0 then
    raise exception '0572 REFUSED: cash in hand moved % → %.', v_cash0, v_cash1;
  end if;
  if v_bal <> 9818.20 then
    raise exception '0572 REFUSED: card ••7724 holds %, not 9,818.20.', v_bal;
  end if;
  if exists (select 1 from public.expenses where id = v_exp) or v_fuel0 - v_fuel1 <> 7540.46 then
    raise exception '0572 REFUSED: October fuel expense moved by %, not 7,540.46 (or the pending expense is still there).', v_fuel0 - v_fuel1;
  end if;
end $zafar$;

do $$
begin
  if exists (select 1 from public.tenant_guard_gaps()) then
    raise exception '0572 REFUSED: tenant_guard_gaps() reports a gap.';
  end if;
  if exists (select 1 from public.branch_guard_gaps()
              where function_name in ('load_fuel_card_from_cash', 'set_fuel_card_min_balance', 'reverse_fuel_card_load')) then
    raise exception '0572 REFUSED: branch_guard_gaps() reports a new fuel-card function.';
  end if;
end $$;
