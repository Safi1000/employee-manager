-- 0136: Fix RLS on cash_locations + custody_transfers so "view as company" works.
--
-- These two tables still carried the OLD `company_isolation` policy, which compares
-- against the raw profiles.company_id:
--     company_id = (select company_id from profiles where id = auth.uid())
-- A super_super_admin has company_id = NULL and operates via view_as_company, so that
-- comparison is NULL → every read/write is denied. This first surfaced now because the
-- custodian feature (0135) is the first code that INSERTs a cash_location from the
-- "viewing as" context — hence "new row violates row-level security policy".
--
-- The modern finance tables (expenses, invoice_payments, treasury) already use:
--   • company_members : company_id = current_company_id()   [= coalesce(view_as_company, company_id)]
--   • ssa_all         : is_ssa_unscoped()                    [unscoped super_super_admin sees all]
-- This migration aligns cash_locations + custody_transfers with that pattern. No data
-- is touched — only the access rules change.

-- cash_locations ------------------------------------------------------------
drop policy if exists company_isolation on public.cash_locations;

create policy company_members on public.cash_locations
  for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

create policy ssa_all on public.cash_locations
  for all
  using (public.is_ssa_unscoped())
  with check (public.is_ssa_unscoped());

-- custody_transfers ---------------------------------------------------------
drop policy if exists company_isolation on public.custody_transfers;

create policy company_members on public.custody_transfers
  for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

create policy ssa_all on public.custody_transfers
  for all
  using (public.is_ssa_unscoped())
  with check (public.is_ssa_unscoped());
