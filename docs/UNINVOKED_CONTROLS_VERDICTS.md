# The sixteen: a verdict each

Run 2026-09-01 against `crm-design-dev`, after `0301` scheduled
`ledger_checks()` and removed it from this list.

`uninvoked_controls()` reports **16**: three functions and thirteen views.
Every one gets one of three outcomes — **wire it**, **delete it**, or **keep it
with a written reason**. Nothing stays unexplained; "we might need it later" is
not a verdict, it is the absence of one.

---

## The line that organises the list

**Four of these exist to be compared against something, and are compared
against nothing.** A reconciliation nobody reads is not a weaker control than a
broken one — it is the same control as none, with the added cost that the
schema claims otherwise. They are:

| view | what it reconciles | difference today |
|---|---|---|
| `cash_control_reconciliation` | cash posted directly to the control account vs posted to its children | **0.00** on all four companies |
| `cash_entitlement_reconciliation` | sum of `cash_entitlements` vs the actual pool cash | **0.00** |
| `bonus_reserve_balances` | bonus reserve held vs bonus obligation accrued | no rows (no bonus data) |
| `interregion_balances` | what each region owes each other region, netted | no rows (no interregion transactions) |

The first two are the important pair: **they reconcile to zero right now**,
which is exactly what makes them wireable. A control that is currently clean is
quiet *and able to speak* — the `0297` criterion. They are the only two items
in this document that are ready to become checks today with no other change.

---

## The three functions

### 1. `bonus_accrual_missing(p_company_id, p_period) → boolean` — **KEEP, with a reason**

**Computes:** whether a `bonus_accruals` row exists for the given month. Returns
`true` when it is *missing*.

**What would consume it:** a monthly check — "the bonus accrual for last month
was never posted".

**Verdict: keep, do not wire yet.** `bonus_accruals` has **zero rows**. The
function therefore returns `true` for every company and every period, so wiring
it produces a control that fires on every input — `9.11`, and the exact reason
`0296` refused `check_deploy_guard`.

**The condition that changes the verdict is specific and testable:** wire it the
first month `bonus_accruals` is non-empty. Until then it is a measurement of a
feature nobody uses, not an event.

### 2. `first_breach_week(p_company_id, p_weeks) → date` — **WIRE**

**Computes:** the first week in `cash_forecast()` where cash breaches the floor.
Returns `NULL` when there is no breach in the horizon.

**Measured across all four companies at 13 weeks:**

```
GUARDS AND GUIDES (PVT) LTD   null
guards n guides               null
SANDBOX TESTING ORG           2026-08-31   <- a real forecast breach
Sandboxx                      null
```

**Verdict: wire it.** This is what a working control looks like and it is
already built: silent on three companies, speaking on the one with real cash
data. Null-when-healthy means it cannot become noise, and a forecast breach is
the most actionable thing in this document — it is the only item that is about
the future rather than about the past.

**How:** a `ledger_checks` row, red when `first_breach_week(company, 13)` is not
null, with the breach date in the message. That makes the canary 22 — **and the
number now lives in one place (`0302`), so the bump is a single edit.**

### 3. `profit_allocation_review(p_company_id, p_period) → TABLE(…)` — **KEEP, with a reason, and it needs a fix first**

**Computes:** period-close review rows — the first arm is
`client_cost_no_invoice`, *"expenses booked to this client but no invoice dated
in the period"*.

That is **the Palm Grove pattern**, which surfaced twice independently: a client
absorbing cost with nothing billed against it. So this function is not
redundant; it is the only thing in the schema that asks that question directly.

**But it cannot currently be called at all.** Every invocation throws:

```
ERROR 23502: No partner remuneration basis configured for this company
             — apply migration 0230
```

`partner_basis_for_report()` reads `finance_settings` for
`current_company_id()`, and `current_company_id()` is **NULL in any service-role
or no-JWT context** — a migration, psql, pg_cron. So the function is callable
only from a logged-in user session, and it fails on every company on dev even
from one, because no company has `partner_remuneration_basis` set.

**Three consequences, and the third is the one that matters:**

1. Its correctness has never been exercised by anything — no caller, no test,
   and it would have thrown immediately if there had been one.
2. It **cannot be added to `ledger_checks()`** as it stands. The scheduled run
   has no tenant identity, so the whole suite would throw for every company.
3. That is not a defect in `partner_basis_for_report` — refusing to draw a
   report on an unconfigured basis is correct, and the tripwire against mixing
   two bases is the `defect-1` lesson working as intended. The mismatch is that
   a *review* function inherited a guard designed for a *report*.

