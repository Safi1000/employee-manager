-- 0259 — The bank and cash control checks must read their sub-ledgers.
--
-- NOT APPLIED TO PRODUCTION. Dev only. Prod is closed to changes without
-- named approval.
--
-- WHY THIS EXISTS, AND WHY IT MUST LAND BEFORE THE OPENING BATCH POSTS
--
-- G1 was approved with one change: route bank openings per account rather than
-- to the single 1010 control. Investigating how to build that turned up that
-- IT IS ALREADY BUILT AND HAS NEVER BEEN USED.
--
--   * sync_bank_account_cash_location() mirrors every bank_accounts row into a
--     cash_locations row of location_type 'BANK'.
--   * ensure_cash_location_account() fills that row's coa_account_id from
--     allocate_cash_location_account(), which already branches on the type:
--     'BANK' hangs under the `bank` control, everything else under `cash`.
--   * SANDBOX therefore already has 1010.01 … 1010.09 (nine banks) and
--     1000.01 … 1000.05 (five custodians), all active, all parented correctly.
--
-- Every one of those fourteen sub-accounts has ZERO journal lines. The bank
-- control 1010 carries 123 lines and -728,456.00; the cash control 1000 carries
-- 15 lines and 595,990.13. The structure is right and nothing posts into it.
--
-- So no new COA shape is proposed here. The shape is parent control with
-- `<code>.NN` children, because that is what the code already creates.
--
-- THE CHECKS CANNOT SEE THE SUB-LEDGER — AND WOULD HAVE PUNISHED THE FIX
--
-- ledger_checks() derives every balance from
--
--     group by a.system_key
--
-- and the sub-accounts carry system_key = NULL by construction: only one
-- account per company may claim a given key. So the checks read the control
-- row's OWN lines and are blind to every child.
--
-- That is not a cosmetic gap. Posting the openings per account, with the checks
-- as they stand, would have moved both checks the WRONG WAY:
--
--   bank_control_equals_bank_accounts
--     actual  (system_key='bank' only) unchanged at -728,456.00 — the 7,510,101
--     lands entirely on children the check does not read
--     expected still (balance - opening_balance) = -1,676,923.00
--     -> red by 948,467.00, unchanged, while the money is demonstrably posted
--
--   cash_control_equals_cash_locations
--     expected is a sum over cash_location_balances, WHICH INCLUDES THE BANK
--     LOCATIONS — they are cash_locations rows too. Their balances are 0.00
--     today, which is the only reason this check has ever looked coherent.
--     Post 7,510,101 to 1010.01…09 and the expected side jumps by that amount
--     while the cash control does not move:
--     -> red by 595,990.13 becomes red by 8,106,091.13
--
-- The cash check would have gone red by eight million because the bank openings
-- posted correctly. This is docs/TENANT_GUARD_REPORT.md §9.6 instance fourteen
-- again — an audit's detection rule is itself a claim — and it is why the
-- amendment ships in front of the data rather than behind it.
--
-- WHAT CHANGES
--
--   1. bank and cash balances are summed over the account SUBTREE (control plus
--      descendants), not over the system_key row alone.
--   2. bank_control_equals_bank_accounts expects sum(balance), not
--      sum(balance - opening_balance). The subtraction existed only because the
--      openings were never journalised. Once they are, it is wrong.
--   3. cash_control_equals_cash_locations excludes BANK-type locations from the
--      expected side. They reconcile against the bank control, not this one.
--
-- bank_accounts_equal_transaction_deltas KEEPS the movement basis. It compares
-- account movement against the transaction log, and openings are excluded from
-- both sides of it deliberately. Two different questions, two different bases;
-- that is why `bank_total` and `bank_ops` are separate CTEs below.
--
-- WHAT DOES NOT CHANGE
--
-- No check goes green here, and one difference deliberately gets BIGGER.
-- Measured on dev immediately before and after applying this migration:
--
--                                        expected      actual   difference
--   bank_control ... before          -1,676,923.00  -728,456.00     948,467.00
--   bank_control ... after            5,833,178.00  -728,456.00  -6,561,634.00
--   cash_control ... before                   0.00   595,990.13     595,990.13
--   cash_control ... after                    0.00   595,990.13     595,990.13
--
-- The bank difference moves because its BASIS moved, not because anything was
-- posted. Asking "does the GL hold the money the bank accounts say exists" is
-- a different question from "does the GL hold the movement", and the honest
-- answer to the new question is that 6,561,634.00 of it is missing — of which
-- 7,510,101.00 is openings this migration does not post and 948,467.00 is the
-- pre-existing residual 0239 documented. Posting the openings takes it to
-- 948,467.00 and no further; that residual is G3's and G6's, not this one's.
--
-- The cash difference is unchanged at 595,990.13 because the custodian
-- locations sum to 0.00 with or without the BANK rows. It is still the routing
-- defect 0239 named, it is still G2's, and it is not touched here.

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric, difference numeric, passed boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with recursive tb as (
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
  -- 0259. The cash and bank sub-ledgers. A control's balance is the control
  -- plus every account beneath it; the children carry system_key = NULL, so
  -- `bal` above cannot be used for these two.
  ctl_tree as (
    select a.id, a.system_key as root_key
      from public.chart_of_accounts a
     where a.company_id = p_company_id
       and a.system_key in ('cash', 'bank')
    union all
    select c.id, t.root_key
      from public.chart_of_accounts c
      join ctl_tree t on c.parent_id = t.id
     where c.company_id = p_company_id
  ),
  ctl_net as (
    select t.root_key, coalesce(sum(jl.debit - jl.credit), 0) net
      from ctl_tree t
      left join public.journal_lines jl on jl.account_id = t.id
     group by t.root_key
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
  empty_entries as (
    select count(*)::numeric n from public.journal_entries je
     where je.company_id = p_company_id
       and not exists (select 1 from public.journal_lines jl
                        where jl.journal_entry_id = je.id)
  ),
  -- 0259. Full balances now that the openings are journalised.
  bank_total as (
    select coalesce(sum(b.balance), 0) total
      from public.bank_accounts b where b.company_id = p_company_id
  ),
  -- Movement only, and deliberately so: this feeds the transaction-log check,
  -- whose other side excludes 'opening' rows. Do not merge with bank_total.
  bank_ops as (
    select coalesce(sum(b.balance - coalesce(b.opening_balance, 0)), 0) movement
      from public.bank_accounts b where b.company_id = p_company_id
  ),
  bank_tx as (
    select coalesce(sum(t.account_delta) filter (where t.kind <> 'opening'), 0) delta
      from public.bank_transactions t where t.company_id = p_company_id
  ),
  -- 0259. BANK-type locations mirror bank accounts and reconcile against the
  -- bank control. Counting them here made this check double-count every bank.
  cash_locs as (
    select coalesce(sum(v.balance) filter (where v.location_type <> 'BANK'), 0) bal
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
  -- 0259: subtree, and the full balance rather than the movement.
  select 'bank_control_equals_bank_accounts', bank_total.total,
         coalesce((select net from ctl_net where root_key = 'bank'), 0),
         coalesce((select net from ctl_net where root_key = 'bank'), 0) - bank_total.total,
         coalesce((select net from ctl_net where root_key = 'bank'), 0) = bank_total.total
    from bank_total
  union all
  -- Unchanged basis: movement against the transaction log.
  select 'bank_accounts_equal_transaction_deltas', bank_tx.delta,
         (select movement from bank_ops),
         (select movement from bank_ops) - bank_tx.delta,
         (select movement from bank_ops) = bank_tx.delta
    from bank_tx
  union all
  -- 0259: subtree, and custodian locations only.
  select 'cash_control_equals_cash_locations', cash_locs.bal,
         coalesce((select net from ctl_net where root_key = 'cash'), 0),
         coalesce((select net from ctl_net where root_key = 'cash'), 0) - cash_locs.bal,
         coalesce((select net from ctl_net where root_key = 'cash'), 0) = cash_locs.bal
    from cash_locs
  union all
  select 'checks_evaluated', rows_before_canary.n, rows_before_canary.n, 0, true
    from rows_before_canary;
$function$;

comment on function public.ledger_checks(uuid) is
  'Ledger reconciliation checks. Returns one row per check plus a checks_evaluated canary stating how many were meant to run. The bank and cash controls read their whole subtree (0259) because per-location sub-accounts carry system_key = NULL; bank expects the full balance now that openings are journalised, and cash counts custodian locations only.';
