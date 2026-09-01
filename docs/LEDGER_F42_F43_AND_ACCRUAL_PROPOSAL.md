# F4.2 / F4.3 — the allocation posts, and a proposal for the accrual gap

Migrations 0276–0282, applied to `crm-design-dev` (`wlyhbvunvdsropqzlpwx`).

---

## F4.2 — the run record

`profit_allocation_runs` existed and held nothing, and its unique key was wrong
in a way worth naming: **`UNIQUE (company_id, period_month, status)`** permits a
DRAFT and a POSTED for the same month at the same time. A uniqueness constraint
that includes the status column does not constrain the thing it looks like it
constrains.

Now:

- `UNIQUE (company_id, period_month)` — one run per month, whatever its state, so
  the month's history is the row's audit trail rather than a pile of rows to
  disambiguate.
- `status` in `DRAFT → POSTED → REVERSED`.
- **Inputs stored beside outputs.** `inputs` holds, per regional partner per
  client: the client's Net Cash, the percentage applied, and the
  `partner_client_shares` row id it came from (null = the partner's default
  rate). `outputs` holds the full allocation result. A month can be explained a
  year later without re-deriving it from data that has since moved — which is
  exactly what made B8 unreproducible.
- Reversible as a unit: `entry_id`, `reversal_entry_id`, `reversed_at`.
- `run_profit_allocation()` refuses a closed month at the door (0250's rule — it
  posts a whole month, so against a closed period it would restate it), and
  refuses to run over an already-POSTED month, naming the reversal call in the
  hint.

## F4.3 — rows 33, 34 and 35

One journal entry per month, source `profit_allocation`, dated month-end.

```
regional share > 0    Dr Regional Partner Remuneration (6400)   Cr Partner Capital
regional share < 0    Dr Partner Capital                        Cr Regional Partner Remuneration
equity share  > 0     Dr Retained Earnings (3100)               Cr Partner Capital
equity share  < 0     Dr Partner Capital                        Cr Retained Earnings
```

**A negative share reverses the legs rather than posting a negative number**, so
every line is a positive debit or credit and the sign lives in which side it is
on. A9 permits negative shares with no floor, and both sandbox months exercise
that: every partner take is negative.

Before any line is written, the function asserts `regional + equity = profit` and
raises if it does not. Posting an allocation that does not exhaust the pool would
move the error into the ledger, where it is permanent.

### Posted, and the accounts moved

Both months run and posted on dev:

| month | basis | total profit | regional | equity | input rows | output rows |
|---|---|---|---|---|---|---|
| 2026-07 | cash | −131,120.00 | −25,224.00 | −105,896.00 | 7 | 9 |
| 2026-08 | cash | −644,345.87 | −128,869.18 | −515,476.69 | 7 | 8 |

Accounts that were 0.00 before:

| account | balance |
|---|---|
| 6400 Regional Partner Remuneration | −154,093.18 |
| 3100 Retained Earnings | −621,372.69 |
| 3000.01 Safi — Capital | 110,304.11 |
| 3000.02 HAMNA — Capital | 621,372.69 |
| 3000.03 Shayan — Capital | 43,789.07 |

Both months are losses, so the partners' capital accounts are **debited** —
equity reduced — and the remuneration expense carries a credit balance. That is
the arithmetic of A9 working, not a sign error: a regional partner's 15% of a
loss reduces what the company owes them.

Trial balance after posting: **37,930,888.48, balanced.**

## The pre-allocation review

`profit_allocation_review(company, month)` surfaces four things and blocks none
of them:

- clients with cost booked in the period and no invoice dated in it
- clients whose Net Cash is negative on the company basis
- pools that reached no region (`UNALLOCATED_HO`, `UNALLOCATED`)
- partners whose total for the month is negative

None is wrong on its face. A client with cost and no invoice may be a missed bill
or a client billed quarterly; a negative Net Cash client may be a loss-maker or a
timing artefact. Refusing to post on any of them would make the reviewer's job
the machine's, and the machine cannot tell which it is.

## The check, and the synthetic-failure proof

`profit_allocation_exhausts_pool` reads the **stored run record**, not the
function. That is deliberate: the 135% defect was fixed before its check was
written, so the real failure is unreachable and breaking the function to prove
the check would be worse than not proving it.

