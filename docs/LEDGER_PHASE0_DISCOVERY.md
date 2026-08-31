# Ledger Project — Phase 0 Discovery Report

**Date:** 2026-08-29
**Scope:** Where money is created, mutated and aggregated across Bastion today, ahead of introducing a single double-entry general ledger.
**Sources read:** 218 migrations in `supabase/migrations/`, the live `crm-design` Supabase schema (project `mmkfpnshxjcyijhuydgr`), all money-touching RPCs / triggers / views, and the 17 finance pages in `src/app/pages/super-admin/`.

**Status:** Discovery only. No code written. Phase 1 blocked on the eight policy questions in the last section.

---

## 0. Three findings that change the shape of the whole project

### A. A double-entry ledger already exists. It is dormant.

Migrations 0039–0106 built:

- `chart_of_accounts` (typed, hierarchical, tenant-scoped)
- `journal_entries` / `journal_lines`
- `post_journal()` posting service
- `accounting_periods` + `enforce_period_lock`
- `opening_balance_batches` / `opening_balance_lines` + `post_opening_balances()`
- `trial_balance`, `regional_pnl_monthly`, `cash_location_balances`, `partner_capital_balances`, `cash_cockpit` views
- **ten** `journal_on_*` triggers — all attached and enabled:

| Table | Trigger | Function |
|---|---|---|
| `invoices` | `trg_yyy_invoices_journal` | `journal_on_invoice` |
| `invoice_payments` | `trg_yyy_payments_journal` | `journal_on_invoice_payment` |
| `payslips` | `trg_yyy_payslips_journal` | `journal_on_payslip` |
| `advances` | `trg_yyy_advances_journal` | `journal_on_advance` |
| `expenses` | `trg_yyy_expenses_journal` | `journal_on_expense` |
| `cash_deposits` | `trg_yyy_cash_deposits_journal` | `journal_on_cash_deposit` |
| `custody_transfers` | `trg_yyy_custody_transfers_journal` | `journal_on_custody_transfer` |
| `partner_account_entries` | `trg_yyy_partner_entries_journal` | `journal_on_partner_entry` |
| `fixed_assets` | `trg_yyy_fixed_assets_journal` | `journal_on_fixed_asset` |
| `interregion_transactions` | `trg_yyy_interregion_journal` | `journal_on_interregion` |

Phase 1 is therefore **not** a greenfield design. It is a redesign of something half-built that nobody trusts.

### B. Both production companies have zero chart of accounts and zero journal entries

| Company | COA rows | Journal entries | Clients | Employees | Invoices | Payslips |
|---|---|---|---|---|---|---|
| GUARDS AND GUIDES (PVT) LTD | **0** | **0** | 43 | 550 | 0 | 0 |
| guards n guides | **0** | **0** | 43 | 527 | 0 | 0 |
| SANDBOX TESTING ORG | 41 | 65 | 8 | 69 | 7 | 48 |
| Sandboxx | 24 | 0 | 0 | 1 | 0 | 0 |

`post_journal()` resolves accounts via `coa_id(company, key)` and, when that returns NULL, **`continue`s the loop silently**:

```sql
v_acct_id := coalesce(
  nullif(v_line->>'account_id', '')::uuid,
  public.coa_id(p_company_id, v_line->>'key')
);
if v_acct_id is null then continue; end if;
```

With an empty COA every trigger fires, resolves nothing, writes nothing, and raises no error. The ledger has been silently no-op'ing in production since migration 0042.

### C. `post_journal()` has no debits = credits check

Because unresolvable lines are skipped rather than raised, a missing account produces a **one-sided entry**, not a failure. Two live paths do this today:

1. An invoice with WHT — `journal_on_invoice` emits a line keyed `wht_receivable`, which **is not in `seed_chart_of_accounts`**. Debit dropped; AR posts net, revenue posts gross; entry is out of balance by the WHT amount.
2. A partner `OPENING` entry — keyed `opening_balance_equity`, also not seeded. Entry posts with only the credit leg.

