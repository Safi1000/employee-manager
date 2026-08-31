-- 0267 — Drop cash_location_id from expenses, invoice_payments and advances.
--
-- A column nothing writes and seven things read is not a side effect of the
-- defect; it IS the defect. Leaving it in place after 0264 means the next person
-- to write a posting path has two plausible columns to choose from and no way to
-- tell which is live. The one that is live is custodian_location_id.
--
-- NOT DROPPED, deliberately:
--   payslips.cash_location_id            — still referenced by enforce_period_lock's
--                                          payslip carve-out list, and dropping a
--                                          fourth column is a separate decision;
--                                          it is now inert, not dangerous.
--   cash_deposits.cash_location_id       — the ONLY location column on that table,
--   partner_account_entries.cash_location_id  and the application does write both.
--                                          Correct by construction. Leave alone.
--
-- CONFIRMED NOTHING ELSE READS THE THREE, before dropping:
--   functions  — 0264 repointed all five defective readers; the two remaining
--                readers of the name are journal_on_cash_deposit and
--                journal_on_partner_entry, which read their OWN tables' column
--   views      — cash_location_balances references cash_locations only; it does
--                not touch any of the three tables
--   frontend   — grep -rn cash_location_id src/ returns PartnerDetailModal,
--                custodian.ts, ProjectFinancing (all partner_account_entries) and
--                Treasury.tsx (the view's own output column). None of the three.
--   tests      — period_lock.sql and repost_sets.sql inserted into them; both
--                updated to custodian_location_id in the same change as this.
--   indexes/FKs— dropped with the columns below, explicitly rather than by cascade
--                so anything unexpected raises instead of vanishing.

-- Fail loudly if something still depends on these beyond the indexes and FKs we
-- know about. RESTRICT is the default, but saying it makes the intent explicit:
-- this migration must never silently take a dependent object with it.
do $$
declare v_n int;
begin
  select count(*) into v_n
    from pg_depend d
    join pg_rewrite r on r.oid = d.objid
    join pg_class v on v.oid = r.ev_class
   where d.refobjsubid > 0
     and d.refobjid in ('public.expenses'::regclass,
                        'public.invoice_payments'::regclass,
                        'public.advances'::regclass)
     and v.relkind in ('v', 'm')
     and (select attname from pg_attribute
           where attrelid = d.refobjid and attnum = d.refobjsubid) = 'cash_location_id';
  if v_n > 0 then
    raise exception
      '% view(s)/matview(s) still select cash_location_id from one of the three tables — resolve before dropping',
      v_n using errcode = '2BP01';
  end if;
end $$;

drop index if exists public.idx_expenses_cash_loc;
drop index if exists public.idx_ip_cash_loc;
drop index if exists public.idx_advances_cash_loc;

alter table public.expenses         drop column cash_location_id restrict;
alter table public.invoice_payments drop column cash_location_id restrict;
alter table public.advances         drop column cash_location_id restrict;