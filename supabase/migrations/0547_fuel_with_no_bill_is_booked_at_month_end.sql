-- 0547 — fuel spent with no bill is booked at month end
--
-- DECIDED 2026-10-22 (Shayan). A company float card is spent in swipes that
-- only Attock sees; operations hands in trip bills ("300 · visit to site X").
-- So each side records what it has:
--   * accounts enters ops' bills against the card — with a client, or as a
--     GENERAL bill (no client: region cost), "to better help us close the gap
--     with actual and reported";
--   * the Attock portal balance is typed in (0542's reading);
--   * the difference between Bastion's balance for the card on the reading's
--     date and Attock's figure is fuel spent with no bill yet.
-- Operations is chased for the missing bills; whatever is still unbilled AT
-- MONTH END is booked in one step as "Fuel — no bill": a general expense on
-- the card (Dr fuel, Cr the card, the card's region, no client), dated the
-- reading's date, so the card agrees with Attock and the check clears.
--
-- book_unbilled_fuel(card) does that one step and nothing else:
--   * it reads the card's LATEST Attock reading and Bastion's balance on that
--     date; the gap is Bastion minus Attock;
--   * a gap above zero is booked; a gap of zero has nothing to book; a gap
--     below zero (bills exceed what Attock shows spent) is REFUSED — that is
--     a bill entered twice or against the wrong card, and booking anything
--     would hide it;
--   * the expense is written exactly as record_fuel_card_bill writes a bill,
--     so every statement reads it where it reads any other card bill.
--
-- Asserted on the thing that can break, in a block rolled back by a sentinel:
-- a card loaded 10,000, billed 6,800 (one client bill, one general bill), read
-- at 2,000 on Attock has a gap of 1,200; booking it writes one 1,200 general
-- bill dated the reading, after which the card agrees with Attock (the portal
-- check is clear for it) — and a second booking is refused with its message.

create or replace function public.book_unbilled_fuel(p_fuel_card_id uuid)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare
  c public.fuel_cards; b record; v_gap numeric; v_cat uuid; v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('expenses.edit'); end if;
  -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
  if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;

  select * into c from public.fuel_cards where id = p_fuel_card_id;
  if c.id is null or c.role <> 'float' or not c.is_active then
    raise exception 'Only an active company float card has unbilled fuel to book.' using errcode = 'P0001';
  end if;
  perform public.assert_branch_writable(c.branch_id);

  select * into b from public.fuel_card_balances(c.company_id) x where x.fuel_card_id = c.id;
  if b.reading_as_of is null then
    raise exception 'Enter the Attock balance for this card first — the unbilled fuel is what Attock shows spent beyond the bills.' using errcode = 'P0001';
  end if;
  v_gap := round(b.balance_on_reading - b.portal_balance, 2);
  if v_gap = 0 then
    raise exception 'Nothing to book: the bills already account for everything Attock shows spent to %.', b.reading_as_of using errcode = 'P0001';
  end if;
  if v_gap < 0 then
    raise exception 'The bills come to PKR % more than Attock shows spent to %. Check for a bill entered twice or against the wrong card before booking anything.',
      to_char(-v_gap, 'FM999,999,990'), b.reading_as_of using errcode = 'P0001';
  end if;

  select id into v_cat from public.expense_categories where company_id = c.company_id and name = 'Transportation & Fuel';
  if v_cat is null then raise exception 'The expense category "Transportation & Fuel" is missing.' using errcode = 'P0001'; end if;

  insert into public.expenses (
    company_id, category_id, pl_category, client_id, branch_id, description, amount, expense_date, payment_mode, fuel_card_id)
  values (
    c.company_id, v_cat, 'operating_expense'::public.expense_pl_category, null, c.branch_id,
    'Fuel — no bill (Attock balance ' || to_char(b.reading_as_of, 'DD Mon YYYY') || ', ' || c.label || ')',
    v_gap, b.reading_as_of, 'Card', c.id)
  returning id into v_id;
  -- No apply_money_delta: no bank or cash moves; journal_on_expense credits the card.
  return v_id;
end $function$;

revoke all on function public.book_unbilled_fuel(uuid) from public, anon;
grant execute on function public.book_unbilled_fuel(uuid) to authenticated;
comment on function public.book_unbilled_fuel(uuid) is
  'DECIDED 2026-10-22 (0547). Books, at month end, the fuel Attock shows spent on a float card beyond the bills '
  'entered: one general "Fuel — no bill" expense on the card, dated its latest Attock reading. Refuses a negative gap.';

-- ── asserts ───────────────────────────────────────────────────────────────────
do $mig$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_bank uuid; v_br uuid; v_cat uuid; v_cl uuid; v_card uuid; v_exp uuid; v_amt numeric; v_date date; v_client uuid;
begin
  if exists (select 1 from public.tenant_guard_gaps() where function_name = 'book_unbilled_fuel') then
    raise exception '0547 REFUSED: tenant_guard_gaps names book_unbilled_fuel.';
  end if;
  if exists (select 1 from public.branch_guard_gaps() where function_name = 'book_unbilled_fuel') then
    raise exception '0547 REFUSED: branch_guard_gaps names book_unbilled_fuel.';
  end if;

  select b.id into v_bank from public.bank_accounts b where b.company_id = v_co order by b.balance desc limit 1;
  select id into v_br from public.branches where company_id = v_co and name = 'ISB/RWP';
  select id into v_cat from public.expense_categories where company_id = v_co and name = 'Transportation & Fuel';
  select id into v_cl from public.clients where company_id = v_co and name = 'Emaar DHA ISB';

  begin
    v_card := public.register_fuel_card('float', '0547 proof card', v_br);
    perform public.load_fuel_card(v_card, v_bank, 10000, '2026-10-10', 'proof');
    perform public.record_fuel_card_bill(v_card, 5000, '2026-10-15', v_cat, v_cl, v_br, 'proof — client bill');
    perform public.record_fuel_card_bill(v_card, 1800, '2026-10-16', v_cat, null, v_br, 'proof — general bill');
    perform public.record_fuel_card_reading(v_card, '2026-10-20', 2000, 'proof');
    v_exp := public.book_unbilled_fuel(v_card);
    select amount, expense_date, client_id into v_amt, v_date, v_client from public.expenses where id = v_exp;
    if v_amt <> 1200 or v_date <> '2026-10-20' or v_client is not null then
      raise exception '0547 REFUSED: booked % on % (client %), expected 1,200 general on 2026-10-20.', v_amt, v_date, v_client;
    end if;
    if exists (select 1 from public.fuel_card_portal_gaps(v_co) where fuel_card_id = v_card) then
      raise exception '0547 REFUSED: the card still disagrees with Attock after booking.';
    end if;
    begin
      perform public.book_unbilled_fuel(v_card);
      raise exception '0547 REFUSED: a second booking was accepted.';
    exception when others then
      if sqlerrm not like 'Nothing to book: the bills already account for everything Attock shows spent to 2026-10-20.%' then raise; end if;
    end;
    raise exception '0547-SENTINEL';
  exception when others then
    if sqlerrm <> '0547-SENTINEL' then raise; end if;
  end;
  if exists (select 1 from public.fuel_cards where label = '0547 proof card') then
    raise exception '0547 REFUSED: the proof card survived its rollback.';
  end if;
  raise notice '0547: unbilled fuel proved — 1,200 booked general on the reading date; a second booking refused.';
end $mig$;
