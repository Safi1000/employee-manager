-- 0574 — Shafqat paid his Lahore settlement from Askari
--
-- Shayan, 28 Oct 2026: "we have transferred him his remaining 2,766,727" —
-- one transfer from Askari Bank, today, about fifteen minutes before this was
-- written. It is the 678,103 (Berger, September) + 2,088,624 (Popular,
-- Jun–Sep) that 0573 left as owed to him: his cash holding stood at
-- −2,766,727, and this brings it to zero.
--
-- Recorded through record_bank_to_custodian, the path every bank-to-custodian
-- transfer takes (Askari down, his custody up, journal Dr his cash / Cr
-- Askari). That function asks accounting.edit of the caller, so it runs here
-- as Shayan — the transaction's own claim, set for this transaction only.
--
-- Askari stood at 6,899,115.42, the closing balance agreed against its
-- statement; this transfer is after that statement, so it is not in it.
--
-- Asserted: Askari falls by exactly 2,766,727; Shafqat's holding is 0 and its
-- ledger agrees.

do $mig$
declare
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_bank constant uuid := '1df9eaa6-afdb-48d1-8f8e-8c69ba867787';   -- Askari Bank
  v_loc  constant uuid := '36c4c1ee-9630-4919-8e8d-f425953ff984';   -- Shafqat Ali Raza's cash
  v_note constant text := 'Lahore settlement to Maj Shafqat — Berger Sep 678,103 + Popular Jun–Sep 2,088,624 (0573)';
  b0 numeric; b1 numeric; h0 numeric; h1 numeric; g1 numeric;
begin
  if exists (select 1 from public.bank_transactions where kind = 'withdraw_to_cash' and reference_id = v_loc::text and description = v_note) then
    return;  -- replay
  end if;
  select operational into h0 from public.custodian_held_operational(v_co) where cash_location_id = v_loc;
  if h0 <> -2766727 then
    raise exception '0574 REFUSED: Shafqat''s holding is %, not −2,766,727 as 0573 left it.', h0;
  end if;
  select balance into b0 from public.bank_accounts where id = v_bank;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);   -- Shayan Ahmed
  perform public.record_bank_to_custodian(v_bank, v_loc, 2766727, '2026-10-28', v_note);

  select balance into b1 from public.bank_accounts where id = v_bank;
  select operational, difference into h1, g1 from public.custodian_held_operational(v_co) where cash_location_id = v_loc;
  if b0 - b1 <> 2766727 then
    raise exception '0574 REFUSED: Askari fell by %, not 2,766,727.', b0 - b1;
  end if;
  if h1 <> 0 or abs(g1) > 0.005 then
    raise exception '0574 REFUSED: Shafqat''s holding is % (ledger difference %), not 0.', h1, g1;
  end if;
end $mig$;