`journal_lines` has `one_side_only` and `positive_amounts` CHECK constraints, but **nothing enforces entry-level balance, entry immutability, or period lock on the journal tables themselves** (`enforce_period_lock` is attached to the six source tables, not to `journal_entries` / `journal_lines`).

### Consequence

Every number currently on screen comes from the operational-table calculations, not the ledger. The good news is in §3: production has no finance transactions yet.

---

## 1. Every table holding money

### 1.1 Core transactional (the real ledger sources)

| Table | Money columns | Purpose / notes |
|---|---|---|
| `invoices` | `invoice_amount`, `subtotal`, `tax_added_total`, `tax_withheld_total`, `withholding_tax`, `previous_balance`, `total_due`, `amount_received` | Client billing header. `total_due` is **cumulative** (includes `previous_balance`); `invoice_amount` is the period charge. |
| `invoice_lines` | `unit_rate`, `amount`, `taxable` | Line detail. **Never posted to GL.** |
| `invoice_taxes` | `rate`, `amount` | Per-invoice added / withheld tax. **Never posted to GL.** |
| `invoice_payments` | `amount` | Receipts, incl. cash-custodian (`custodian_location_id`) and cheque links. |
| `payslips` | `base_salary`, `allowance`, `bonus`, `deductions`, `advance`, `eobi`, `income_tax`, `final_salary`, `net_salary`, `amount_paid`, `per_day_salary` | Monthly payroll per employee. Two totals (`final_salary` vs `net_salary`) used inconsistently across reports. |
| `payslip_adjustments` | `amount` | Manual payroll adjustments. **Not posted.** |
| `payslip_reward_lines` | `amount` | Reward/bonus lines on a payslip. **Not posted.** |
| `guard_bonuses` | `amount` | Attendance / Eid / long-service bonuses. **Not posted.** |
| `bonus_pool_allocations` | `share_amount`, `points`, `salary`, `proration` | Office-staff bonus pool splits. |
| `advances` | `amount` | Guard/staff salary advances; `payment_mode`, `cash_location_id`, `custodian_location_id`, `cheque_id`. |
| `expenses` | `amount` | Operating + cost-of-service spend; `payment_mode`, `payable_status`, `paid_at`, `pl_category`, `custodian_location_id`, `expense_by`. |
| `fixed_expenses` / `fixed_expense_instances` | `amount` | Recurring expense templates and generated instances. |
| `bank_accounts` | `opening_balance`, `balance` | **Mutable running balance** per real account. Also carries `owner_partner_id` / `owner_client_id`. |
| `bank_transactions` | `amount`, `cash_delta`, `account_delta` | Movement log; doubles as the cash-custody feed via `reference_id` = `cash_location.id`. |
| `treasury` | `cash_balance`, `cash_opening_balance` | **One scalar cash figure per company.** |
| `cash_locations` | `opening_balance`, `coa_account_id` | Custodian / BANK / branch cash sub-ledger definitions. |
| `custody_transfers` | `amount` | Cash moved between custodians. |
| `cash_deposits` | `amount` | Cash → bank, with slip number. |
| `cheques` | `amount` | Incoming / outgoing / cash cheques; pending → cleared → bounced lifecycle. |
| `partners` | `opening_balance`, `profit_share_percent`, `default_share_pct`, `coa_account_id` | Partner master; `scope` (COMPANY/BRANCH), `basis`, `start_month`. |
| `partner_account_entries` | `amount` | Partner current account: `CONTRIBUTION` / `DRAWING` / `PROFIT_ALLOCATION` / `OPENING`. |
| `partner_client_shares` | `share_percent` | Effective-dated per-client partner shares. |
| `contracts` | `rate_per_guard_per_month`, `guard_rates` (jsonb), `eobi_amount`, `annual_escalation_pct` | Pricing input, not a posting. |
| `contract_lines` | `billing_rate`, `unit_rate`, `client_ot_rate`, `cost_components` (jsonb), `relief_allowance` | BILLING and STRENGTH grains. |
| `contract_addendums` | `new_rate` | Dated rate changes. |
| `clients` | `opening_balance`, `credit_ceiling`, `withholding_tax_rate`, `eobi_amount`, `auto_invoice_amount`, `auto_invoice_withholding`, `tax_profile` (jsonb) | Client master + AR opening balance. |
| `employees` | `base_salary`, `allowance`, `per_day_salary`, `final_pay`, `pay_fixed_on_probation` | Salary master. |
| `employee_salary_history` | `base_salary`, `allowance`, `per_day_salary` | Effective-dated salary changes. |
| `clearance_certificates` | `outstanding_advance`, `outstanding_kit_value`, `undisbursed_salary` | Exit settlement. **Not posted.** |

