# Bastion Ledger Project — Master Findings

**Consolidated record of every phase and part to date.**
Last updated: 2026-08-31 · Next migration number: **0224**

This is the index and the consolidated findings. The detailed per-part reports stay where
they are and are not duplicated here:

| Document | Covers |
|---|---|
| [LEDGER_PHASE0_DISCOVERY.md](LEDGER_PHASE0_DISCOVERY.md) | Phase 0 — full discovery |
| [LEDGER_PHASE1_POSTING_RULES.md](LEDGER_PHASE1_POSTING_RULES.md) | Part C — the 45-event posting-rule table |
| [LEDGER_PHASE1_PARTE_PURGE_INVENTORY.md](LEDGER_PHASE1_PARTE_PURGE_INVENTORY.md) | Part E — E0 reliever findings, E1 table classification |
| [LEDGER_PHASE1_PARTF1_STATUS_AUDIT.md](LEDGER_PHASE1_PARTF1_STATUS_AUDIT.md) | Part F1 — attendance status audit |

---

## 1. Where the project stands

| Phase / Part | Scope | Status |
|---|---|---|
| **Phase 0** | Discovery | **Done** |
| **Phase 1 Part B** | Foundation repair | **Done** — migrations 0219, 0220 |
| **Phase 1 Part C** | Posting rules | Table approved; **tranche 1 done** — 0221, 0222, 0223 |
| **Phase 1 Part D** | Client resolution / org duplication / waterfall | D1 **done** (0223); D2 investigated and recommended; **D3 (waterfall) not started** |
| **Phase 1 Part E** | In-place financial purge | E0 + E1 reported. **E3 cancelled** — nothing to delete. E4 (archive) outstanding |
| **Phase 1 Part F** | Status normalisation, archive, waterfall | **F1 reported.** F1.3 onward blocked on three decisions |
| **Phases 2–5** | Not started | — |

---

## 2. The single most important structural finding

**The ledger was never greenfield, and it was never running.**

Migrations 0039–0106 had already built a complete double-entry ledger with ten `journal_on_*`
triggers attached. It produced nothing in production for two reasons that compounded:

1. Both production companies had **zero `chart_of_accounts` rows**.
2. `post_journal()` **silently skipped** any line whose account key it could not resolve.

With no accounts, every line was unresolvable, every line was dropped, and every trigger
succeeded while writing nothing. No error was ever raised. The ledger appeared to work.

The second consequence: **all finance transaction data lives in `SANDBOX TESTING ORG`.**
Production carries HR, attendance and clients only. That is why the cutover is nearly free —
and why Part E's purge turned out to have nothing to purge.

---

## 3. Defect register — every defect found, with magnitude

Magnitudes are as measured, not estimated. "Live" is `GUARDS AND GUIDES (PVT) LTD`.

### Fixed

| # | Defect | Magnitude | Fixed by |
|---|---|---|---|
| 1 | `post_journal()` silently dropped unresolvable lines | Entire ledger inert | 0219 |
| 2 | No debits = credits enforcement at entry level | Unbounded | 0219 |
| 3 | Zero COA rows in both production companies | Entire ledger inert | 0219 (49 accounts seeded per company) |
| 4 | 13 account keys referenced by triggers but never seeded — depreciation, reserves, inter-region, bonuses | Would have broken those flows the moment `post_journal` started raising | 0219 |
| 5 | Employee advance posted into **client AR** | **Rs 2,000** | 0219 (reclassification posted) |
| 6 | Posted entries were freely editable and deletable | Unbounded | 0219 immutability triggers + 0220 role-gated maintenance flag |
| 7 | Source-record deletes cascaded into the journal | Unbounded silent loss | 0220 — CASCADE/SET NULL → RESTRICT |
| 8 | EOBI employer share double-counted (`cos_statutory` posted twice) | **Rs 15,540** | 0222 |
| 9 | Salary income tax misrouted | **Rs 651** | 0222 |
| 10 | Payroll accrual gated on disbursement (cash basis, not accrual) | All payroll timing | 0222 — two-step accrual via `salaries_payable` |
| 11 | Payroll client dimension read from `employees.client_id` (a *current* pointer) | **Rs 0 today** — 0 payslips span >1 client — latent from the first transfer | 0223 — attendance-weighted `payslip_client_split()` |
| 12 | Manual-journal UI made two PostgREST calls, leaving a line-less entry | Regression I introduced in 0219 | `post_manual_journal()` RPC |

