# Phase 1 Part C — Posting Rules

**Date:** 2026-08-29
**Status:** For approval. Nothing in this table has been applied to the database.
**Policy source:** Part A of the Phase 1 brief (locked). Events enumerated from §2/§3 of `docs/LEDGER_PHASE0_DISCOVERY.md`.

Legend for **Status**:
- **READY** — unambiguous under locked policy; drafted in `supabase/migrations/0221_posting_rules_ar_and_cash.sql` (written, not applied).
- **DRAFT** — rule is determined by policy but not yet written.
- **BLOCKED** — implementing it reveals a genuine contradiction or a silence in Part A. Listed in §5. Not resolved here.

Basis column: **Accrual @ <date>** = recognised when earned/incurred; **Cash @ <date>** = recognised when money moves; **Transfer** = balance-sheet only, no P&L.

---

## 1. Revenue and receivables

| # | Event | Debit | Credit | Dimensions required | Basis | Source table | Status |
|---|---|---|---|---|---|---|---|
| 1 | Invoice raised | Accounts Receivable = `invoice_amount` (gross, incl. sales tax) | Revenue (security/guard) = `invoice_amount − tax_added_total`; **Sales Tax Payable** = `tax_added_total` | client_id, contract_id, branch_id | Accrual @ `period_start` (**A4** — service month, not `invoice_date`) | `invoices` | READY |
| 2 | Invoice edited | reverse #1 in full, repost | — | as #1 | as #1 | `invoices` | READY |
| 3 | Receipt recorded | Bank **or** Custodian Cash = `amount`; **WHT Receivable** = `withholding_amount` | Accounts Receivable = `amount + withholding_amount` | client_id, branch_id | Cash @ `payment_date` | `invoice_payments` | READY |
| 4 | Incoming cheque cleared | — (inserts an `invoice_payments` row; #3 posts it) | — | as #3 | as #3 | `cheques` → `invoice_payments` | READY |
| 5 | CPR received from client | Income Tax Payable | WHT Receivable | client_id | Cash @ CPR date | *no table exists* | **BLOCKED** (§5.3) |
| 6 | Receivable written off | Bad Debt Expense | Accounts Receivable | client_id, branch_id | Accrual @ write-off date | `invoices` | **BLOCKED** (§5.4) |
| 7 | Sales tax remitted | Sales Tax Payable | Bank | branch_id | Cash @ payment date | `statutory_filings` | DRAFT |

**A1 note.** WHT is recognised at *payment*, never at invoice, because the deduction is only known when the client pays. The receivable is raised gross and cleared by cash + WHT together. All logic computing outstanding as `invoice_amount − withholding_tax − amount_received` is removed.

**A2 note.** `tax_added_total` is split out of `invoice_amount`. Current exposure is **Rs 0** (all 7 sandbox invoices have `tax_added_total = 0`), but the relationship `invoice_amount = subtotal + tax_added_total` holds exactly, so revenue would be overstated by the output tax the moment a taxable client is invoiced.

---

## 2. Payroll

| # | Event | Debit | Credit | Dimensions required | Basis | Source table | Status |
|---|---|---|---|---|---|---|---|
| 8 | Payroll accrued (month end, regardless of disbursement) | Payroll Expense — COS or Opex by employee category = `final_salary` (**gross**, A6) | Salaries Payable = `final_salary` | employee_id, client_id, branch_id | Accrual @ `period_month` | `payslips` | **BLOCKED** (§5.1) |
| 9 | Statutory deducted / contributed | *depends on §5.1* | EOBI Payable, Salary Tax Payable | employee_id, client_id | Accrual @ `period_month` | `payslips` | **BLOCKED** (§5.1, §5.2) |
| 10 | Advance recovered from payroll | Salaries Payable = `advance` | Employee Advances Receivable = `advance` | employee_id | Accrual @ `period_month` | `payslips` | **BLOCKED** — depends on #8 |
| 11 | Payroll disbursed | Salaries Payable = `net_salary` | Bank **or** Custodian Cash = `net_salary` (**A6**) | employee_id, branch_id | Cash @ `disbursed_at` (cheque: clear date) | `payslips` (source `payslips_disbursement`) | **BLOCKED** — depends on #8 |
| 12 | Statutory remitted (EOBI/PESSI/tax) | EOBI Payable / Salary Tax Payable | Bank | branch_id | Cash @ payment date | `statutory_filings` | DRAFT |

**A5 note.** The current trigger recognises payroll *only on disbursement* but dates it to the accrual month at the accrual amount — neither cash nor accrual. It is replaced by the two-step above, using the already-seeded and never-used `salaries_payable`.

**Intended identity after #8–#11:** `Salaries Payable` nets to zero per payslip:
`final_salary − advance − eobi − income_tax − net_salary = 0`. This identity **holds on 48/48 sandbox payslips** — which is precisely what creates the contradiction in §5.1.

---

## 3. Employee advances

| # | Event | Debit | Credit | Dimensions required | Basis | Source table | Status |
|---|---|---|---|---|---|---|---|
| 13 | Advance issued | **Employee Advances Receivable** (never client `ar` — **A7**) | Bank **or** Custodian Cash | employee_id, client_id, branch_id | Cash @ `advance_date` | `advances` | **APPLIED** (0219) |
| 14 | Advance recovered | see #10 | | | | | BLOCKED |
| 15 | Advance written off on exit | see #24 | | | | | BLOCKED |

---

## 4. Expenses, cash and banking

| # | Event | Debit | Credit | Dimensions required | Basis | Source table | Status |
|---|---|---|---|---|---|---|---|
| 16 | Expense recorded (cash/bank) | Classified expense account (**A11**) | Cash **or** Bank | client_id, branch_id, cost_center | Accrual @ `expense_date` | `expenses` | DRAFT (A11 fn pending) |
| 17 | Expense recorded (payable) | Classified expense account | Accounts Payable | client_id, branch_id, cost_center | Accrual @ `expense_date` | `expenses` | DRAFT |
| 18 | **Payable settled** | Accounts Payable | Bank **or** Custodian Cash | client_id, branch_id | Cash @ `paid_at` | `expenses` (source `expense_settlements`) | READY — fixes **D2** |
| 19 | **Bank → custodian float** | Custodian Cash (that custodian's account) | Bank | branch_id | Transfer @ date | `custody_float` | READY — **A8** |
| 20 | **Cash cheque cleared to custodian** | Custodian Cash | Bank | branch_id | Transfer @ `cheque_date` | `cheques` | READY — **A8** |
| 21 | Outgoing **payment** cheque | **no posting** | — | — | — | `cheques` | READY (see note) |
| 22 | Custodian → custodian | Custodian Cash (to) | Custodian Cash (from) | branch_id (both sides) | Transfer @ date | `custody_transfers` | Already correct |
| 23 | Cash deposited to bank | Bank | Custodian Cash | branch_id | Transfer @ `deposit_date` | `cash_deposits` | Already correct |
| 24 | Monthly bank zeroing | **none — delete this** | — | — | — | `apply_monthly_account_zeroing` | **BLOCKED** (§5.6) |

**#21 note — deliberate.** The brief lists outgoing cheques as "currently posting nothing that must post". Analysis says only *cash* cheques must post. A payment cheque's linked expense / advance / payslip **already** credits bank through its own trigger; posting the cheque as well would double-credit the outflow. The gap this leaves is timing only (bank is credited at document date, not cheque clearance date) — closing it properly needs an *Unpresented Cheques* clearing account, which is a policy choice (§5.5).

---

## 5. Partner current accounts (A9)

### (i) Cash agency — pure balance-sheet, independent of profit

| # | Event | Debit | Credit | Dimensions required | Basis | Source table | Status |
|---|---|---|---|---|---|---|---|
| 25 | Client pays into partner's own/linked bank | Partner Current Account | Accounts Receivable | partner_id, client_id | Cash @ payment date | `invoice_payments` | DRAFT |
| 26 | Cash custody handed to partner | Partner Current Account | Custodian Cash / Bank | partner_id | Transfer @ date | `custody_transfers` | DRAFT |
| 27 | Partner pays guard payroll from own account | Salaries Payable | Partner Current Account | partner_id, employee_id | Cash @ date | `payslips` | BLOCKED — depends on #8 |
| 28 | Partner pays an expense from own account | Classified expense account | Partner Current Account | partner_id, client_id | Accrual @ `expense_date` | `expenses` | DRAFT |
| 29 | Partner issues an advance from own account | Employee Advances Receivable | Partner Current Account | partner_id, employee_id | Cash @ `advance_date` | `advances` | DRAFT |
| 30 | Partner contribution | Cash / Bank | Partner Capital | partner_id | Cash @ date | `partner_account_entries` | Already correct |
| 31 | Partner drawing | Partner Capital | Cash / Bank | partner_id | Cash @ date | `partner_account_entries` | Already correct |
| 32 | Partner opening balance | Opening Balance Equity | Partner Capital | partner_id | @ `opening_balance_date` | `partner_account_entries` | **APPLIED** (0219 seeded the missing account; was one-sided) |

**Exclusion rule (A9 i).** A transfer between two company bank accounts where the partner is neither source nor destination **must never** appear in a partner's ledger. Enforced by requiring `partner_id` on the line, rather than by the current `partner_ledger()` approach of unioning raw operational tables.

### (ii) Profit waterfall — regional remuneration is an EXPENSE, equity is the residual

| # | Event | Debit | Credit | Dimensions required | Basis | Source table | Status |
|---|---|---|---|---|---|---|---|
| 33 | Regional partner share (positive) | **Regional Partner Remuneration** (expense) | Partner Current Account | partner_id, client_id, branch_id | Accrual @ month (amount computed cash-basis) | `profit_allocation_runs` | **BLOCKED** (§5.7) |
| 34 | Regional partner share (**negative** — loss-making client) | Partner Current Account | Regional Partner Remuneration | partner_id, client_id, branch_id | as #33 | `profit_allocation_runs` | BLOCKED |
| 35 | Equity partner distribution | Retained Earnings | Partner Current Account | partner_id | Accrual @ month | `profit_allocation_runs` | BLOCKED |

Sequence per A9(ii): per-client Net Cash after payroll, direct expenses and the **nested** regional+HO allocation → regional share at that partner's **per-client** rate (honouring `partner_client_shares` effective dating, negative shares netting per your decision) → sum and post as expense → company profit = Net Cash − total regional remuneration → equity partners take 100% of the residual by equity %.

**The current implementation is wrong and must be removed:** equity and regional shares are treated as separate pools, which over-allocates (100% equity + 15% + 20% = 135% of profit). `partnership_allocation()` is also compute-only and writes no journal entry.

---

## 6. Periodic, asset and inter-region

| # | Event | Debit | Credit | Dimensions required | Basis | Source table | Status |
|---|---|---|---|---|---|---|---|
| 36 | Opening balances at cutover | per line | per line | branch_id, and client/partner where applicable | @ `as_of_date` | `opening_balance_batches` | Already correct |
| 37 | Fixed asset purchased | Fixed Assets — <category> | Bank / Cash / AP | branch_id | Accrual @ `acquisition_date` | `fixed_assets` | Already correct |
| 38 | Depreciation | Depreciation Expense | Accumulated Depreciation | branch_id | Accrual @ month end | `depreciation_entries` | Already correct |
| 39 | Asset disposed | Cash/Bank + Accum. Dep. | Fixed Asset + Gain (or Dr Loss) | branch_id | Accrual @ disposal | `fixed_assets` | Already correct |
| 40 | HO cost allocation (**A10** step 1) | Allocated HO Cost (region) | HO Cost Recovery (HO) | branch_id | Accrual @ month | `ho_allocation_runs` | Needs A10 driver review |
| 41 | Inter-region funding | Inter-Region Receivable (lender) | Inter-Region Payable (borrower) | branch_id both sides | @ `txn_date` | `interregion_transactions` | Already correct |
| 42 | Reserve funded | Reserve (asset) | Bank | branch_id | Transfer @ date | `reserve_funding` | Already correct |
| 43 | Bonus provision / true-up | Bonus Expense | Bonus Provision | branch_id | Accrual @ year end | `bonus_trueup` | Already correct |
| 44 | Final settlement on exit | Salaries Payable (undisbursed) | Employee Advances Receivable (outstanding) + Bank/Cash (net) + kit recovery? | employee_id, branch_id | Cash @ release date | `clearance_certificates` | **BLOCKED** (§5.8) |
| 45 | Period close | no posting — lock only | — | — | — | `accounting_periods` | Already correct |

**A10 note.** HO cost is nested *inside* regional cost at step 1, then regions apportion to clients at step 2. Because it is nested, HO must **not** also appear as a separate additive deduction at client level — which `client_statement_loaded()` currently does (it applies a regional pool *and* an HO pool to the same client). Driver must follow the basis: revenue basis → invoiced amount; cash basis → cash received; never mixed within one report.

**A11 note.** One classification function decides Cost of Services vs Regional Opex vs Head Office vs Income Tax, and every report calls it. `map_expense_to_coa_key()` is the nearest thing today but classifies by category *name string* and does not distinguish regional opex from HO.

---

## 7. Blocking questions

Part A says to stop and ask rather than resolve. Eight items.

### 5.1 — EOBI: employee deduction or employer cost? (blocks all of §2)

Measured on **48/48** sandbox payslips:

```
net_salary = final_salary − advance − eobi − income_tax
```

EOBI **reduces the guard's net pay**, i.e. it behaves as an employee-side deduction. But **A3** describes EOBI/IESSI/PESSI as *"paid on guards deployed to that client, and charged as a direct cost of that client"* — an employer cost. Both cannot be true of the single `eobi` column.

- If **employee deduction**: `Dr Salaries Payable / Cr EOBI Payable`. Expense is already inside `final_salary`. The current trigger's extra `Dr cos_statutory` **double-counts** it.
- If **employer cost**: net pay should not fall by `eobi`, and the payslip arithmetic is wrong.
- If **both** (the real Pakistani scheme — employer ~5%, employee ~1%): two columns are needed; there is only one.

Current sandbox exposure: **Rs 15,540** of EOBI across 42 payslips, currently expensed twice.

### 5.2 — `payslips.income_tax` needs a liability account
It is salary tax withheld from the employee and owed to FBR — not the company's own income tax. The COA has `income_tax` as an **expense** (7000). A `salary_tax_payable` liability is not seeded. Confirm and I will add it.

### 5.3 — No table records CPR receipt
A1's third posting (`Dr Income Tax Payable / Cr WHT Receivable`) has no source record, and `income_tax_payable` is not in the COA. WHT Receivable would accumulate forever, exactly as AP does today. Need a CPR/tax-credit record before this leg can exist.

### 5.4 — Bad debt account for write-offs
`write_off_receivable()` sets `status='Written-Off'` and posts nothing, leaving AR overstated. Needs a `bad_debt_expense` account — and confirmation that write-off is an expense rather than a revenue reversal.

### 5.5 — Unpresented cheques
Should an outgoing payment cheque credit Bank at document date (today's behaviour, simple, slightly wrong on timing) or move through an *Unpresented Cheques* liability until it clears? The second is more correct and adds an account plus a lifecycle posting.

### 5.6 — `apply_monthly_account_zeroing` must die
It overwrites `bank_accounts.balance`, permanently desyncing it from both `bank_transactions` and the ledger (**D4**). Once bank balance is ledger-derived this function has no meaning. Confirm deletion — it is currently reachable from the Accounting page.

### 5.7 — Profit allocation needs a run record
`partnership_allocation()` computes and writes nothing. Posting #33–#35 needs a durable `profit_allocation_runs` row per month per partner so the entry has a `source_id` to reverse against, and so a month cannot be allocated twice. `profit_allocation_runs` exists as a table but is empty and unused — confirm I should drive it from there.

### 5.8 — Final settlement components
`clearance_certificates` carries `outstanding_advance`, `outstanding_kit_value` and `undisbursed_salary`. Advance recovery and salary payout are clear. **Kit value is not**: is unreturned kit recovered from the employee (Dr Salaries Payable / Cr Inventory or Other Income), or written off as an expense?

---

## 8. What is ready to apply once §5.1–§5.2 are answered

Written and held, not applied — `supabase/migrations/0221_posting_rules_ar_and_cash.sql`:

- Invoice: AR gross, revenue net of sales tax, sales tax to liability, dated to service month (#1, #2)
- Receipt: WHT leg at payment; `invoice_payments.withholding_amount` added (#3)
- `record_invoice_payment()`: outstanding computed gross; WHT apportioned across settled invoices oldest-first
- Payable settled: AP finally discharged (#18, defect D2)
- Bank → custodian float posts (#19, A8)
- Cash cheque to custodian posts (#20, A8)

These touch no payroll and no partner allocation, so they are independent of every blocking question except confirmation of the table itself.
