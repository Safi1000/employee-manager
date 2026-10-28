-- 0578 — Shujaat's opening balance is his accumulated Kashmir profit
--
-- DECIDED 2026-10-28 (Shayan): "3 million withdrawn from bank of ajk is
-- straight away his opening balance from kashmir region … similarly 1 million
-- at the start withdrawn by him from soneri was his opening balance from
-- kashmir as he usually used to accumulate it there and then withdraw and no
-- proper record exists as of today … bank of ajk only has kashmir region
-- payments and expenses and he was saving there for a long time."
--
-- So at 1 Sep 2026 GGS owed Shujaat 4,000,000 of Kashmir profit he had left in
-- the banks — Soneri 1,000,000 (drawn 14 Sep, "Wusat Payment") and Bank of AJK
-- 3,000,000 (drawn 3 Oct). His partner record held 1,000,000 with no date; it
-- now holds 4,000,000 at 1 Sep, and the two drawings say what they drew on.
--
-- As the 1,000,000 was, the opening is on the partner record (partner_ledger
-- starts from it); it is not a journal line on his capital account — no
-- partner opening is. Unchanged here; noted so it is not mistaken for a gap.
--
-- Asserted: his ledger stands at 4,623,145.19 owed to him at 30 Sep and at
-- −220,854.81 today (it was −3,220,854.81: 3,000,000 more opening, nothing else).

do $mig$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_p  uuid := (select id from public.partners where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and name = 'Shujaat Mehmood');
  v_sep numeric; v_now numeric; v_n int;
begin
  if v_p is null then raise exception '0578 REFUSED: Shujaat Mehmood not found.'; end if;
  if (select opening_balance from public.partners where id = v_p) = 4000000 then return; end if;  -- replay
  if (select opening_balance from public.partners where id = v_p) <> 1000000 then
    raise exception '0578 REFUSED: Shujaat''s opening is not the 1,000,000 it was.';
  end if;

  update public.partners set opening_balance = 4000000, opening_balance_date = '2026-09-01', updated_at = now() where id = v_p;

  update public.partner_account_entries
     set description = 'Wusat Payment — from his opening balance (accumulated Kashmir profit held in Soneri)'
   where partner_id = v_p and type = 'DRAWING' and date = '2026-09-14' and amount = 1000000 and description = 'Wusat Payment';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception '0578 REFUSED: the 14 Sep Soneri drawing was not found as recorded.'; end if;
  update public.partner_account_entries
     set description = 'Drawing — from his opening balance (accumulated Kashmir profit held in Bank of AJK)'
   where partner_id = v_p and type = 'DRAWING' and date = '2026-10-03' and amount = 3000000 and description = 'Drawing';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception '0578 REFUSED: the 3 Oct Bank of AJK drawing was not found as recorded.'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);   -- Shayan, to read the ledger
  select 4000000 + coalesce(sum(remuneration - cash_paid), 0) into v_sep from public.partner_ledger(v_p, '2026-09-01', '2026-09-30');
  select 4000000 + coalesce(sum(remuneration - cash_paid), 0) into v_now from public.partner_ledger(v_p, '2026-09-01', '2026-10-31');
  if v_sep <> 4623145.19 or v_now <> -220854.81 then
    raise exception '0578 REFUSED: Shujaat''s ledger stands at % (30 Sep) and % (now), not 4,623,145.19 and −220,854.81.', v_sep, v_now;
  end if;
end $mig$;