### Open

| # | Defect | Magnitude | Blocked on |
|---|---|---|---|
| 13 | **Profit waterfall allocates 135% of profit** — 100% equity + 15% + 20% regional as separate non-interacting pools | The original defect. July remuneration **−1,326,374** vs P&L **+747,531**; August **+4,116,869.31** vs operating loss **−642,346** | F4 / D3 — not started |
| 14 | `attendance_records_enforce_reliever` nulls the client on any lowercase mark | **Rs 0 to date** (no reliever has ever been paid, in any org); 173 sandbox rows already destroyed, 60 live rows recoverable | F2 — `blocked` semantics undecided |
| 15 | `avg_deployed_guards` counts `'Present'` only | Sees 19,064 of 32,679 — **understates 41.7%**; feeds regional P&L and danger bands | F1.3 |
| 16 | `attendance_billing_suggestion` counts `'present'` only | Sees 13,347 of 32,411 — **understates 58.8%** | F1.3 |
| 17 | `accrue_attendance_bonuses` disqualifies on `'Absent'` only | **63 employees** who were absent remain bonus-eligible; realised cost **Rs 0** (`guard_bonuses` is empty) | F1.3 |
| 18 | `Dashboard.tsx:301` counts `"Present"` only | Has read **0 present** every day since 2026-07-24 | F1.3 |
| 19 | Employer EOBI posted flat rather than gated on client tax profile | **~Rs 1.02m/month, ~Rs 12.2m/year** at 550 guards | F4 / E5 step 1 |
| 20 | Sales tax not posted where obligation exists | **Rs 0 exposure today**, latent | Part C §5.3–§5.5 |
| 21 | `apply_monthly_account_zeroing` mutates balances | — | E5 step 3 — remove this one function only |
| 22 | Guards with attendance but no deployment segment *and* no `employees.client_id` | Sandbox-only today; **will** appear in production the first time attendance precedes deployment | Logged as a future validation rule — not to be built now |

---

## 4. Phase 0 — Discovery

Full report: [LEDGER_PHASE0_DISCOVERY.md](LEDGER_PHASE0_DISCOVERY.md)

- Ledger existed but was dormant (§2 above).
- Both production companies had 0 COA rows.
- **11 double-counting suspects** identified across modules.
- Every module computed its own numbers on its own basis; a basis-per-module table was
  produced. Some modules were cash basis, some accrual, none agreed.

---

## 5. Phase 1 Part B — Foundation repair (0219, 0220)

**B1–B6, all applied.**

- `post_journal()` now **raises** instead of dropping lines.
- Entry-level debits = credits enforced by a **deferred** constraint trigger.
- 49 accounts seeded for **every** company.
- Dimensions added to `journal_lines`: `client_id`, `employee_id`, `partner_id`,
  `contract_id`, `cost_center`.
- `status`, `posting_period`, `reversal_of_entry_id` added to `journal_entries`.
- Posted entries made immutable; period lock added.
- `journal_on_advance` fixed to use `employee_advances_receivable`.
- `ledger_checks()` created — now **six** reconciliation checks.

### The maintenance gate (0220)

The null-company escape hatch was replaced with an explicit, role-gated flag:

```sql
create or replace function public.is_ledger_maintenance()
returns boolean language sql stable set search_path to 'public'
as $function$
  select coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
     and exists (select 1 from pg_roles
                  where rolname = session_user and (rolsuper or rolbypassrls));
$function$;
```

`session_user`, **not** `current_user` — SECURITY DEFINER functions rewrite the latter.
App roles can never satisfy it.

**Protocol for any mutation of a posted journal row** (including company teardown, since
`journal_entries.company_id` is now `ON DELETE RESTRICT`):

```sql
begin;
  set local app.ledger_maintenance = 'on';
  ... corrective statements ...
commit;
```

### Cascade audit

Every cascade path into `journal_entries` / `journal_lines` was enumerated and justified.
`journal_entries.company_id` CASCADE → RESTRICT. `journal_lines.{client,employee,partner,contract}_id`
SET NULL → RESTRICT. `branch_id` NO ACTION → RESTRICT. Only
`journal_lines.journal_entry_id` keeps CASCADE — that one is composition, not reference.

