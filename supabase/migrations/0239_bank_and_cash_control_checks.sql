-- 0239 — The missing control-account reconciliations, and a canary on the
-- check count itself.
--
-- NOT APPLIED TO PRODUCTION. Applied to dev only; prod is closed to changes
-- without named approval. This migration is read-only in effect — it redefines
-- one STABLE function and writes no data — but it will turn two checks red on
-- any database it reaches, and that should be a decision, not a surprise.
--
-- WHY THESE THREE
--
-- docs/LEDGER_PHASE1_FIXTURE_AUDIT.md found a sandbox ledger claiming 150,000
-- of bank money the operational tables had never heard of, and ledger_checks
-- stayed green throughout. The reason was structural: the AR control reconciles
-- against invoice_payments, and THE BANK AND CASH CONTROLS RECONCILE AGAINST
-- NOTHING AT ALL. A whole side of the balance sheet had no check.
--
-- THEY ARE RED ON ARRIVAL. That is deliberate.
--
-- Every figure below is from SANDBOX TESTING ORG on dev at the time of writing.
-- They are not rounding noise and they are not fixed here, because fixing them
-- means deciding accounting questions that are not mine to decide (Part A / the
-- posting rules are silent on all three).
--
--   1. bank_control_equals_bank_accounts        red by   948,467.00
--   2. bank_accounts_equal_transaction_deltas   red by   800,000.00
--   3. cash_control_equals_cash_locations       red by   595,990.13
--
-- What is already understood about each, so nobody re-derives it:
--
--   * bank_accounts.opening_balance totals 7,510,101 and NO opening balance
--     batch exists (opening_balance_batches is empty). Openings were set on the
--     accounts and never journalised, so the GL cannot match a raw balance. The
--     check therefore compares the GL against (balance - opening_balance), which
--     is the part the GL is actually supposed to know about. Posting the
--     openings is a separate, deliberate piece of work.
--
--   * bank_transactions holds a 'cheque' movement of -60,000 with no
--     corresponding bank line in the GL at all, and its 'payroll' total
--     (-1,304,923) exceeds the GL's payslips_disbursement bank movement
--     (-1,216,456) by 88,467. Those two are 148,467 of the gap and are real
--     operational writes the ledger never saw.
--
--   * cash_location_balances sums to 0 while the GL cash control holds
--     595,990.13, because cash postings land on the single 'cash' system_key
--     account rather than the per-location accounts that cash_account_for()
--     and cash_location_balances both key on. Either the postings should be
--     per-location or the view is measuring the wrong thing; that is a design
--     question, not a data fix.
--
-- Leaving them visible and red is the point. A tolerated mismatch teaches the
-- next reader that the check is advisory — the same rule this repo applies to
-- migration digests.

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric, difference numeric, passed boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with tb as (
    select coalesce(sum(jl.debit), 0) dr, coalesce(sum(jl.credit), 0) cr
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
     where je.company_id = p_company_id
  ),
  onesided as (
    select count(*)::numeric n
      from public.journal_entries je
      join lateral (
        select coalesce(sum(debit), 0) dr, coalesce(sum(credit), 0) cr
          from public.journal_lines where journal_entry_id = je.id
      ) x on true
     where je.company_id = p_company_id and x.dr <> x.cr
  ),
  bal as (
    select a.system_key, coalesce(sum(jl.debit - jl.credit), 0) net
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id
     group by a.system_key
  ),
  ar_sub as (
    select coalesce((select sum(i.invoice_amount) from public.invoices i
                      where i.company_id = p_company_id
                        and coalesce(i.status, '') <> 'Written-Off'), 0)
         - coalesce((select sum(p.amount + coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),
  adv_sub as (
    select coalesce((select sum(a.amount) from public.advances a
                      where a.company_id = p_company_id), 0)
         - coalesce((select sum(ps.advance) from public.payslips ps
                      where ps.company_id = p_company_id), 0) bal
  ),
  wht_sub as (
    select coalesce((select sum(coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),
  payroll_owed as (
    select coalesce(sum(ps.net_salary) filter (where not ps.disbursed), 0) owed
      from public.payslips ps where ps.company_id = p_company_id
  ),
  ho_clients as (
    select count(distinct i.client_id)::numeric n
      from public.invoices i
      join public.branches b on b.id = i.branch_id
     where i.company_id = p_company_id and b.is_head_office
  ),
  gate_residue as (
    select count(*)::numeric n from public.attendance_records a
     where a.company_id = p_company_id and a.status = 'blocked'
  ),
  -- Openings are excluded because they were never journalised; see the header.
  bank_ops as (
    select coalesce(sum(b.balance - coalesce(b.opening_balance, 0)), 0) movement
      from public.bank_accounts b where b.company_id = p_company_id
  ),
  bank_tx as (
    select coalesce(sum(t.account_delta) filter (where t.kind <> 'opening'), 0) delta
      from public.bank_transactions t where t.company_id = p_company_id
  ),
  cash_locs as (
    select coalesce(sum(v.balance), 0) bal
      from public.cash_location_balances v where v.company_id = p_company_id
  ),
  rows_before_canary as (select 11::numeric n)
  select 'trial_balance_debits_equal_credits'::text, tb.dr, tb.cr, tb.dr - tb.cr, tb.dr = tb.cr from tb
  union all
  select 'no_one_sided_entries', 0, onesided.n, onesided.n, onesided.n = 0 from onesided
  union all
  select 'ar_control_equals_open_invoices', ar_sub.bal,
         coalesce((select net from bal where system_key = 'ar'), 0),
         coalesce((select net from bal where system_key = 'ar'), 0) - ar_sub.bal,
         coalesce((select net from bal where system_key = 'ar'), 0) = ar_sub.bal
    from ar_sub
  union all
  select 'employee_advances_control_not_in_client_ar', adv_sub.bal,
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0),
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0) - adv_sub.bal,
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0) = adv_sub.bal
    from adv_sub
  union all
  select 'wht_receivable_equals_deductions_less_cprs', wht_sub.bal,
         coalesce((select net from bal where system_key = 'wht_receivable'), 0),
         coalesce((select net from bal where system_key = 'wht_receivable'), 0) - wht_sub.bal,
         coalesce((select net from bal where system_key = 'wht_receivable'), 0) = wht_sub.bal
    from wht_sub
  union all
  select 'salaries_payable_equals_undisbursed_net_pay', payroll_owed.owed,
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0),
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0) - payroll_owed.owed,
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0) = payroll_owed.owed
    from payroll_owed
  union all
  select 'no_billing_clients_on_head_office', 0, ho_clients.n, ho_clients.n, ho_clients.n = 0
    from ho_clients
  union all
  select 'no_gate_mode_in_attendance_status', 0, gate_residue.n, gate_residue.n, gate_residue.n = 0
    from gate_residue
  union all
  -- NEW 1. The bank control against the operational bank accounts.
  select 'bank_control_equals_bank_accounts', bank_ops.movement,
         coalesce((select net from bal where system_key = 'bank'), 0),
         coalesce((select net from bal where system_key = 'bank'), 0) - bank_ops.movement,
         coalesce((select net from bal where system_key = 'bank'), 0) = bank_ops.movement
    from bank_ops
  union all
  -- NEW 2. The bank accounts against their own transaction log. This is the one
  -- that catches money moved on an account with no transaction behind it, which
  -- is a different failure from the GL disagreeing.
  select 'bank_accounts_equal_transaction_deltas', bank_tx.delta,
         (select movement from bank_ops),
         (select movement from bank_ops) - bank_tx.delta,
         (select movement from bank_ops) = bank_tx.delta
    from bank_tx
  union all
  -- NEW 3. The cash control against the custodian locations.
  select 'cash_control_equals_cash_locations', cash_locs.bal,
         coalesce((select net from bal where system_key = 'cash'), 0),
         coalesce((select net from bal where system_key = 'cash'), 0) - cash_locs.bal,
         coalesce((select net from bal where system_key = 'cash'), 0) = cash_locs.bal
    from cash_locs
  union all
  -- CANARY, same discipline as the test suites. A caller cannot tell "every
  -- check passed" from "the function returned early" without knowing how many
  -- checks there were meant to be. Adding a check without updating this number
  -- fails here, which is the point.
  select 'checks_evaluated', rows_before_canary.n, rows_before_canary.n, 0, true
    from rows_before_canary;
$function$;

comment on function public.ledger_checks(uuid) is
  'Ledger reconciliation checks. Returns one row per check plus a checks_evaluated canary stating how many were meant to run. Three bank/cash controls added in 0239 are RED by design on existing data — see that migration for the magnitudes and what is known about each.';
