-- Pin search_path on the journal functions.
--
-- These are SECURITY DEFINER (inherited from migration 0042) but never set a
-- search_path, so they resolve unqualified names against the caller's. A user
-- who can create objects in a schema on that path could shadow something these
-- functions touch and have it run with definer privileges. The region work in
-- 0074 rewrote all of these anyway, so they are pinned here rather than left
-- as the one un-hardened corner of the posting layer.
--
-- ALTER FUNCTION (not CREATE OR REPLACE) keeps the bodies exactly as 0074 left
-- them: this migration changes the security context and nothing else. All of
-- them already schema-qualify every reference, so behaviour is unchanged.

alter function public.post_journal(uuid, date, text, text, uuid, boolean, jsonb, uuid)
  set search_path = public;
alter function public.reverse_journal_for_source(uuid, text, uuid, date)
  set search_path = public;
alter function public.journal_on_invoice()         set search_path = public;
alter function public.journal_on_invoice_payment() set search_path = public;
alter function public.journal_on_expense()         set search_path = public;
alter function public.journal_on_payslip()         set search_path = public;
alter function public.journal_on_advance()         set search_path = public;

-- Same class of issue, same posting layer.
alter function public.coa_id(uuid, text)                          set search_path = public;
alter function public.map_expense_to_coa_key(text, text, uuid)    set search_path = public;