---

## 6. Phase 1 Part C — Posting rules (0221, 0222, 0223)

Table: [LEDGER_PHASE1_POSTING_RULES.md](LEDGER_PHASE1_POSTING_RULES.md) — 45 events with
Event | Debit | Credit | Dimensions required | Basis | Source table | Status.

### Locked accounting policy — decided by the user, not to be re-litigated

- **WHT** is an asset recognised **at payment**, not at invoice.
- **Output sales tax** is a liability.
- **Revenue** is recognised at **service month** (`period_start`), not invoice date.
- **Payroll** accrues gross at month end via `salaries_payable`, then clears on disbursement.
- `final_salary` = gross P&L expense; `net_salary` = cash paid.
- **Advance recovery** is Dr Salaries Payable / Cr Employee Advances Receivable.
- **Custody float** is an asset transfer, never an expense.
- **Regional partners hold no equity.** Their share is profit-linked remuneration and
  therefore a **company expense**. Equity partners take **100% of the residual**.
  Equity is **downstream** of regional — never parallel pools.
- **A loss-making client gives a regional partner a NEGATIVE share**, which nets against
  their other clients. No floor at zero.
- **§5.8 confirmed: Other Income.**
- Employer EOBI is **conditional on the client tax profile**, not flat across all guards.
- Do **not** change the partner current-account agency design (A9 i).

### 0221 — AR and cash

Invoice: Dr AR gross / Cr Revenue net / Cr Sales Tax Payable, dated
`coalesce(period_start, invoice_date)`. Receipt: Dr Bank/Cash, Dr WHT Receivable, Cr AR.
Added `invoice_payments.withholding_amount`; rewrote `record_invoice_payment` to work on
gross outstanding with `p_withholding` apportioned pro rata. Added
`journal_on_expense_settlement`, custody float posting in `record_bank_to_custodian`, and
`journal_on_cheque` — **cash cheques only**; payment cheques deliberately post nothing, to
avoid double-crediting bank.

### 0222 — Payroll accrual and statutory

Added `salary_tax_payable` (2450) and `payslips.eobi_employer`. Split posting into
`post_payslip_accrual()` (source `payslips`, dated `period_month`) and
`post_payslip_disbursement()`. Removed the duplicate `Dr cos_statutory = eobi`.
Reposted all 48 payslips.

### 0223 — Attendance-weighted client attribution (also Part D1)

`payslip_client_split(p_id)` mirrors `payroll_cost_by_client`'s convention exactly:
`present` / `double_duty` / `relief_cover` days keyed on `worked_for_client_id`, falling
back to the employee's client only when there is no attendance in the month. The accrual
splits `final_salary` and `eobi_employer` across clients, **residual to the largest share**
so the split sums exactly. Added `repost_payslip_accruals_for_month()` and
`ledger_payroll_by_client()` so the ledger and the report cannot disagree.

**Proved:** a 0.5625 / 0.4375 split of Rs 55,000 posted 30,937.50 + 24,062.50 = 55,000.00 exact.

---

## 7. Phase 1 Part D

**D1 — done and evidenced** (0223 above).

**D2 — org duplication, investigated and recommended.** The `guards n guides` clone is
retired. Recommendation accepted: **archive, do not delete**; the org switch is cancelled;
`org_copy_map_0186` (4,679 rows) is **kept**, since the clone survives.

**D3 — the waterfall. Not started.** Carried into F4.

---

## 8. Phase 1 Part E — The purge that had nothing to purge

Full report: [LEDGER_PHASE1_PARTE_PURGE_INVENTORY.md](LEDGER_PHASE1_PARTE_PURGE_INVENTORY.md)

### Headline

**Every table on the purge list holds zero rows in the live org.**

`invoices` 0 · `invoice_lines` 0 · `invoice_payments` 0 · `payslips` 0 · `payroll_runs` 0 ·
`advances` 0 · `expenses` 0 · `bank_accounts` 0 · `bank_transactions` 0 · `cheques` 0 ·
`treasury` 0 · `cash_locations` 0 · `partners` 0 · `journal_entries` 0 · `journal_lines` 0

A further ~40 tables (`profit_allocation_runs`, `fixed_assets`, `opening_balance_batches`,
`incidents`, `issuances`, `statutory_filings`…) are empty in **every** org.