**Verdict: keep, with the reason recorded, and revisit when the accounting
policy questions land.** Two things have to be decided by someone else first:
whether `partner_remuneration_basis` is configured per company at go-live, and
whether this review is a period-close report a person runs (in which case the
current guard is right and it needs a screen) or a continuous control (in which
case it needs a company-scoped basis lookup instead of `current_company_id()`).

**Do not wire it into the scheduled suite under any reading** until (2) is
resolved — it would take the entire ledger check suite down with it.

---

## The thirteen views

Four are the reconciliations above. The rest divide cleanly by *why* nothing
reads them.

### Empty because the feature has no data — **KEEP, with a reason** (5)

Each is correct, cheap, and currently returns nothing because its source table
is empty. Wiring or deleting either would be premature: wiring produces a
control that cannot speak, deleting throws away work that becomes useful the
day the feature is used.

| view | source | rows in source |
|---|---|---|
| `bonus_reserve_balances` | `bonus_accruals` | 0 |
| `interregion_balances` | `interregion_transactions` | 0 |
| `kpi_department_dashboard` | `kpi_values` | 0 |
| `low_stock_items` | `inventory_items` with a `reorder_level` | 0 |
| `payslip_reward_breakdown` | `payslip_reward_lines` | 0 |

**The recorded condition for each: revisit when its source table is non-empty.**
`low_stock_items` is the one most likely to trip that first — it needs only one
inventory item to be given a reorder level.

### Reconciliations ready to become checks — **WIRE** (2)

| view | verdict |
|---|---|
| `cash_control_reconciliation` | **Wire.** `difference` must be zero; it is zero on all four companies today. Quiet and able to speak. |
| `cash_entitlement_reconciliation` | **Wire.** Same shape, same state. Entitlements summing to something other than the pool is a real accounting failure and nothing currently asks. |

Both are one `ledger_checks` arm each. Together with `first_breach_week` that
takes the suite from 21 to 24 — and after `0302` the canary is a single number,
so that is one edit.

### Reporting surfaces with no screen — **KEEP, with a reason** (4)

These are not controls. They are shaped for a UI that does not exist yet, and
`uninvoked_controls()` flags them only because its view arm has no name filter —
deliberately, since a name filter is what let `compliance_upcoming` hide.

| view | what it presents | what would consume it |
|---|---|---|
| `employee_service_history` | one timeline per employee, merging lifecycle events and document/warning history — **244 real rows** | an employee-record history tab |
| `contract_amendment_history` | addenda and changes per contract, as a dated feed | the contract detail screen |
| `payroll_run_totals` | gross/deductions/net per payroll run and branch — **48 payslips behind it** | the payroll run screen's summary band |
| `journal_lines_regional` | journal lines decorated with region name, code and kind | any regional drill-down report |

**`employee_service_history` and `payroll_run_totals` have real data behind them
and no reader.** Those two are the strongest candidates for a screen, and the
verdict is recorded rather than acted on because building a UI tab is not a
control decision.

### Review surfaces awaiting their feature — **KEEP, with a reason** (1)

| view | verdict |
|---|---|
| `compliance_weekly_review` | Computes an overdue flag per compliance case. `compliance_cases` has **0 rows** — the compliance-case feature has never been used. Same verdict as the empty five: revisit when a case exists. |

### The one that should be a report, and already is — **KEEP, with a reason** (1)

| view | verdict |
|---|---|
| `vetting_dashboard` | **This is the guard-data coverage report, as a view.** It counts police-pending, police-adverse, NADRA and the rest per company and branch — the exact table in `GUARD_DATA_COVERAGE_PRODUCTION_2026-09-01.md`, which was assembled by hand without noticing this existed. |

That is worth stating plainly: **I wrote a query that already existed as a
view.** The view is correct and nothing reads it, so the coverage measurement
was rebuilt from scratch by someone who could not see it — the precise cost of
an uninvoked object, paid in the same session that catalogued them.

**Verdict: keep, and point the vetting-upload progress report at it** rather
than at a hand-written query, so the number Shayan watches during the upload and
the number the schema computes are the same number. Not wired as a *check* — the
coverage figure is a measurement, not an event (`9.11`).

---

## Summary

| outcome | count | items |
|---|---|---|
| **Wire** | 3 | `first_breach_week`, `cash_control_reconciliation`, `cash_entitlement_reconciliation` |
| **Delete** | 0 | — |
| **Keep, with a written reason** | 13 | the rest, each with the condition that would change the verdict |

**Nothing is recommended for deletion.** That is a real conclusion rather than
an avoided one: every item is either correct-and-waiting-for-data, or
correct-and-waiting-for-a-screen, and none is wrong or superseded. The three
`trial_balance`-shaped duplicates were the ones worth removing, and `0289`,
`0299` and `0291` removed them.

The three "wire" items are small — three `ledger_checks` arms — and they are the
only ones that can be done without another decision landing first.
