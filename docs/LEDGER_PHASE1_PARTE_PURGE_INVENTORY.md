# Part E — E0 report and E1 table classification

**Date:** 2026-08-29
**Live org:** `GUARDS AND GUIDES (PVT) LTD` — `7f7899a0-edd2-4491-a40d-f81b54c68d1e`
**Status:** Report only. Nothing deleted, no trigger changed.

---

## HEADLINE — the live org's financial tables are already empty

Every table on your PURGE list holds **zero rows** in the live org:

| PURGE table | Live rows | Rows elsewhere |
|---|---|---|
| `invoices` / `invoice_lines` / `invoice_payments` / `invoice_taxes` | **0 / 0 / 0 / 0** | 7 / 23 / 5 / 0 (sandbox) |
| `payslips`, `payroll_run_phases`, `payroll_runs` | **0 / 0 / 0** | 48 / 10 / 0 (sandbox) |
| `advances` | **0** | 1 (sandbox) |
| `expenses`, `expense_categories`, `fixed_expenses`, `fixed_expense_instances` | **0 / 0 / 0 / 0** | 5 / 22 / 2 / 8 |
| `bank_accounts`, `bank_transactions` | **0 / 0** | 9 / 65 (sandbox) |
| `cheques` | **0** | 3 (sandbox) |
| `treasury`, `cash_locations`, `custody_transfers`, `cash_deposits` | **0 / 0 / 0 / 0** | 2 / 13 / 1 / 0 |
| `partners`, `partner_account_entries`, `partner_client_shares` | **0 / 0 / 0** | 3 / 0 / 3 (sandbox) |
| `journal_entries`, `journal_lines` | **0 / 0** | 290 / 1,026 (sandbox) |

And these are empty in **every** org, so there is nothing to purge anywhere:

`profit_allocation_runs`, `profit_distribution_rules`, `opening_balance_batches`, `opening_balance_lines`, `fixed_assets`, `depreciation_entries`, `interregion_transactions`, `statutory_filings`, `issuances`, `inventory_items`, `incidents`, `incident_guards`, `daily_client_reports`, `daily_ok_reports`, `daily_report_exports`, `expense_receipts`, `vendors`, `guard_bonuses`, `payslip_adjustments`, `payslip_reward_lines`, `bonus_pools`, `bonus_accruals`, `bonus_pool_allocations`, `ho_allocation_runs`, `investor_ledger_entries`, `project_investments`, `finance_projects`, `finance_investors`, `finance_settings`, `reserve_policies`, `approval_requests`, `compliance_cases`, `tasks`, `vehicles`, `vehicle_logs`, `roster_assignments`, `posts`, `post_orders`, `no_show_events`, `disciplinary_warnings`, `recruitment_candidates`, `appraisals`, `kpi_values`, `alerts`.

**This is consistent with Phase 0**, which found production had no finance transactions at all — all financial rows live in `SANDBOX TESTING ORG`.

### What this means for E3

E3 would delete **zero rows** from the live org. The clean financial start you want already exists there. The purge is a no-op, and the parts of E3 that are *not* no-ops (snapshot, sequence reset, verification) either have nothing to snapshot or carry risk of their own — see the counter warning under UNCERTAIN.

---

## E0 — Reliever attendance

### E0.2 — Every status value present, with client behaviour

**Live org only:**

| Status | Rows | NULL client | Proposed class |
|---|---|---|---|
| `Present` | 19,064 | 730 | WORKING |
| `present` | 13,259 | 277 | WORKING |
| `Leave` | 2,991 | 23 | non-working |
| `Absent` | 729 | 3 | non-working |
| `double_duty` | 268 | **0** | WORKING |
| `absent` | 223 | 1 | non-working |
| `blocked` | 24 | 0 | non-working |

Present only in other orgs: `relief_cover` (2, sandbox), `rest_day` (146, sandbox), `rotation_leave` (113, sandbox).

**The status column is case-duplicated.** `Present` (19,064) and `present` (13,259) coexist in the live org, as do `Absent` (729) and `absent` (223). This is the *mechanism* of the reliever bug: the trigger tests `new.status = 'Present'` exactly, so all 13,259 lowercase rows take the `<> 'Present'` branch, which nulls a reliever's client.

### E0.3 — Gunman / armed NULL client: a sandbox-only issue

The earlier breakdown (gunman 85, armed 79) was **global**. Scoped to the live org:

| Category | NULL-client rows (live) |
|---|---|
| `office_staff` | 974 — **correct**, they have no client |
| `reliever` | 60 |
| `gunman` | **0** |
| `armed` | **0** |

**Live org has no gunman/armed NULL-client rows at all.** In the sandbox, the cause is guards with *no deployment segment covering the date* **and** no `employees.client_id` — `coalesce(deployment_client_on(...), emp_client)` resolves to NULL. It is an operational gap (attendance marked for an unassigned guard), not a trigger defect.

### E0.4 — Backfill resolvability (live org)

