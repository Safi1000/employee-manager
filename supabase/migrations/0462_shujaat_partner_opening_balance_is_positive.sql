-- 0462 — Shujaat's partner opening balance is restated as a positive figure.
--
-- Asked 2026-09-18: the Shujaat partner shows a negative balance and it should
-- be positive — "I don't remember the exact figure, but make it positive,
-- opening balance". No corrected figure was supplied, so this flips the SIGN of
-- the existing opening balance and nothing else: same magnitude, same date.
-- If a different amount was intended, it is a new migration with that number.
--
-- Guards, in order:
--   * exactly one partner whose name starts with "Shujaat" — zero or several
--     means this is not the row the request was about, and it refuses;
--   * an opening balance already >= 0 is left alone and reported (replay-safe,
--     and it means the negative figure the user saw is the RUNNING balance —
--     drawings exceeding capital — which a sign flip of the opening would not
--     be the right fix for);
--   * the 0279 lock is honoured by clearing it, writing, and restoring it as
--     found — the documented way out, recorded by the audit trigger on partners.

do $$
declare
  v_n      int;
  v_id     uuid;
  v_name   text;
  v_bal    numeric;
  v_locked boolean;
begin
  select count(*) into v_n from public.partners where name ilike 'shujaat%';
  if v_n <> 1 then
    raise exception '0462 REFUSED: expected exactly one partner named Shujaat…, found %', v_n;
  end if;

  select id, name, opening_balance, coalesce(opening_balance_locked, false)
    into v_id, v_name, v_bal, v_locked
    from public.partners where name ilike 'shujaat%';

  if coalesce(v_bal, 0) >= 0 then
    raise notice '0462: % opening balance is already % — not negative, nothing changed', v_name, v_bal;
    return;
  end if;

  if v_locked then
    update public.partners set opening_balance_locked = false where id = v_id;
  end if;

  update public.partners set opening_balance = -v_bal where id = v_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0462: expected to update 1 partner row, updated %', v_n;
  end if;

  if v_locked then
    update public.partners set opening_balance_locked = true where id = v_id;
  end if;

  raise notice '0462: % opening balance % -> %', v_name, v_bal, -v_bal;
end $$;

-- TENANT GUARD ASSERTION NOT APPLICABLE: this migration changes one data value
-- on one partner row. It creates, alters or drops no function, policy or table,
-- so it cannot open or close a tenant guard.