### 1.2 The ledger itself

| Table | Columns | Gaps vs. the target design |
|---|---|---|
| `chart_of_accounts` | `account_code`, `account_name`, `account_type`, `normal_side`, `parent_id`, `system_key`, `system_account`, `active` | No **control-account flag**. |
| `journal_entries` | `company_id`, `entry_date`, `description`, `source_table`, `source_id`, `is_reversal`, `manual`, `posted_by`, `created_at` | No `status`, no `posting_period`, no `reversal_of_entry_id` (reversals are matched by `description LIKE '%(reversal of <uuid>)%'`), no immutability. |
| `journal_lines` | `journal_entry_id`, `account_id`, `debit numeric(16,2)`, `credit numeric(16,2)`, `branch_id` | **`branch_id` is the only dimension.** No `client_id`, `employee_id`, `partner_id`, `contract_id`, `cost_center`. Amounts are numeric, not integer minor units. |
| `accounting_periods` | `company_id`, `period_month`, `closed_by`, `closed_at`, `note` | Unique on (company, month). Enforced on source tables only. |
| `opening_balance_batches` / `_lines` | `as_of_date`, `status`, `debit`, `credit`, `branch_id` | Working, and `post_opening_balances()` **does** verify Dr = Cr. Zero rows. |

RLS is enabled with 2 policies on each of the four tables.

### 1.3 Secondary / derived money tables

`interregion_transactions` (`amount`, `markup_pct`) · `fixed_assets` + `depreciation_entries` (`cost`, `accumulated_depreciation`, `net_book_value`, `salvage_value`, `disposal_proceeds`) · `bonus_pools` / `bonus_accruals` · `ho_allocation_runs` (`ho_cost`, `allocated_total`) · `reserve_policies` · `investor_ledger_entries` · `project_investments` · `finance_projects` · `statutory_filings` (`amount`) · `approval_requests` / `approval_configs` (`threshold_amount`) · `vehicle_logs` · `inventory_items` (`unit_value`) · `subscription_payments` / `ai_credit_ledger` / `signup_intents` (SaaS billing — out of scope).

---

## 2 & 3. Every place a financial number is created, mutated or aggregated

Legend — **GL**: what the journal trigger posts (only when a COA exists, i.e. sandbox only today). **Also writes**: side-effects on other money tables.

