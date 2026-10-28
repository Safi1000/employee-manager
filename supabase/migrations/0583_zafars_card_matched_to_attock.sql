-- 0583 — Zafar's card matched to Attock
--
-- Shayan, 28 Oct 2026: "Zafar Iqbal 761.16 current balance" — Attock's
-- portal for ••7724. Bastion held 579.20 because the sheet's four trips of
-- 24–27 Oct (1,698.54, km ÷ 30 × 379.14) estimate more than Attock actually
-- charged (1,516.58). Approved by name: record Attock's 761.16 as of 28 Oct
-- and run Match Attock (0582), which scales those four trips — each in
-- proportion, every client keeping its share — to 1,516.58.
--
-- Asserted: four trips since the 23 Oct reading total 1,516.58; the card
-- holds 761.16; Bastion and Attock agree at the reading.

do $mig$
declare
  v_card uuid := (select id from public.fuel_cards where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and card_last4 = '7724');
  v_msg text; v_total numeric; v_n int; v_bal numeric; v_gap numeric;
begin
  if exists (select 1 from public.fuel_card_readings where fuel_card_id = v_card and as_of = '2026-10-28') then return; end if;  -- replay

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);   -- Shayan Ahmed
  perform public.record_fuel_card_reading(v_card, '2026-10-28', 761.16, 'Attock portal — Shayan, 28 Oct');
  v_msg := public.fuel_card_match_attock(v_card);
  raise notice '0583: %', v_msg;
  -- 0582's match carries the division's scale onto fuel_trips.amount (the
  -- expenses column is numeric(14,2) and rounds itself); hold the trips at the paisa.
  update public.fuel_trips set amount = round(amount, 2)
   where fuel_card_id = v_card and trip_date between '2026-10-24' and '2026-10-28' and amount <> round(amount, 2);

  select count(*), coalesce(sum(amount), 0) into v_n, v_total from public.fuel_trips
   where fuel_card_id = v_card and trip_date between '2026-10-24' and '2026-10-28';
  select coalesce(sum(jl.debit - jl.credit), 0) into v_bal
    from public.journal_lines jl where jl.account_id = (select coa_account_id from public.fuel_cards where id = v_card);
  select round(balance_on_reading - portal_balance, 2) into v_gap
    from public.fuel_card_balances('7f7899a0-edd2-4491-a40d-f81b54c68d1e') where fuel_card_id = v_card;
  if v_n <> 4 or v_total <> 1516.58 then raise exception '0583 REFUSED: % trips totalling %, expected 4 totalling 1,516.58.', v_n, v_total; end if;
  if v_bal <> 761.16 then raise exception '0583 REFUSED: card ••7724 holds %, not 761.16.', v_bal; end if;
  if v_gap <> 0 then raise exception '0583 REFUSED: Bastion and Attock differ by % at the reading.', v_gap; end if;
end $mig$;