**E3 was cancelled** — it would delete zero rows. The clean financial start already existed.

### The one thing that had to be stopped

**`company_counters` must not be reset.** 68 live rows drive `guard_code`, `employee_code`,
`client_code`, `contract_code` and `display_number`. Guard codes are permanent and immutable
by design — resetting the counters would regenerate codes **colliding with the 550 existing
employees**. That is unrecoverable corruption of exactly the operational data the KEEP list
protects. Pushback accepted; nothing touches them.

### KEEP set — never touched

Clients (43), contracts (30), contract lines (70), employees (550), deployments (715),
salary history (839), attendance records (36,558), attendance confirmations (1,140),
guard documents (4,440), document checklist (5,500), clearance certificates (204),
employee code history (551), sites (34), shift definitions (40), branches (4),
companies, profiles, and `chart_of_accounts` (50 — config, not data).

### E0 — reliever attendance

- Live NULL-client rows are **974 office_staff (correct)** + **60 reliever**. Nothing else.
- **Gunman 0, armed 0** in the live org. The earlier gunman-85 / armed-79 figures were
  global; scoped to live they vanish. The sandbox cause is guards with attendance but no
  deployment segment and no `employees.client_id` — an operational gap, not a trigger defect.
- Backfill: **60 rows fixable** via the employee fallback, **0** from `deployment_client_on()`,
  974 office-staff rows correctly stay NULL.

---

## 9. Phase 1 Part F1 — Attendance status audit

Full report: [LEDGER_PHASE1_PARTF1_STATUS_AUDIT.md](LEDGER_PHASE1_PARTF1_STATUS_AUDIT.md)

### Ten status values, not four

`Present` (19,064 live) · `present` (13,334) · `Leave` (2,998) · `Absent` (729) ·
`absent` (223) · `double_duty` (268) · `blocked` (24) — plus `rest_day`, `rotation_leave`,
`relief_cover` in the sandbox. **No lowercase `leave` exists anywhere.**

**The schema sanctions the duplication.** `attendance_records_status_check` explicitly
whitelists both casings. This is not drift past a constraint — it is a constraint widened
to admit two vocabularies rather than pick one.

**Two writers, two eras.** `AttendanceManagement.tsx` (legacy) writes capitalised;
`AttendanceBoard.tsx` / `BulkMarkByEmployeeModal.tsx` / `AttendanceSheetModal.tsx` write
lowercase. The dates confirm the handover: `Present` stops **2026-07-24**, `Absent`
**2026-07-15**, everything after is lowercase. `Leave` stays capitalised deliberately —
migration 0141 made it the fold target for `rotation_leave`.

### The money path is clean

Every function feeding the ledger, payroll split and client statement already normalises
with `lower()`: `attendance_billable_quantity`, `attendance_payroll`,
`client_statement_loaded`, `payroll_cash_by_client`, `payroll_cost_by_client`,
`payslip_client_split`, `record_separation`, and `v_client_billing_reconciliation`.

**The five defects are in operational reporting, bonus accrual and the reliever trigger —
not in the posting rules.** That is why the ledger figures held up under Part D.

### Correction to the Part E report

I called the case duplication *the mechanism* of the live-org reliever bug. That was too
strong. All 60 live reliever rows are capitalised `Present`, so the lowercase branch never
touched them; both affected employees have April-only rows and both retain a `client_id`
pointer, which is why all 60 remain backfillable. The lowercase branch is demonstrably the
mechanism **in the sandbox** — 139 `present` + 12 `double_duty` + 2 `relief_cover` reliever
rows, **100% NULL client**, and the `raise exception` that should have demanded a client
never fired once. The defect is real; my attribution of the live rows to it was not.

### F1.5 — rows changing attribution: 0. Rupee magnitude: Rs 0

Every reliever row in every org already has `worked_for_client_id` NULL — there is no
attribution left to lose. And there are **zero payslips for any reliever in any org**, so
the defect has cost nothing to date. Its cost begins the first time a reliever is paid.

### F1.6 — the normalisation UPDATE aborts on 1,739 rows

`attendance_records` carries eight BEFORE triggers, five firing on UPDATE, and the status
*is* changing so no fast-path applies. Against the 19,793 live rows to normalise:

| Blocker | Rows | Bypass? |
|---|---|---|
| `enforce_attendance_backfill` service-window hard bound | **1,304** | **None** — `app.skip_attendance_lock` returns *after* the check |
| `enforce_confirmed_month_end_lock` | 435 | per-row `supervisor_override` only |
| `enforce_attendance_month_lock` (OPS verification) | 429 | un-verify the month only |
| **Union (not additive)** | **1,739** | |

A naive `set status = lower(status)` aborts on the first separated guard and rolls back all
19,793 rows.

### Recommendations

- **Canonical form: lowercase** — 19,886 rows move. It is the only form the active writers
  emit, it is already the form of every spec token, and the money path already `lower()`s to it.
- **CHECK, not enum** — enum values cannot be removed, and retiring `Present` is the point.
- The real recurrence guard is **`supabase.ts:1480`**, where
  `AttendanceStatus = "Present" | "Absent" | "Leave"` currently makes TypeScript certify the
  wrong vocabulary.

---

## 10. Migration register

| # | Title | Applied |
|---|---|---|
| 0219 | `ledger_foundation_repair` | Yes |
| 0220 | `ledger_maintenance_gate` | Yes |
| 0221 | `posting_rules_ar_and_cash` | Yes |
| 0222 | `payroll_accrual_and_statutory` | Yes |
| 0223 | `payroll_client_attendance_split` | Yes |
| 0224–0229 | status normalisation, HO revenue driver, HO-billing check, migration names/digests, gate-mode rejection | Yes |
| 0230, 0231, 0232 | partner basis hoist, backup retention date, partner basis drop | **NOT APPLIED — written only** |
| **0233** | — | **next free number** |

**Repo/DB divergence noted:** the DB carries teammate migrations 0109–0112 that are not in
the repo. Numbering above follows the repo.

### Tests

`supabase/tests/ledger_foundation.sql` — self-rolling-back, **T1–T16**.
`supabase/tests/attendance_status.sql` — self-rolling-back, **T17–T31**.
`select * from ledger_checks('<company_id>')` for the eight reconciliation checks.

**The suite is not currently sound — see `docs/LEDGER_PHASE1_FIXTURE_AUDIT.md`.**
`ledger_foundation.sql` aborts at T9 (it calls `is_ledger_maintenance()`, dropped by 0224),
so T10–T16 have not run since. T4/T16 assert zero failing `ledger_checks` while two are
red by design. And 5 of 7 fixture writes construct state the application cannot produce —
Bank-mode rows with no bank account, disbursed payslips with no money moved, invoices with
no `contract_id`. A green test on an impossible path is worse than an untested one: it is
a false signal that stops anyone looking. **Two prior instances of a test passing for the
wrong reason make this a pattern, not a coincidence.**

There is also **no reconciliation check tying the `bank` control account to
`bank_accounts.balance` + `bank_transactions`** — which is why the sandbox can currently
hold 150,000 of ledger bank money the operational tables have never heard of, with
`ledger_checks` green. Worth a ninth check.

---

## 11. Errors made and corrected during the work

Recorded because the user asked for faithful reporting, and because two of them were the
system correctly defending itself.

| Error | Resolution |
|---|---|
| `record "new" has no field "journal_entry_id"` on first 0219 apply | plpgsql evaluates **every** branch of a `CASE` expression. Replaced with IF/ELSE. Verified clean rollback before reapplying. |
| Advance reclassification was non-idempotent | Added a `continue when exists (... source_table = 'ledger_correction_0219')` guard. |
| Manual-journal UI regression I introduced in 0219 | Two PostgREST calls = two transactions, leaving a line-less entry the deferred check rejected. Fixed with `post_manual_journal()`. |
| Wrong reconciliation formula — `salaries_payable_clears_on_disbursed_payroll` expected 0 | Wrong: undisbursed payslips legitimately leave a balance. Renamed to `salaries_payable_equals_undisbursed_net_pay`, expected = Σ net_salary where not disbursed. Caught **before** applying. |
| Two failed split tests — attendance month lock, then `attendance_records_enforce_reliever` overwriting my tampering | **The system was defending invariants; my tests were wrong, not the code.** The second failure revealed the trigger force-sets `worked_for_client_id`, which vindicated the design. |
| Test assertion counted reversal lines alongside live lines | Added `and je.is_reversal = false`. |
| Reused a `uuid` variable for `count(*)`; `coalesce()` on an enum; `c.active_status` does not exist on `clients` | Separate int variable; `e.category::text`; used `contract_end` as proxy — **`clients` has no active flag**. |
| Reported gunman-85 / armed-79 NULL-client rows as a live-org problem | Those were **global** figures. Live org has **0** of each. Corrected in Part E. |
| Called the case duplication the mechanism of the live-org reliever bug | Too strong — it is the sandbox mechanism and the live *latent* mechanism. Corrected in F1. |

