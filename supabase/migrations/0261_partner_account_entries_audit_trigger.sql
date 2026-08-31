-- 0261 — partner_account_entries gets the audit trigger it never had.
--
-- NOT APPLIED TO PRODUCTION. Dev only. Prod is closed to changes without
-- named approval.
--
-- WHY, AND HOW IT SURFACED
--
-- 0257 fixed journal_on_partner_entry to repost when an entry changes partner.
-- The obvious follow-up question was whether any row had ever changed partner_id
-- — because a yes means a partner's capital is wrong right now, not merely that
-- it could become wrong.
--
-- THAT QUESTION COULD NOT BE ASKED. advances, cheques, expenses, invoices and
-- payslips all carry log_audit_change. partner_account_entries carried only
-- fill_company_id and its journal trigger. Thirty-five tables have an audit
-- trigger; the one holding partner capital movements was not among them.
--
-- The question was answered from STATE instead — does any posting name a
-- different partner than the row it came from — which is the better question
-- and is now the standing form. But "the better question" was not a choice
-- here; it was the only question available, and that is the defect.
--
-- WHAT THIS DOES NOT FIX
--
-- History before this migration does not exist and cannot be reconstructed.
-- The table is empty on both environments (0 rows prod, 0 rows dev), so nothing
-- is actually lost — this lands before the rows do, which is the only reason
-- the gap closes cleanly rather than leaving a permanent blind window. F4 is
-- about to start writing these rows; that is the deadline this beat.
--
-- ADJACENT GAP, REPORTED NOT FIXED
--
-- public.partners has no audit trigger either, and journal_on_partner_entry
-- depends on three of its columns — coa_account_id, scope, branch_id — none of
-- which trigger a repost when they change (docs/REPOST_SET_AUDIT.md, the
-- cross-table staleness item). So both sides of that dependency are currently
-- unaudited. Adding it is a separate decision and is not taken here.

drop trigger if exists trg_zzz_partner_account_entries_audit on public.partner_account_entries;

create trigger trg_zzz_partner_account_entries_audit
  after insert or update or delete on public.partner_account_entries
  for each row
  execute function public.log_audit_change();
