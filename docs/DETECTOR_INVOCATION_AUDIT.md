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

## What to do about it

**Status as of 2026-09-01, after 0287-0289 (dev only):**

| | |
|---|---|
| 1. Schedule `ledger_checks()` | **NOT DONE** — belongs with the ledger deployment. It is the one item that matters most. |
| 2. Decide the five | **NOT DONE** — a policy decision, not an engineering one. See the two alert-raising controls below. |
| 3. Collapse the duplicate | **DONE** — `0289`. `ledger_checks_base` now calls `attendance_gate_mode_residue()`, and the reported figure is proved unchanged. |
| 4. Keep this audit runnable | **DONE** — `0288`/`0288b`. `uninvoked_controls()` is a check, wired into `ledger_checks()` as `every_control_is_invoked`, currently RED at 6. |

The original list, kept as written:

1. **Schedule `ledger_checks()`.** A daily `cron.job` per company that runs it
   and raises an alert on any failing row. This is the single change that turns
   nineteen correct checks into nineteen controls. It belongs with the ledger
   deployment, not the guard deployment.
2. **Decide the five.** Each is either wired to something that runs, or dropped.
   A control kept "for later" is indistinguishable from a control that does not
   exist, and the two alert-raising ones are the ones to decide first.
3. **Collapse the duplicate.** `no_gate_mode_in_attendance_status` should call
   `attendance_gate_mode_residue()` rather than recompute it, so the rule has
   one implementation. *(Done in 0289. Note found on the way: the two did not
   report the same number — inline counted blocked ROWS, the function counts
   EMPLOYEES. Collapsing naively would have silently changed a published
   figure, so the check sums the function's per-employee `rows` instead.)*
4. **Keep this audit runnable.** The query above should become a check in its
   own right — a control that counts uninvoked controls — or this document is
   itself a detector nothing invokes.

Point 4 is not a joke. It is the same trap one level further out, and writing
this file without saying so would be walking into it.

**And it bit on the first attempt.** `0288` shipped `uninvoked_controls()`
computing reachability as a substring match on `prosrc`. Its own exempt list
contains the comment "It is invoked by ledger_checks(); listing itself would be
noise" — so the check found the string `ledger_checks` inside a function body,
concluded something called it, and cleared the one function the whole audit was
written to expose. A check fooled by its own prose about the thing it was
checking. `0288b` strips comments and requires call syntax; `ledger_checks` now
reports itself, as intended. Third instance of "a mention is not a check" in
this codebase, and the first that failed as a FALSE NEGATIVE — which is worse
than the false positives in §9.6, because it was reassuring.

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


---

# The two alert-raising controls: what they were meant to catch

Asked for after the first pass. Both are `SECURITY DEFINER`, both call
`raise_alert`, both are invoked by nothing on **dev and production alike**
(0 callers on each, verified).

## `check_deploy_guard(p_employee_id) -> text[]`

**The rule:** a guard who fails vetting must not be deployed to a sensitive or
armed post, and an attempt to do so raises a **blocking** alert against that
employee.

It calls `armed_post_blockers(p_employee_id)` for the list of disqualifying
reasons, and if the list is non-empty raises a `blocking` alert with category
`deploy_unverified_guard` referencing the employee and their branch. Then it
returns the list.

**What actually happens today:** the application calls `armed_post_blockers`
*directly* — `src/app/components/EmployeeVettingFields.tsx:46` — and never calls
`check_deploy_guard`. So the UI renders the warning to whoever is looking at
that screen, and the alert is never raised.

The half that *renders* shipped. The half that *records* did not. Nobody
downstream learns that an unverified guard was put forward for an armed post,
there is no trace after the screen closes, and the alerts feed has never shown
one.

## `check_disbursement(p_company_id, p_amount, p_is_payroll_or_statutory) -> text`

**The rule:** when a company's cash position is in the RED danger band,
non-payroll, non-statutory disbursements are blocked and require a COO override.
Payroll and statutory payments always flow — they are the floor the band is
measured against.

It reads `danger_level.band`, returns `'allowed'` immediately for
payroll/statutory, and on `red` raises a `blocking` alert with category
`danger_level_disbursement` naming the amount, then returns `'blocked'`.

**What actually happens today:** nothing calls it. `danger_level` is read in
exactly one other place — `src/app/pages/super-admin/Treasury.tsx:53`, which
*displays* the band. No disbursement path consults it. Payroll disbursement,
expense payment and cash withdrawal all proceed regardless of the band.

It is also the **only** function in the schema that reads `danger_level` at all.
The table is populated (one row, currently `amber`), so the band is being
maintained and nothing consumes it.

## The fact that frames both

```
alerts table, dev  : 0 rows
alerts table, prod : 0 rows
```

**`raise_alert` has never produced a single row in either database.** This is
not two orphaned functions; it is an alerting mechanism that has never fired.
Whatever else is wired to `raise_alert` is in the same position — the feed has
nothing in it because nothing has ever put anything in it.

## Is this a code gap or a business gap

**Business.** Both functions encode a real operational rule, correctly, in one
place, with the right exemptions already thought through (payroll and statutory
bypass the band; the blocker list comes from the vetting rules rather than being
restated). Neither is half-written or wrong. They are simply not called.

So the questions are not for an engineer:

1. **Is the armed-post rule meant to block, or to warn?** Today it warns, on one
   screen, to one person. If it is meant to block, `check_deploy_guard` needs to
   sit in the deployment path and its return value has to be honoured.
2. **Is the RED-band disbursement rule real policy?** If it is, it belongs in
   `disburse_payroll_run`, the expense payment path and the cash withdrawal
   path, with the COO override as an `approval_requests` flow — the mechanism
   for that already exists. If it is not policy any more, the function and the
   `danger_level` band should go, because a rule that exists and is not enforced
   teaches readers that the schema describes the business when it does not.
3. **Is anyone meant to read the alerts feed?** Wiring either control raises
   alerts into a table nobody has ever looked at. A blocking alert nobody reads
   is the same failure one level up — the shape this whole audit is about.

Question 3 should be settled first. Wiring 1 and 2 before there is a consumer
just moves the silence.

## Recommendation

Do not wire either control until (3) is answered. Both are correct and both are
cheap to call; neither is worth calling into a feed with no reader. The decision
belongs with whoever owns the operational policy, and it is the same decision as
scheduling `ledger_checks()` — what an alert *does*, and what happens when one
stays unactioned.