| Category | NULL rows | Fixable from `deployment_client_on()` | Fixable from `employees.client_id` | Permanently ambiguous |
|---|---|---|---|---|
| `office_staff` | 974 | 0 | 0 | 974 — *correct as NULL* |
| `reliever` | 60 | **0** | **60** | **0** |

So: **60 rows are backfillable**, all via the employee fallback; **zero** are recoverable from the deployments table; and the 974 office-staff rows should stay NULL.

---

## E1 — Table classification (live org row counts)

### KEEP — do not touch

| Table | Live rows | Note |
|---|---|---|
| `employees` | 550 | |
| `clients` | 43 | |
| `contracts` | 30 | |
| `contract_lines` | 70 | |
| `contract_addendums` | 3 | |
| `deployments` | 715 | **assignments** |
| `employee_salary_history` | 839 | **pay** |
| `attendance_records` | 36,558 | |
| `attendance_confirmations` | 1,140 | |
| `attendance_bulk_events` | 3 | |
| `attendance_month_verifications` | 0 | |
| `attendance_overrides` | 0 | |
| `guard_documents` | **4,440** | |
| `employee_document_checklist` | 5,500 | |
| `clearance_certificates` | **204** | |
| `employee_code_history` | 551 | guard-code immutability history |
| `employee_lifecycle_events` | 238 | |
| `employee_approval_events` | 28 | |
| `employee_references` / `employee_previous_jobs` / `employee_leave_overrides` | 4 / 1 / 1 | |
| `guard_contacts` | 58 | |
| `sites` | 34 | |
| `shift_definitions` | 40 | |
| `locations` | 8 | |
| `branches` | 4 | regions |
| `companies`, `profiles` | 4 orgs / 4 users | tenancy + auth |
| `vacancies` | 11 | |
| `client_complaints` / `client_service_reviews` | 1 / 2 | |
| `compliance_alert_log` | 1 | |
| `important_dates` | 4 | |
| `notification_settings` / `field_ops_settings` / `performance_settings` | 1 / 1 / 1 | config |
| `kpi_definitions` | 16 | config |
| `chart_of_accounts` | **50** | **config, not data — confirmed keep per E2.3** |

### PURGE — all already zero in the live org

Every table listed in the headline. **Nothing to delete.**

### UNCERTAIN — needs your decision

| Table | Live rows | Why uncertain |
|---|---|---|
| **`company_counters`** | **68** | E3.5 says "reset sequences and derived counters". **Do not.** These drive `guard_code`, `employee_code`, `client_code`, `contract_code`, `display_number`. Guard codes are permanent and immutable by design; resetting the counters would regenerate codes that collide with the 550 existing employees. Recommend: **KEEP untouched.** |
| `audit_log` | 18,606 | Brief says purge "entries relating to purged records". Since nothing is purged, that set is empty. The 18,606 rows are operational history (attendance, employee edits). Recommend **KEEP**. |
| `expense_categories` | 0 live (22 elsewhere) | Configuration, not transactions. Live is empty; when finance restarts it will need seeding. Recommend **KEEP as config**. |
| `approval_configs` | 6 | Approval thresholds for financial actions — config, not data. Recommend **KEEP**. |
| `ai_chat_threads` / `ai_chat_messages` | 65 / 162 (no `company_id` on messages) | AI assistant history. Not financial records, but message text may quote financial figures. Recommend KEEP; flagging because you may want them cleared. |
| `billing_events`, `signup_intents`, `subscription_payments`, `ai_credit_ledger` | 0 live | **Bastion's own SaaS billing**, not the client's finances. Out of scope for a financial purge. Recommend **KEEP**. |
| `org_copy_map_0186` | 4,679 | Traceability for the clone. Brief says purge "once the clone is retired" — but E4 says *archive*, not delete. If the clone survives, its trace map arguably should too. **Ask.** |
| `journal_lines` | n/a (no `company_id`) | Scoped only via its parent entry. Zero in live by implication. No action. |

---

## E2 preview — the one referential risk worth naming now

Because the live org's PURGE tables are empty, there are **no FK breakages to analyse** — a KEEP table cannot reference a row that does not exist. The full E2 analysis is therefore trivial for the live org, and I will produce it on request, but it will report zero breakages.

The one live-data risk is not referential but behavioural: **application code assuming a row exists** (a default bank account, a `treasury` row, at least one `cash_location`). The live org has none of these today and would hit those paths the moment finance features are opened. That is pre-existing, not caused by any purge.

---

## Questions before proceeding

1. **Given the live org is already financially empty, do you still want E3 run at all?** It would delete zero rows. My recommendation: skip E3, keep E0's fix and E4's archive.
2. **Status case normalisation.** `Present`/`present` and `Absent`/`absent` coexist (32,323 and 952 rows in live). Normalising is a data migration touching ~13,000 rows and changes what every status comparison sees. Do you want it, and to which casing? Until it is decided I will not change the trigger, because the correct predicate depends on the answer.
3. **Confirm the working/non-working classification** in E0.2 — specifically whether `blocked` and `rest_day` are non-working, and whether `double_duty` for a reliever should carry the covered client.
4. **`org_copy_map_0186`** — keep (clone is archived, not deleted) or purge?
