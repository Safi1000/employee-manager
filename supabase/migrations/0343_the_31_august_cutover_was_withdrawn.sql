-- 0343 — the 31 August cutover was withdrawn. A record, not a change.
--
-- WHY THIS FILE EXISTS. 0341 is applied on production and its header describes
-- a 31 August 2026 cutover with figures that are now zero. A stale header on a
-- live migration is the same class of defect as 0260 announcing "NOT APPLIED TO
-- PRODUCTION. Dev only." while being applied and armed — the next reader trusts
-- the header, because a header cannot fail. This file is the correction, and it
-- is deliberately numbered after 0341 so anyone reading forward meets it.
--
-- WHAT HAPPENED, 2026-09-03, on instruction:
--
--   * the 19 August invoices were reversed (soft delete: invoice rows deleted,
--     19 reversing journal entries posted, the 24 originals kept)
--   * 0341 restated clients.opening_balance to the 31 August receivable,
--     15,791,559 across 31 clients
--   * the single 2026-08-31 opening batch was staged, 23,064,296, and NEVER
--     POSTED
--   * then the whole position was withdrawn: every opening balance to zero, the
--     last remaining invoice (GGS-26-DTL-09) deleted, and all three opening
--     batches removed
--
-- THE WITHDRAWAL IS PARTIAL. Bank and cash have since been RESTORED, on
-- instruction, as the real figures as at 31 August 2026:
--
--     Soneri Bank  — 0021302080546878      576,083
--     Askari Bank  — 03410420001645      3,619,821
--     Allied Bank  — 0010058433050017      707,902
--     Bank Of AJK  — 2812446001          2,368,041
--     bank total                         7,271,847
--     Gul Rehman (cash location)               890
--     treasury.cash_balance                    890
--
-- Both `opening_balance` AND `balance` were restored to the same figure on each
-- bank account. They were equal before because no bank movement has ever been
-- recorded, and that is still true; restoring one and not the other would leave
-- two columns disagreeing about the same account.
--
-- CLIENT RECEIVABLE OPENINGS REMAIN AT ZERO. Shayan is re-entering them.
-- So the position today is: bank and cash exist operationally with NOTHING in
-- the general ledger, and bank_control_equals_bank_accounts,
-- cash_control_equals_cash_locations and bank_per_account_gl_equals_operational
-- are RED because of it. That is those checks doing their job, not a fault.
-- They go green when an opening batch is posted.
--
-- THE FIGURES ARE NOT LOST. 0339 carries the 1 August receivable openings per
-- client (12,131,900 over 18 clients) and 0341 carries the 31 August restatement
-- (15,791,559 over 31 clients), both in full, keyed by client_code. The bank and
-- cash figures are above. Nothing has to be re-derived from an invoice set that
-- no longer exists — which matters, because it no longer exists.
--
-- KEEP 0341's ar_sub AMENDMENT. DO NOT REVERT IT AS PART OF UNDOING THE CUTOVER.
-- 0341 taught ar_control_equals_open_invoices that the receivable subledger is
-- invoices plus clients.opening_balance. That is correct whenever an opening
-- exists and harmless while the column is zero, where it adds nothing to either
-- side. Reverting it would leave the check blind again the moment Shayan
-- re-enters the openings — which is the next thing that happens.
--
-- THE JOURNAL WAS NOT ERASED, and anyone reading the ledger later needs to know
-- why August billing and its reversal are both there. 44 entries stand: the 24
-- originals, the 19 invoice reversals, and DTL-09's. 1100 is zero BY REVERSAL,
-- not by deletion. journal_entries and journal_lines are immutable
-- (enforce_journal_immutable) and nothing bypassed that — no maintenance
-- session was used at any point.
--
-- WHAT THIS FILE CHANGES: nothing. It asserts the two facts that must stay true
-- and would be silent failures if they stopped being true.

do $$
declare
  v_co uuid := (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD');
  v_def text;
  v_entries int;
begin
  -- (1) The ar_sub amendment survives. If someone reverts it while undoing the
  --     cutover, the receivable check goes blind the moment openings return.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks_base';
  if v_def is null then
    raise exception '0343 REFUSED: ledger_checks_base does not exist';
  end if;
  if v_def not ilike '%sum(c.opening_balance)%' then
    raise exception
      '0343 FAILED: 0341''s ar_sub amendment is gone from ledger_checks_base. ar_control_equals_open_invoices no longer counts clients.opening_balance, so it will read green while an opening receivable sits in 1100 with nothing on the subledger side. Re-apply it — see 0341.';
  end if;

  -- (2) The journal was not erased. Reversal, not deletion, is what took 1100
  --     to zero; this notices if anyone "tidies" that history later.
  if v_co is not null then
    select count(*) into v_entries from public.journal_entries where company_id = v_co;
    if v_entries < 44 then
      raise exception
        '0343 FAILED: GGS carries % journal entries, fewer than the 44 that stood when the cutover was withdrawn. The ledger is append-only and 1100 was cleared by reversal, not deletion — entries do not go down.', v_entries;
    end if;
    raise notice '0343: GGS at % journal entries; ar_sub amendment intact.', v_entries;
  else
    raise notice '0343: GGS not on this database; recorded for the repo only.';
  end if;
end $$;