Proved in 0282, in a rolled-back subtransaction, on the real July figures:

```
old separate-pools rule   profit −131,120.00  regional −25,224.00  equity −131,120.00  -> RED
nested waterfall          profit −131,120.00  regional −25,224.00  equity −105,896.00  -> GREEN
```

Both directions. A check only ever seen red is as uninformative as one only ever
seen green.

`ledger_checks` now returns **17 checks plus the canary**.

---

# Proposal — connecting attendance to the accrual

**Not built. This is the proposal that was asked for.**

## The gap, restated

Nothing in the database connects attendance to payroll. `attendance_records`
carries nine triggers and none touches `payslips`; no function reads
`present_days` to recompute anything. The only recompute is client-side, at
payroll generation, and it happens when a human reopens that month in the UI.

0277 has now made the locks symmetric — `amount_paid` joined the payroll-run
lock's protected set and a CHECK makes `amount_paid > net_salary` impossible —
so the escape hatch that produced the 88,467 is closed. **Closing the hatch does
not open the door.** An operator who learns a guard worked three more days now
has *no* lever at all, which is worse for them and better for the ledger. The
recompute path is what makes it right rather than merely impossible.

## Why it should not be a trigger

The obvious shape — a trigger on `attendance_records` that recomputes the
payslip — is wrong for three reasons:

1. **Fan-out.** One bulk attendance import touches thousands of rows; each would
   recompute a payslip, and each recompute reverses and reposts a journal entry.
   The month's ledger would be rewritten thousands of times to reach the same
   end state.
2. **It cannot ask permission.** A correction to an approved run, or to a closed
   month, is a decision. A trigger has no way to raise it and no way to defer it;
   it can only refuse or proceed, and both are wrong some of the time.
3. **The computation lives in the client.** The payroll arithmetic — countable
   leaves, double-duty shifts, effective present days — is in
   `PayrollManagement.tsx`, not in SQL. A trigger would need a second
   implementation of it, and a second implementation is the divergence risk the
   fixture audit was written about.

## The shape proposed instead

**An explicit, reviewable recompute for one month, run on demand.**

1. **A drift report, first and cheapest.**
   `payroll_attendance_drift(company, period_month)` compares each payslip's
   stored `present_days` / `absent_days` / `leave_days` against what
   `attendance_payroll()` says for the same employee and month, and returns the
   rows that disagree with the money difference at the employee's own
   `per_day_salary`. **This alone would have surfaced the 88,467 the day it
   happened**, and it is a read-only function that can ship before any decision
   about correcting anything. It is the piece worth building first regardless of
   what follows.

2. **A recompute RPC, `recompute_payroll_month(company, period_month)`**, which:
   - refuses if the run is POSTED or the period is closed, naming the reopen
     path in the hint — the same door `run_ho_cost_allocation` and
     `run_profit_allocation` use;
   - recomputes each payslip's day counts and `final_salary` / `net_salary`;
   - lets `journal_on_payslip` repost the accrual through the existing path,
     which already watches `final_salary`;
   - records what it changed, per payslip, in a run record shaped like
     `profit_allocation_runs` — inputs beside outputs, reversible as a unit.

3. **The arithmetic must move into SQL, once.** This is the real cost and it
   should be stated plainly rather than discovered halfway. Either the payroll
   computation is lifted out of `PayrollManagement.tsx` into a function both the
   UI and the recompute call, or the recompute is an application job that
   re-runs the existing client code server-side. **The one option that must not
   be taken is writing the arithmetic a second time in SQL.**

4. **A check to close it.** `payroll_accrual_matches_attendance` — count of
   payslips whose day counts disagree with attendance for a POSTED month.
   Expected red on arrival at 29, green after the recompute, and provable in both
   directions by editing an attendance row on a fixture.

## The policy question the proposal cannot answer

Correcting July's accrual restates July. A4 puts revenue at the service month
and A5 accrues payroll independently of disbursement, so the extra days are July
cost and belong in July — that is the ruling already given. But if July is
closed, the recompute must either reopen it or post a correcting accrual in the
open month, and those produce different monthly P&Ls.

**Which one is right is policy, and it is the one question that must be answered
before any of the above is built.** Everything else in this proposal follows from
the answer rather than depending on it.
