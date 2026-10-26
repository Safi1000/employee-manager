-- 0563 — a vendor's cash refund is cash in the custodian's hands
--
-- Found 2026-10-26 (Shayan): "i have done the refund process and received it
-- but no transaction can be seen in transaction history and anywhere else".
-- 0562's refund of Jamshaid's 2,460 to Gul Rehman posted correctly — the
-- ledger reads Gul at 3,577 — but custodian_held_operational, which Cash in
-- Hand and every custodian balance read, adds up named source documents and
-- had no line for vendor_credit_settlements. It read 1,117 and the check
-- difference 2,460. 0562 added a new way for cash to arrive and did not tell
-- the one function that counts cash arriving — a new document without a reader.
--
-- custodian_held_operational has many authors (0262 … 0545): surgery, anchor
-- asserted once. One term: refunds in Cash to that location, on the same
-- cutover rule as every other term.
--
-- Asserted on the thing that can break: Gul Rehman's operational figure equals
-- his ledger figure (difference 0) — the refund now counted once on each side.

do $surgery$
declare
  v_def text := pg_get_functiondef('public.custodian_held_operational(uuid)'::regprocedure);
  v_anchor constant text := '           as operational';
  v_n int;
begin
  if position('vendor_credit_settlements' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0563 REFUSED: the anchor appears % times in custodian_held_operational.', v_n; end if;
  execute replace(v_def, v_anchor,
    '         + coalesce((select sum(s.amount) from public.vendor_credit_settlements s   -- 0563: a vendor''s cash refund' || E'\n' ||
    '                      where s.kind = ''refund'' and s.paid_via = ''Cash'' and s.custodian_location_id = l.id' || E'\n' ||
    '                        and (not v_posted or s.settled_on > v_cut)), 0)' || E'\n' ||
    v_anchor);
end $surgery$;

do $$
declare v_diff numeric;
begin
  select difference into v_diff from public.custodian_held_operational('7f7899a0-edd2-4491-a40d-f81b54c68d1e')
   where cash_location_id = '5534c2a0-6d50-4d92-bd33-e6ab0cc85a0e';
  if v_diff is distinct from 0 then
    raise exception '0563 REFUSED: Gul Rehman''s cash still differs from his ledger by %.', v_diff;
  end if;
end $$;
