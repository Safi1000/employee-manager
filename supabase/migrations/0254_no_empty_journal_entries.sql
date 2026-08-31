-- 0254 — The zero-pass audit owed by §9.6, and the one hole it found.
--
-- NOT APPLIED TO PRODUCTION. Dev only.
--
-- THE QUESTION
--
-- "A check whose pass condition is zero must be able to state what non-zero
-- input would have produced." Three checks were named as owing that answer and
-- not audited: no_one_sided_entries, no_billing_clients_on_head_office,
-- no_gate_mode_in_attendance_status. Answered below by measurement, not by
-- reading the SQL.
--
--   no_gate_mode_in_attendance_status
--     ANSWERED BY LIVE DATA. It is RED right now: 24 on GUARDS AND GUIDES
--     (PVT) LTD. A check that is currently non-zero on a real company cannot
--     be vacuous, and no guard needs adding.
--
--   no_billing_clients_on_head_office
--     ANSWERED BY LIVE DATA. Also RED right now: 1 on SANDBOX TESTING ORG.
--     Same conclusion.
--
--   no_one_sided_entries
--     Zero on all four companies, including SANDBOX TESTING ORG with 307
--     entries and a 23.26m trial balance, so live data answers nothing. Probed
--     directly instead, in a rolled-back transaction: inserting a single
--     debit-only journal_line moved it 0 -> 1. Nothing constrains journal_lines
--     to balance, so the red input is real and reachable. NOT VACUOUS.
--
-- THE HOLE THE PROBE FOUND
--
-- The same probe inserted a journal_entries row with NO LINES AT ALL and the
-- check stayed at 0. It sums debit and credit over an entry's lines and
-- compares them; with no lines both sums are 0, 0 = 0, and the entry is scored
-- balanced.
--
-- So the check reads "no entry is one-sided" and means "no entry that posted
-- anything is one-sided". An entry that posted NOTHING is invisible to it —
-- and that is exactly the residue a posting which half-failed leaves behind:
-- a header with a date, a company, a source_table and a source_id, claiming a
-- transaction the ledger never actually recorded. It contributes nothing to the
-- trial balance, so trial_balance_debits_equal_credits cannot see it either.
-- Neither can the AR, bank or cash controls, which reconcile amounts.
--
-- It is a header that says a posting happened where no posting happened, and no
-- check in the set could report it. That is the reason for a separate check
-- rather than a widened one: no_one_sided_entries' name is accurate about what
-- it measures, and making it quietly also mean "and no empty ones" would be the
-- "mentions is not checks" failure in a new place.
--
-- The canary rises 11 -> 12 in the same statement, which is the mechanism 0239
-- put there for exactly this.

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric, difference numeric, passed boolean)
language sql
stable
security definer
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
  -- NEW. An entry with no lines is balanced by the arithmetic above and is not
  -- balanced by any accounting definition. See the header.
  empty_entries as (
    select count(*)::numeric n
      from public.journal_entries je
     where je.company_id = p_company_id
       and not exists (
         select 1 from public.journal_lines jl where jl.journal_entry_id = je.id)
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
  -- Openings are excluded because they were never journalised; see 0239.
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
  rows_before_canary as (select 12::numeric n)
  select 'trial_balance_debits_equal_credits'::text, tb.dr, tb.cr, tb.dr - tb.cr, tb.dr = tb.cr from tb
  union all
  select 'no_one_sided_entries', 0, onesided.n, onesided.n, onesided.n = 0 from onesided
  union all
  select 'no_empty_journal_entries', 0, empty_entries.n, empty_entries.n, empty_entries.n = 0
    from empty_entries
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
  select 'bank_control_equals_bank_accounts', bank_ops.movement,
         coalesce((select net from bal where system_key = 'bank'), 0),
         coalesce((select net from bal where system_key = 'bank'), 0) - bank_ops.movement,
         coalesce((select net from bal where system_key = 'bank'), 0) = bank_ops.movement
    from bank_ops
  union all
  select 'bank_accounts_equal_transaction_deltas', bank_tx.delta,
         (select movement from bank_ops),
         (select movement from bank_ops) - bank_tx.delta,
         (select movement from bank_ops) = bank_tx.delta
    from bank_tx
  union all
  select 'cash_control_equals_cash_locations', cash_locs.bal,
         coalesce((select net from bal where system_key = 'cash'), 0),
         coalesce((select net from bal where system_key = 'cash'), 0) - cash_locs.bal,
         coalesce((select net from bal where system_key = 'cash'), 0) = cash_locs.bal
    from cash_locs
  union all
  select 'checks_evaluated', rows_before_canary.n, rows_before_canary.n, 0, true
    from rows_before_canary;
$function$;

comment on function public.ledger_checks(uuid) is
  'Ledger reconciliation checks. Returns one row per check plus a checks_evaluated canary stating how many were meant to run. Three bank/cash controls added in 0239 are RED by design on existing data. no_empty_journal_entries was added in 0254 after a probe found that an entry with no lines is scored balanced by no_one_sided_entries and is invisible to every amount-based control.';
