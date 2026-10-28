-- 0581 — Zafar's 9,239 was never a top-up
--
-- Shayan, 28 Oct 2026: "how tf you added the balance of 9,818 on zafar card
-- those were details of expenses???????" — and, asked whether any cash was
-- handed to Zafar against the 9,239: "no". Attock shows ••7724 at 761.16.
--
-- 0572 read "Yes — cash was paid" as the card being topped up from Zafar's
-- cash, deleted the pending 9,239 cash expense and booked a 9,239 cash top-up
-- of the card instead. Wrong: the 9,239 was his October fuel sheet — the
-- detail of what the card spent — and no cash moved. This reverses that
-- top-up through reverse_fuel_card_load (cash back to his custody, journal
-- reversed, the load row removed). Kept, at Shayan's word ("keep Zafar's sheet
-- lines (Rs 1,698.54, with the clients named)"): the four bills for 24–27 Oct.
--
-- After: the card holds 2,277.74 − 1,698.54 = 579.20 (Attock 761.16; the
-- 181.96 is the sheet's km estimate over the actual fill-ups of 25–26 Oct,
-- 1,516.58, and stays visible on the Attock check). Zafar's custody is back to
-- 0 — as it stood before the 9,239 was entered (his ±25,000 GL difference is
-- older and untouched).
--
-- Asserted: the card holds 579.20; Zafar's operational custody is 0; no load
-- remains on the card.

do $mig$
declare
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_loc  constant uuid := '3d042bb5-2348-4d86-9c12-49e593de4f9a';   -- Zafar Iqbal's custody
  v_card uuid := (select id from public.fuel_cards where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and card_last4 = '7724');
  v_load uuid; v_bal numeric; v_hold numeric;
begin
  select id into v_load from public.fuel_card_loads
   where fuel_card_id = v_card and custodian_location_id = v_loc and amount = 9239 and loaded_on = '2026-10-28';
  if v_load is null then return; end if;  -- replay: already reversed

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);   -- Shayan Ahmed
  perform public.reverse_fuel_card_load(v_load,
    'Not a top-up: the 9,239 was the detail of October''s card expenses, and no cash was handed to Zafar (Shayan, 28 Oct)');

  select coalesce(sum(jl.debit - jl.credit), 0) into v_bal
    from public.journal_lines jl where jl.account_id = (select coa_account_id from public.fuel_cards where id = v_card);
  select operational into v_hold from public.custodian_held_operational(v_co) where cash_location_id = v_loc;
  if v_bal <> 579.20 then raise exception '0581 REFUSED: card ••7724 holds %, not 579.20.', v_bal; end if;
  if v_hold <> 0 then raise exception '0581 REFUSED: Zafar''s custody is %, not 0.', v_hold; end if;
  if exists (select 1 from public.fuel_card_loads where fuel_card_id = v_card) then
    raise exception '0581 REFUSED: a load remains on card ••7724.';
  end if;
end $mig$;
