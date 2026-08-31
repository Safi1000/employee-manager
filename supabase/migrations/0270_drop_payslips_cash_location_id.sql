-- 0270 — Drop payslips.cash_location_id, the last survivor of the G2 dead column.
--
-- 0267 dropped the dead `cash_location_id` from expenses, invoice_payments and
-- advances. `payslips` was not in that list because 0263 was adding
-- `custodian_location_id` to the same table in the same series, and dropping a
-- column from a table while adding its replacement in an adjacent migration is
-- how a half-migrated table happens. The consequence is that payslips has
-- carried BOTH columns since — one live, one dead — which is worse than either
-- state on its own: a reader has to know which is which, and nothing in the
-- schema says.
--
-- CONFIRMED DEAD, by the same method 0267 used, before dropping:
--   functions reading `cash_location_id`   journal_on_cash_deposit,
--                                          journal_on_partner_entry  (cash_deposits
--                                          and partner_account_entries — those
--                                          tables have ONLY this column and the
--                                          app writes it; correct, left alone)
--                                          custodian_held_operational (ditto)
--                                          enforce_period_lock (the payslip
--                                          carve-out LIST, removed below)
--   views                                  cash_location_balances (on
--                                          cash_locations, not payslips)
--   frontend                               PartnerDetailModal, custodian.ts,
--                                          ProjectFinancing, Treasury — all
--                                          partner_account_entries or
--                                          cash_location_balances
--   tests                                  repost_sets.sql (cash_deposits)
--   payslips rows with a value             0
--
-- `restrict` rather than `cascade`: if something does depend on it, the drop
-- must fail loudly rather than take the dependant with it.

do $$
declare v_n bigint;
begin
  select count(*) into v_n from public.payslips where cash_location_id is not null;
  if v_n > 0 then
    raise exception '0270: % payslips carry a cash_location_id — investigate before dropping', v_n;
  end if;
end $$;

alter table public.payslips drop column if exists cash_location_id restrict;

-- The carve-out list named a column that no longer exists. `to_jsonb(old) - key`
-- tolerates a missing key, so this would never have raised — it would simply
-- have gone on telling readers that payslips has a cash_location_id worth
-- exempting. Removed programmatically, for the reason 0264 gives.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'enforce_period_lock';

  if v_def is null then
    raise exception '0270: enforce_period_lock not found';
  end if;

  v_new := replace(v_def, '''cash_location_id'', ''custodian_location_id''', '''custodian_location_id''');
  if v_new = v_def then
    if position('''cash_location_id''' in v_def) = 0 then
      raise notice '0270: carve-out already clean';
      return;
    end if;
    raise exception '0270: cash_location_id is in enforce_period_lock in an unexpected form; read it before editing';
  end if;
  execute v_new;
end $$;

-- Prove it: the column is gone and the carve-out no longer names it.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'payslips'
                and column_name = 'cash_location_id') then
    raise exception '0270: payslips.cash_location_id still exists';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'enforce_period_lock'
                and p.prosrc ~ '''cash_location_id''') then
    raise exception '0270: enforce_period_lock still names cash_location_id';
  end if;
end $$;