| # | Real-world event | Code | GL posting today | Also writes | Consumed by |
|---|---|---|---|---|---|
| 1 | Invoice raised | `journal_on_invoice`, `run_auto_invoices` | Dr `ar` (**net of WHT**), Dr `wht_receivable` *(account missing → line dropped)*, Cr `revenue_security` / `revenue_guard` (**gross**) | — | `regional_pl_range` (accrual revenue), `client_statement_loaded`, `regional_receivables_aging`, Receivables, Dashboard |
| 2 | Invoice edited | same trigger | full reversal + repost, only if `invoice_amount` / `withholding_tax` / `branch_id` changed | — | as above |
| 3 | Receipt recorded | `record_invoice_payment` → `journal_on_invoice_payment` | Dr bank or custodian-cash, Cr `ar` | `invoice_payments` row(s) (oldest-first allocation), `invoices.amount_received`, `bank_accounts.balance` **or** `treasury.cash_balance`, `bank_transactions` (kind `receipt`) | CashFlow, Invoices, `client_statement_loaded('cash')`, `partner_ledger` custody leg |
| 4 | Incoming cheque cleared | `cheque_apply_balance` | none directly — but it **inserts an `invoice_payments` row**, which fires #3 | `bank_accounts.balance` +, `bank_transactions`, `invoices.amount_received` | as #3 |
| 5 | Outgoing cheque issued / cleared / bounced | `cheque_apply_balance`, `cheque_bounce` | **none** | `bank_accounts.balance` − / +, `bank_transactions`, `treasury.cash_balance` (cash cheques) | Accounting, CashCustody, `partner_ledger` |
| 6 | Payslip disbursed | `journal_on_payslip` | Dr `cos_payroll` / `opex_office_payroll` = `final_salary`; Cr bank or cash = `final_salary`; plus Dr `cos_statutory` / Cr `eobi_payable`. Dated **`period_month`**, not payment date. **Nothing** for `advance`, `income_tax`, `bonus`, `deductions` | `bank_transactions` (kind `payroll`), `bank_accounts.balance` / `treasury` via page code | `regional_pl_range` (both bases), `regional_general_expenses`, `client_statement_loaded`, `payroll_cash_by_client` |
| 7 | Advance issued | `journal_on_advance` | Dr **`ar`** ← *the client AR control account*, Cr bank or custodian-cash | — | `employee_advance_outstanding`, CashFlow, `custodian.ts` held-cash |
| 8 | Advance recovered from salary | *nothing* — only `payslips.advance` is set | **none** | — | `employee_advance_outstanding` (recomputes Σ advances − Σ `payslips.advance`) |
| 9 | Expense recorded | `journal_on_expense`, `map_expense_to_coa_key` | Dr mapped expense account, Cr cash / bank / `ap` by `payment_mode` | — | `regional_pl_range`, `regional_general_expenses`, `client_statement_loaded`, custodian held-cash |
| 10 | Payable settled later | page code sets `payable_status` / `paid_at` | **none** (AP never cleared) | — | cash-basis branches of the reports |
| 11 | Cash deposited to bank | `record_cash_deposit` → `journal_on_cash_deposit` | Dr `bank`, Cr custodian cash account | `treasury.cash_balance` −, `bank_accounts.balance` +, `bank_transactions`, `audit_log` | Accounting, CashFlow |
| 12 | Bank → custodian float | `record_bank_to_custodian` | **none** | `bank_accounts.balance` −, `treasury.cash_balance` +, `bank_transactions` (`withdraw_to_cash`, `reference_id` = cash_location) | CashCustody, `custodian.ts`, `partner_ledger` |
| 13 | Custodian → custodian | `journal_on_custody_transfer` | Dr to-location account, Cr from-location account — **asset↔asset, correct** | — | `cash_location_balances`, `custodian.ts` |
| 14 | Partner contribution / drawing | `journal_on_partner_entry` | CONTRIBUTION: Dr cash/bank, Cr partner capital. DRAWING: Dr partner capital, Cr cash/bank. **Balance sheet only — correct** | — | Partners, `partner_ledger`, `partner_capital_balances` |
| 15 | Monthly profit share | `partnership_allocation()` — **compute-only, nothing is written** | none, unless someone hand-keys a `PROFIT_ALLOCATION` entry (then Dr `retained_earnings`, Cr partner capital — correct) | — | Partners, ProfitDistribution, `partner_ledger` remuneration column |
| 16 | Partner opening balance | `journal_on_partner_entry` type `OPENING` | Dr `opening_balance_equity` *(missing → dropped)*, Cr partner capital → **one-sided entry** | — | `partner_ledger` opening |
| 17 | Opening balances (general) | `post_opening_balances(batch)` | posts the batch as one entry; **does** verify Dr = Cr | — | `trial_balance` |
| 18 | Period close | `accounting_periods` + `enforce_period_lock` on `invoices`, `invoice_payments`, `payslips`, `advances`, `expenses`, `cheques` | — | — | PeriodClose |
| 19 | Fixed asset / depreciation | `journal_on_fixed_asset`, `run_depreciation`, `dispose_fixed_asset` | Dr asset / Cr bank; depreciation entries | `fixed_assets.accumulated_depreciation` | `fixed_assets_register` |
| 20 | HO cost allocation | `run_ho_cost_allocation` | Dr `allocated_ho_cost` / Cr `ho_cost_recovery` | `ho_allocation_runs` | `regional_pnl_monthly`, Treasury |
| 21 | Inter-region loan | `journal_on_interregion` | Dr / Cr inter-region accounts | — | `interregion_balances` |
| 22 | Bonus pools / reserves | `generate_bonus_pool`, `accrue_bonus_reserve`, `fund_reserve`, `trueup_bonus_provision` | partial GL | `bonus_pools`, `bonus_accruals` | Treasury, Performance |
| 23 | Receivable write-off | `write_off_receivable` | sets `invoices.status='Written-Off'` | — | Receivables |
| 24 | Final settlement on exit | `assess_clearance`, `release_final_dues` | **none** | `clearance_certificates`, `employees.final_pay` | Clearance certificate PDF |
| 25 | Monthly bank zeroing | `apply_monthly_account_zeroing` | — | **rewrites** `bank_accounts.balance` | Accounting |

