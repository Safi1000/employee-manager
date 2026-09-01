-- 0280 — Drop treasury.cash_opening_balance and treasury.cash_opening_locked.
--
-- There were two opening-balance concepts for cash and the ledger used the
-- other one. `custodian_held_operational()` opens each custodian from
-- `cash_locations.opening_balance`; the GL's own openings come from
-- `opening_balance_batches`. `treasury.cash_opening_balance` was written and
-- read only by `Accounting.tsx` — no function, no view, no other page. Anyone
-- setting it and expecting the ledger to move would have been wrong, and
-- nothing said so.
--
-- Found by the direction-2 read/write sweep (docs/LEDGER_UNWIRED_SWEEP.md):
-- columns the application writes and nothing reads.
--
-- `cash_opening_locked` goes with it. It is the lock for the column being
-- dropped; keeping a flag that guards a value that no longer exists is the
-- same defect one level down.
--
-- FRONTEND CHANGED IN THE SAME COMMIT — a dropped column that the app still
-- writes is an outage, not a cleanup:
--
--   Accounting.tsx   the insert and update no longer send either column;
--                    "opening already set" is now DERIVED from the opening
--                    `bank_transactions` row this page already writes
--                    (kind = 'opening', bank_account_id is null), which is the
--                    record that actually exists rather than a second flag that
--                    can disagree with it.
--   supabase.ts      the Treasury type no longer declares them.
--
-- The feature itself is unchanged from the user's side: the "Set Opening"
-- control still appears once and the figure still shows. It now reads its state
-- from the transaction log instead of from a flag nothing else consulted.

do $$
declare v_n int;
begin
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~ '\y(cash_opening_balance|cash_opening_locked)\y';
  if v_n > 0 then
    raise exception '0280: % function(s) still reference the treasury opening columns', v_n;
  end if;

  select count(*) into v_n
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('v', 'm')
     and pg_get_viewdef(c.oid) ~ '\y(cash_opening_balance|cash_opening_locked)\y';
  if v_n > 0 then
    raise exception '0280: % view(s) still reference the treasury opening columns', v_n;
  end if;
end $$;

alter table public.treasury drop column if exists cash_opening_balance restrict;
alter table public.treasury drop column if exists cash_opening_locked restrict;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'treasury'
                and column_name in ('cash_opening_balance', 'cash_opening_locked')) then
    raise exception '0280: a treasury opening column survived the drop';
  end if;
end $$;