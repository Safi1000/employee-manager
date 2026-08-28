-- 0211 — partner_account_entries never saved from the app: two gaps vs every
-- other tenant table.
--   1. company_id is NOT NULL but nothing filled it (no BEFORE INSERT trigger),
--      so the insert failed the not-null constraint.
--   2. RLS keyed on the raw profiles.company_id, ignoring "view as company",
--      and had no super-super-admin bypass — so a SSA operating inside another
--      company could never insert even after (1).
-- Bring it in line with expenses: fill_company_id() + current_company_id()
-- isolation + is_ssa_unscoped() bypass.

create trigger trg_aaa_partner_entries_fill_company
  before insert on public.partner_account_entries
  for each row execute function public.fill_company_id();

drop policy if exists company_isolation on public.partner_account_entries;

create policy company_members on public.partner_account_entries
  for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

create policy ssa_all on public.partner_account_entries
  for all
  using (public.is_ssa_unscoped())
  with check (public.is_ssa_unscoped());