### 3.1 Which world each report lives in

| Report / surface | Source |
|---|---|
| `client_statement_loaded`, `regional_pl_range`, `regional_general_expenses`, `partnership_allocation`, `employee_advance_outstanding`, `payroll_cash_by_client`, `payroll_cost_by_client`, `regional_receivables_aging`, `cash_forecast`, CashFlow, FinancialReports, Dashboard, CashCustody, `custodian.ts` | **operational tables** |
| `trial_balance`, `regional_pnl_monthly`, `cash_cockpit`, `cash_location_balances`, `partner_capital_balances`, `region_profit`, `region_operating_profit`, `danger_level`, `reserve_status`, `cash_control_reconciliation`, Treasury page, ChartOfAccounts page | **ledger** |
| `partner_ledger` | **both, unioned** |

Two P&Ls exist side by side: `regional_pl_range` (operational, feeds partnership allocation) and `regional_pnl_monthly` (ledger, feeds Treasury and the regional scorecard). They cannot agree, and in production one of them is structurally zero.

---

## 4. Double-counting suspects

### a. Cash in hand has three independent answers

1. `treasury.cash_balance` — a single mutable scalar per company.
2. `cash_location_balances` — `opening_balance` + Σ GL postings on `coa_account_id`.
3. `custodian.ts` `loadCustodianOptions()` — recomputed in the browser from **eight** tables: `custody_transfers`, cash `invoice_payments`, `expenses`, cash `advances`, cleared cash `cheques`, `bank_transactions` kind `withdraw_to_cash`, `bank_transactions` kind `payroll`, and cash `partner_account_entries`.

Nothing reconciles them. The file's own header comment asserts "`treasury.cash_balance` stays the canonical total; these balances reconcile up to it" — there is no check that they do.

### b. Bank balance has three

`bank_accounts.balance` (mutated in place by ~8 code paths) · Σ `bank_transactions.account_delta` · GL `bank` account. `apply_monthly_account_zeroing` overwrites the first, permanently desyncing it from the other two.

### c. One receipt writes five rows

`record_invoice_payment` writes `invoice_payments` + `invoices.amount_received` + `bank_accounts.balance` / `treasury.cash_balance` + `bank_transactions` + (via trigger) a journal entry. Any report summing receipts from more than one of these double-counts. CashFlow reads `invoice_payments`; Accounting and CashCustody read `bank_transactions`.

### d. A cleared incoming cheque is recorded twice over

`cheque_apply_balance` credits `bank_accounts.balance` **and** inserts an `invoice_payments` row — whose own trigger then debits GL bank again. Inside the GL that is one entry; across the two systems the same money lands in bank via two independent mechanisms.

### e. `regional_receivables_aging` double-counts carried-forward balances

```sql
COALESCE(i.total_due, i.invoice_amount, 0) - COALESCE(i.amount_received, 0)
```