---

## 12. Open questions blocking further work

| # | Question | Where | My recommendation |
|---|---|---|---|
| 1 | **`Leave`** — keep capitalised per 0141, rename to `leave` and fold `rotation_leave` in (3,462 rows), or make `rotation_leave` canonical? | F1.3 | Fold into lowercase `leave` — one token, consistent casing, 0141's intent preserved. Changes two writers and four readers, so it is your call. |
| 2 | **Lock bypass for the normalisation UPDATE** — disable triggers, extend `is_ledger_maintenance()`, or narrow each trigger's fast-path to ignore a casing-only change? | F1.6 | Extend `is_ledger_maintenance()`. The precedent exists, it is role-gated rather than a blanket suspension, and it leaves the locks intact for everyone else. It is a policy question about attendance locks, not accounting. |
| 3 | **What does `blocked` mean operationally** — guard available but prevented from working (site closed, client refused entry), or something else? And is it billable? | F2 | No recommendation — availability, billability and client attribution are three separate answers and all three depend on yours. |

---

## 13. What happens next, in order

1. **F1.3 / F1.4** — normalise to the canonical form, narrow the CHECK, fix the five
   case-sensitive comparisons and `supabase.ts:1480`. *Blocked on questions 1 and 2.*
2. **F2** — narrow `attendance_records_enforce_reliever` to the genuinely non-working
   statuses, so `relief_cover` and `double_duty` carry the covered client; backfill the 60
   live rows. Re-run all six reconciliation checks. *Blocked on question 3, and on F1 —
   the trigger must not be fixed against un-normalised data.*
3. **F3** — archive the clone: a company-level `archived` flag enforced in **RLS, not the
   UI**; no writes to any company-scoped table for an archived company, reads permitted.
   Confirm table coverage is complete and that no scheduled job writes to an archived company.
4. **F4.1** — the B8 arithmetic trace. **Stop and show before any fix.** July remuneration
   −1,326,374 vs P&L +747,531; August +4,116,869.31 vs operating loss −642,346. Show the
   derivation, then the corrected figures side by side — corrected numbers appearing without
   an explanation of why the old ones were wrong cannot be trusted either.
5. **F4.2–F4.7** — the allocation run record (`profit_allocation_runs`: unique on
   `(company_id, period_month)`, draft → posted → reversed, inputs stored alongside outputs,
   reversible as a unit via `reversal_of_entry_id`), the nested waterfall, removal of the
   "separate pools" logic and its UI footer, the pre-allocation review, and the new
   reconciliation checks — including the 135% check that **must fail before the fix and pass
   after**.
6. **Then** the remaining Part C items: employer EOBI gated on client tax profile;
   §5.3 (`income_tax_payable`, `tax_credit_receipts`); §5.4 (`bad_debt_expense`, three-state
   credit note / disputed / written-off); §5.5 (Unpresented Cheques); §5.6 removal of
   `apply_monthly_account_zeroing` **only**.

---

## 14. Standing constraints

- Do not invent accounting policy. Where Part A or the Part C answers are silent, **ask**.
- Do not change the partner current-account agency design (A9 i).
- Report each defect's **rupee magnitude** before fixing it.
- Every fix gets a test that **fails before and passes after**.
- Re-run all reconciliation checks after each part.
- Do not touch `company_counters`.
- Do not touch anything in the KEEP set.
- Do not delete the clone; archive it.
- If a table's classification is unclear, put it in UNCERTAIN and ask. A wrongly purged
  table is unrecoverable; a wrongly kept one costs nothing.
- The RESTRICT gate refusing a delete is **the gate working as intended** — do not work
  around it.
- Long documents go to files in the repo, not chat dumps.
