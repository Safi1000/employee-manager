-- 0531 — money is read only by those allowed to see it
--
-- Found 2026-10-21: invoices, invoice_payments, bank_accounts and the ledger
-- (journal_entries, journal_lines) were readable by every signed-in member of
-- the company. Their only read policy is company_members (or via_entry); the
-- write gates are restrictive, the reads were not. The app had stopped asking
-- for them on screens a person may not see (the Dashboard fix), but anyone
-- could still read them directly. Shayan asked for this 2026-10-21.
--
-- NEEDS 0530 FIRST, and the app release that uses it: the bank pickers read
-- bank_account_options(), the cheque totals cheque_linked_amounts(), the
-- overdraft check bank_can_cover() and the month pickers ledger_start_date(),
-- so people who pay from a bank, link a cheque or pick a month no longer need
-- to read the tables this restricts.
--
-- One RESTRICTIVE select policy per table — "perm_read" — beside the existing
-- ones. Who may read:
--
--   invoices          invoices.view, invoices.edit, receivables.view,
--                     accounting.edit, reports.view, cashflow.view,
--                     period_close.manage, accountant.view, reversals.execute
--   invoice_payments  all of the above, and banks.view (cash custody works out
--                     each custodian's cash from cash receipts)
--   bank_accounts     banks.view, accounting.edit, reports.view, cashflow.view,
--                     accountant.view, reversals.execute
--   journal_entries,  reports.view, coa.view, accounting.edit, accountant.view,
--   journal_lines     period_close.manage, reversals.execute
--
-- has_perm() is true for super admins, so they keep everything.
--
-- WHY THESE LISTS. Every SECURITY INVOKER function that reads these tables was
-- listed on prod (2026-10-21) and its callers matched to a key above, because
-- an invoker read under a restrictive policy does not fail — it quietly sees
-- fewer rows (CLAUDE.md, "A set operation is not safe…"):
--   trial_balance_for                   journal   → reports / coa / accountant
--   reversible_actions, reverse_journal_entry     → reversals.execute
--   write_off_receivable                invoices  → receivables / accounting
--   journal_on_invoice_payment (trigger)          → whoever records a receipt,
--                                                   who holds invoices.edit /
--                                                   receivables / accounting
--   enforce_cycle_event(_delete), enforce_supplementary_matches_primary
--                      (invoice triggers)         → invoice writers (invoices.edit)
--   assert_journal_balanced (trigger)             → fires inside the SECURITY
--                                                   DEFINER posting functions
--   enforce_period_lock reads only the row and accounting_periods, not these.
-- The audit log is deliberately NOT gated here: amend_employee_identity and
-- unverify_employee_identity read it as the HR user (SECURITY INVOKER), and a
-- gate would silently change what they see.
--
-- Who loses access: anyone holding none of the keys above — e.g. a clients.view
-- user no longer sees what a client owes on the Clients page, and an HR user
-- cannot read receipts. That is the point.
--
-- Idempotent: drop-and-create by name.

do $$
begin
  if to_regprocedure('public.bank_account_options(uuid)') is null or to_regprocedure('public.cheque_linked_amounts(uuid)') is null
     or to_regprocedure('public.bank_can_cover(uuid,numeric)') is null or to_regprocedure('public.ledger_start_date(uuid)') is null then
    raise exception '0531 REFUSED: 0530 (bank_account_options / cheque_linked_amounts / bank_can_cover / ledger_start_date) is not applied. Apply it, and release the app that uses it, first.';
  end if;
end $$;

drop policy if exists perm_read on public.invoices;
create policy perm_read on public.invoices as restrictive for select using (
  (select public.has_perm('invoices.view')) or (select public.has_perm('invoices.edit')) or (select public.has_perm('receivables.view'))
  or (select public.has_perm('accounting.edit')) or (select public.has_perm('reports.view')) or (select public.has_perm('cashflow.view'))
  or (select public.has_perm('period_close.manage')) or (select public.has_perm('accountant.view')) or (select public.has_perm('reversals.execute')));

drop policy if exists perm_read on public.invoice_payments;
create policy perm_read on public.invoice_payments as restrictive for select using (
  (select public.has_perm('invoices.view')) or (select public.has_perm('invoices.edit')) or (select public.has_perm('receivables.view'))
  or (select public.has_perm('accounting.edit')) or (select public.has_perm('reports.view')) or (select public.has_perm('cashflow.view'))
  or (select public.has_perm('period_close.manage')) or (select public.has_perm('accountant.view')) or (select public.has_perm('reversals.execute'))
  or (select public.has_perm('banks.view')));

drop policy if exists perm_read on public.bank_accounts;
create policy perm_read on public.bank_accounts as restrictive for select using (
  (select public.has_perm('banks.view')) or (select public.has_perm('accounting.edit')) or (select public.has_perm('reports.view'))
  or (select public.has_perm('cashflow.view')) or (select public.has_perm('accountant.view')) or (select public.has_perm('reversals.execute')));

drop policy if exists perm_read on public.journal_entries;
create policy perm_read on public.journal_entries as restrictive for select using (
  (select public.has_perm('reports.view')) or (select public.has_perm('coa.view')) or (select public.has_perm('accounting.edit'))
  or (select public.has_perm('accountant.view')) or (select public.has_perm('period_close.manage')) or (select public.has_perm('reversals.execute')));

drop policy if exists perm_read on public.journal_lines;
create policy perm_read on public.journal_lines as restrictive for select using (
  (select public.has_perm('reports.view')) or (select public.has_perm('coa.view')) or (select public.has_perm('accounting.edit'))
  or (select public.has_perm('accountant.view')) or (select public.has_perm('period_close.manage')) or (select public.has_perm('reversals.execute')));

-- Asserts — on the thing that can break: five restrictive read gates, and
-- every key they name is grantable.
do $$
declare v_n int; v_who text;
begin
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and policyname = 'perm_read' and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
     and tablename in ('invoices', 'invoice_payments', 'bank_accounts', 'journal_entries', 'journal_lines');
  if v_n <> 5 then raise exception '0531 REFUSED: expected 5 restrictive read gates, found %.', v_n; end if;

  select count(*), string_agg(key::text, ', ') into v_n, v_who from public.permission_key_gaps();
  if v_n <> 0 then raise exception '0531 REFUSED: permission_key_gaps() reports %: %', v_n, v_who; end if;

  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ') into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then raise exception '0531 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who; end if;
end $$;
