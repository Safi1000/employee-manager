# Which controls are actually invoked by something that runs

Run 2026-09-01 against `crm-design-dev`, after `tenant_guard_gaps()` was found
returning **19** with nothing calling it.

The question is not "does this check work". It is **"does anything ever ask it"**.
A detector nothing invokes is not a control; it is a function that returns the
truth to no one, and it is indistinguishable from a control that always passes.

## Method

Same shape as the read/write sweep, applied to controls rather than columns.
For every function whose name or signature marks it as a check — `gap`, `check`,
`drift`, `residue`, `blocker`, `completeness`, `missing`, `breach`,
`discrepanc`, `orphan`, `mismatch`, `unposted`, `over_allocated`, `negative_`,
`review`, `audit`, plus set-returning `_rows`/`_balances`/`_held_` — count the
places it is reachable from:

* another function's body (`pg_proc.prosrc`)
* a view definition
* an RLS policy expression
* a CHECK constraint
* a trigger (`pg_trigger.tgfoid`)
* the application (`src/**/*.ts,tsx`)
* the test suites (`supabase/tests/`)
* scripts and edge functions
* **`cron.job`** — checked explicitly, because "something that runs" most
  naturally means "runs on its own"

Migrations and `supabase/rollback/` are excluded as call sites: a migration that
created a function is not a caller, and the rollback capture is a dump.

## Result: five controls that nothing calls, anywhere

| function | writes? | invoked by |
|---|---|---|
| `bonus_accrual_missing(p_company_id, p_period)` | no | **nothing** |
| `check_deploy_guard(p_employee_id)` | **yes** — calls `raise_alert` | **nothing** |
| `check_disbursement(p_company_id, p_amount, p_is_payroll_or_statutory)` | **yes** — calls `raise_alert` | **nothing** |
| `first_breach_week(p_company_id, p_weeks)` | no | **nothing** |
| `profit_allocation_review(...)` | no | **nothing** — not even a test |

Two of these five *write*: they raise alerts. They were classified as reads by
the name/volatility heuristic that `0243`'s header records as having
misclassified four functions. So the schema contains two alert-raising controls
that have never raised an alert, because nothing has ever called them.

`profit_allocation_review` is the starkest: it appears nowhere outside the
migration that created it. No caller, no test, no script.

## One control that is duplicated instead of called

`attendance_gate_mode_residue(p_company_id)` is referenced only by
`supabase/tests/attendance_status.sql`. Nothing in the running system calls it.

The property it measures **is** checked — `no_gate_mode_in_attendance_status`
inside `ledger_checks_base` — but that check recomputes the condition inline
rather than calling the function. So there are two implementations of one rule,
one of which is invoked and one of which is not. Nothing forces them to agree,
and the uninvoked one is where the drift will accumulate unseen.

## The finding that outranks the list

**`ledger_checks()` itself is never called by the application.**

```
src/**            0 references
supabase/tests/   2 files
scripts/          1 file
cron.job          NOT SCHEDULED
```

Production's four cron jobs are `enforce-subscription-expiry-daily`,
`auto-invoices-monthly`, `send-compliance-alerts-daily` and
`raise-fixed-expenses`. **None of them runs a check.**

So the entire ledger-invariant suite — trial balance, AR control, salaries
payable, bank and cash controls, and as of `0286` the tenant-guard coverage
check — executes only when a person runs it by hand. Every one of those checks
is correct and every one of them can go red. Nothing asks them.

This is `tenant_guard_gaps()` one level up, and it is why the fix for
`tenant_guard_gaps()` was to wire it into `ledger_checks()` rather than to add
another standalone detector: putting a check inside a function nothing calls
moves the problem without solving it.

## What to do about it — proposed, not done

1. **Schedule `ledger_checks()`.** A daily `cron.job` per company that runs it
   and raises an alert on any failing row. This is the single change that turns
   nineteen correct checks into nineteen controls. It belongs with the ledger
   deployment, not the guard deployment.
2. **Decide the five.** Each is either wired to something that runs, or dropped.
   A control kept "for later" is indistinguishable from a control that does not
   exist, and the two alert-raising ones are the ones to decide first.
3. **Collapse the duplicate.** `no_gate_mode_in_attendance_status` should call
   `attendance_gate_mode_residue()` rather than recompute it, so the rule has
   one implementation.
4. **Keep this audit runnable.** The query above should become a check in its
   own right — a control that counts uninvoked controls — or this document is
   itself a detector nothing invokes.

Point 4 is not a joke. It is the same trap one level further out, and writing
this file without saying so would be walking into it.

## Correctly invoked, for completeness

`ledger_checks_base`, `custodian_held_operational`, `bank_held_operational`,
`negative_custodian_balances`, `unposted_source_rows`,
`profit_allocation_over_allocated`, `payroll_attendance_drift` and
`tenant_guard_gaps` are all reached through `ledger_checks()`.
`armed_post_blockers` and `sweep_ammo_discrepancy_alerts` are called by the
application. `log_audit_change` (36 triggers),
`check_cheque_capacity_trigger` (4), `refresh_termination_review` and
`seed_document_checklist_on_insert` fire as triggers.

Their invocation is real — but for the eight reached via `ledger_checks()`, it
is only as real as the invocation of `ledger_checks()` itself, which is the
finding above.