`total_due` is cumulative. Verified in live data:

| Invoice | `invoice_amount` | `total_due` |
|---|---|---|
| STS-26-CTD-06 | 1,050,000 | 1,050,000 |
| STS-26-CTD-07 | 1,050,000 | **2,100,000** |
| STS-26-DPA-07 | 784,000 | **1,568,000** |
| STS-26-IRN-07 | 90,000 | **180,000** |

The June balance is counted again in July. AR aging is overstated by the entire carried-forward balance of every client with more than one open invoice. The GL, by contrast, posts `invoice_amount`. **This alone explains a large part of "the reports don't tie."**

### f. Revenue is posted gross while AR is posted net

`journal_on_invoice` credits revenue with `invoice_amount` and debits AR with `invoice_amount − withholding_tax`, relying on a `wht_receivable` account that does not exist. Separately, `tax_added_total` (output sales tax collected and remitted) is never split out — if it sits inside `invoice_amount`, revenue is overstated by the output tax and the liability never appears anywhere.

### g. Payroll appears three times, on three different dates

| Figure | Date used | Where |
|---|---|---|
| `payslips.final_salary` | `period_month` | accrual reports (`regional_pl_range.payroll_accrual`) |
| `payslips.net_salary` | `disbursed_at` / cheque clear date | cash reports (`regional_pl_range.payroll_cash`) |
| `final_salary` in GL | `period_month`, **but only when `disbursed`** | ledger — neither basis |

Plus `bank_transactions` kind `payroll` as a fourth record, used by the custody calculation.

### h. Employee advances hit the client receivable control account

`journal_on_advance` debits system key `'ar'` — *Accounts Receivable*, code 1100, the same control account as client invoices. Every advance inflates client AR. And recovery (`payslips.advance`) posts nothing, so advances never clear in the GL: the balance only ever grows.

### i. `partner_ledger` unions overlapping sources, with a hand-patch that proves it

`partner_ledger()` reads `partner_account_entries` **and** GL lines on the partner's `coa_account_id` **and** custody activity from six raw tables (`invoice_payments`, `expenses`, `advances`, `cheques`, `custody_transfers`, `bank_transactions`) **and** partner-owned `bank_transactions`. It avoids the first collision with:

```sql
and coalesce(je.source_table, '') <> 'partner_account_entries'
```

— a filter that only works while every partner entry arrives via the trigger. The custody and bank legs have no such guard: once production has GL rows, cash / expenses / advances stamped to a partner custodian will be counted once from the operational table and again from the GL.

### j. Custody float is invisible to the ledger, and expensed asymmetrically

`record_bank_to_custodian` writes **no journal line at all**, so the GL never sees the float. The custodian's spends *do* post as expenses. Cash sitting with a custodian at month end is therefore invisible to the ledger, present in `treasury.cash_balance`, and computed a third way by `custodian.ts`. Cleared **cash cheques** handed to a custodian bypass custody entirely and land straight in `treasury`.

### k. `client_statement_loaded` allocates the same overhead pool twice, by two different keys

Regional overhead is spread by revenue share within the region; the HO pool is spread by revenue share across the company — both over a payroll figure that was itself split by attendance days. None of this allocation exists in the GL, so client-level net profit and ledger net profit cannot reconcile even in principle.

---

## 5. Basis of accounting, per module

| Module | Basis today |
|---|---|
| **Invoicing / AR** | **Accrual** in the GL and in `regional_pl_range.revenue_accrual` (by `invoice_date`). `client_statement_loaded` takes a `p_basis` parameter and returns either. CashFlow labels receipts as revenue. Mixed by caller. |
| **Receipts / bank** | **Cash**, recorded four ways (§4c). |
| **Payroll** | **Hybrid, and not a valid basis:** recognised only on disbursement (cash trigger), but dated to the accrual month, at the accrual amount. Reports offer both bases off the same rows. |
| **Employee advances** | **Cash out; no recovery recognition.** Permanently open in the GL. |
| **Expenses** | **Accrual** at `expense_date` in the GL, crediting `ap` when `payment_mode='Payable'` — but **AP is never cleared on payment**, so the liability accumulates forever. Cash-basis reports use `paid_at` / cheque clear date. |
| **Custody** | **Not in the ledger** — except `custody_transfers`, which is modelled correctly. Elsewhere: a mutable scalar and a browser-side recomputation. |
| **Cheques** | **Not in the ledger.** Balance-only, with pending / cleared / bounced handled by direct balance mutation. |
| **Partner capital** | **Correct double-entry** for contributions and drawings — the one module already doing what the project wants. |
| **Profit share** | **Computed, never posted.** `partnership_allocation()` returns numbers; no journal entry exists unless hand-keyed. |
| **WHT** | **Intended as an asset, implemented as a receivable reduction.** Design intent is right (`journal_on_invoice` debits `wht_receivable`), but the account is absent from `seed_chart_of_accounts`, so the debit is silently discarded. Every other consumer — e.g. `record_invoice_payment`, whose outstanding is `invoice_amount − withholding_tax − amount_received` — treats WHT as reducing what the client owes rather than as tax paid on your behalf. **Net effect: WHT is not an asset anywhere in the system.** |
| **Depreciation / reserves / HO allocation / inter-region** | Accrual, ledger-based — the most correct modules, and the ones with no production data. |
| **SaaS billing** (`subscription_payments`, `ai_credit_ledger`) | Cash. Out of scope. |

---

## 6. What this means for Phases 1–5

**The favourable surprise:** production has no finance transactions yet. Verified row counts by company:

| Table | GGS prod (both orgs) | SANDBOX TESTING ORG |
|---|---|---|
| `invoices`, `invoice_payments`, `payslips`, `expenses`, `advances`, `cheques`, `bank_accounts`, `bank_transactions`, `cash_locations`, `partners` | **0** | 7 / 5 / 48 / 5 / 1 / 3 / 9 / 65 / 13 / 3 |
| `treasury` | 0 | 1 (+1 in Sandboxx) |

All finance rows live in the sandbox org. Production carries HR, clients, deployments and attendance only.

So **Phase 3 migration is close to free**: seed the COA, post opening balances as at cutover, start clean. Back-posting full history is not even a meaningful option here — there is no financial history in production to back-post.

The hard part is **Phase 4**: deleting one of the two parallel report families, not adding a ledger.

---

## 7. Open policy questions — Phase 1 is blocked on these

Per the constraint "ask before assuming any accounting policy", eight decisions are needed. No defaults assumed.

1. **WHT.** Confirm: client-deducted income tax becomes `WHT Receivable` (asset), revenue is booked gross, AR is booked gross, and WHT clears only when the client's CPR arrives. Or is it recognised at invoice time?
2. **Output sales tax (SRB / PRA / FBR).** Is `tax_added_total` sales tax you collect and remit? If so it must be a liability, not revenue.
3. **Revenue recognition point.** Invoice date, or the service month (`period_start`)? They differ today, and attendance-billed clients invoice in arrears.
4. **Payroll accrual.** Accrue gross salary at month end regardless of disbursement (Dr expense / Cr Salaries Payable), then Dr payable / Cr cash on disbursement? That is standard, and it is what the seeded `salaries_payable` account was created for but never used.
5. **`final_salary` vs `net_salary`.** Which is gross expense and which is cash paid? They differ by advance recovery; I need the definition, not a guess.
6. **Advance recovery.** Recovered against payroll as Dr Salaries Payable / Cr Employee Advances Receivable, leaving expense untouched? Confirm.
7. **Custody float.** Confirm the rule (issue = asset transfer, expense only on reported spend) applies to *cleared cash cheques* handed to a custodian too — these bypass custody entirely into `treasury` today.
8. **Partner-paid expenses and profit share.** When a partner pays a company expense from a personal bank account, is that Dr Expense / Cr Partner Current Account? And are regional partner shares an equity split or an expense-like allocation? §2 row 15 implies equity; §5 notes it is never posted at all.
