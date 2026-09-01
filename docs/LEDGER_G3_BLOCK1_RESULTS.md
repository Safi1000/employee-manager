# Block 1 results — the cheque lifecycle, the bank twin, and two raised questions

Companion to [LEDGER_G3_CHEQUE_CAUSE.md](LEDGER_G3_CHEQUE_CAUSE.md), which holds
the cause. Migrations 0269, 0270, 0271, applied to `crm-design-dev`
(`wlyhbvunvdsropqzlpwx`). Rupee magnitudes are for SANDBOX TESTING ORG,
2026-09-01.

## Before and after

| check | before | after |
|---|---|---|
| `cash_per_location_gl_equals_operational` | red, 2 locations | **green** |
| `cash_control_equals_cash_locations` | green at 595,990.13 | green at 605,990.13 |
| `bank_control_equals_bank_accounts` | red by 948,467.00 | red by 938,467.00 |
| `trial_balance_debits_equal_credits` | 32,418,510.61, balanced | 32,428,510.61, balanced |
| `every_source_row_posted` | did not exist | **green** |
| `bank_per_account_gl_equals_operational` | did not exist | **red, 6 of 9 accounts** |
| `checks_evaluated` | 13 | 15 |

The two 5,000 cheques posted, and they posted to the **named bank sub-accounts**
(Askari …0005, Habib Bank …0002) rather than the bank control — the first
per-bank-account routing anywhere in the system.

## The lifecycle, keyed to state

`sync_cheque_journal(cheque_id)` computes what the row's current state requires,
compares that to the live entry on four facts (date, debit account, credit
account, amount) and acts only on a difference. The trigger calls it; the
backfill is a loop over it. **The backfill cannot drift from the rule it
backfills, because it is the rule.** The trigger fires on INSERT as well as
UPDATE and DELETE.

Proved, both directions, in rolled-back transactions:

```
sync x2 on cheque #1234        -> unchanged, unchanged        (idempotent)
posting trigger disabled,
  a cleared cheque inserted    -> unposted 0 -> 1,
                                  every_source_row_posted passed=false
```

The second reproduces the 0221 defect deliberately: with the posting rule absent
when the row is written, the new check goes red. That is the property that was
missing.

## The new standing rule

> **Any migration installing a posting rule must state its backfill, or state
> why none is needed.**

0221 stated neither, and escaped consequence on seven of eight source tables
only because those tables had no qualifying rows yet.

## Where 0269 departs from the brief, and why

The brief said post at issuance for every cheque. That is implemented for
**payment** cheques, through the item — which is where the debit actually lives.
`journal_on_expense`, `journal_on_advance`, `journal_on_fixed_asset` and
`post_payslip_disbursement` now credit **Unpresented Cheques (2150)** instead of
bank when `payment_mode = 'Cheque'`, and the cheque relieves that liability
against the named bank account when it clears.

A **cash** cheque posts nothing at issuance, because at issuance nothing has
been exchanged: the custodian does not hold the money until the cheque is drawn,
and `treasury.cash_balance` agrees — it rises at clearing. Posting Dr Cash / Cr
Unpresented Cheques at issue would make `custodian_held_operational()` red for
every pending cash cheque, which is a check going red because the ledger asserts
something the world does not.

**RAISED, NOT RESOLVED:** should an outgoing cash cheque recognise a Cash in
Transit asset between issue and clearing? That is the coherent alternative, and
choosing it is accounting policy.

Two call sites were deliberately **not** changed: `journal_on_invoice_payment`
(an incoming cheque's `invoice_payments` row is created by
`cheque_apply_balance` at clearing, so Dr bank is already right) and
`journal_on_expense_settlement` (`paid_via` has no `Cheque` value).

`post_payslip_disbursement` additionally used to date cheque payments to the
*clearing* date — a second, incompatible answer to the same problem, which left
a disbursed payslip with no entry at all while its cheque stayed pending. That
is superseded.

Forward-only, checked rather than assumed: **zero rows** carry
`payment_mode = 'Cheque'` in expenses, advances, payslips, fixed_assets or
invoice_payments. Had that not held, 0269 would carry the repost under its own
rule.

**Consequence, stated so it is not discovered later:** `bank_accounts.balance`
falls when a cheque is written; the GL bank falls when it clears. Between those
moments they differ by the outstanding amount. That is the classic bank
reconciliation item, and 0271 treats it as one by name.

## T16, flipped by name

`enforce_period_lock`'s cheques carve-out gained `status` and `cleared_at`,
because clearing now posts at `cleared_at` and is a current-period event.
`supabase/tests/period_lock.sql` T16 was inverted in the same change — turned
deliberately, not discovered to have started failing — and it now asserts **both
halves**: the update is accepted AND the resulting entry is dated in the open
month. Asserting only the first would pass in exactly the case the old comment
was written to prevent. `docs/PERIOD_LOCK_COVERAGE.md` updated to match.

## 0270 — the last dead column

`payslips` had carried both `cash_location_id` (dead) and
`custodian_location_id` (live) since 0263/0267, which is worse than either alone:
a reader has to know which is which and nothing in the schema says. Zero rows
carried a value; the only surviving reference was the stale name in
`enforce_period_lock`'s payslip carve-out, removed with it.

---

# 0271 — what the bank-side twin found

`bank_held_operational()` compares, per **named** bank account, the GL balance on
its sub-account against the operational balance, with outstanding unpresented
cheques as an explicit reconciling item:

```
difference = gl - outstanding_unpresented - operational
```

Naming the reconciling item is the point. Widening a tolerance until the gap fits
inside it would be a check amended to fit an answer.

| account | operational | outstanding | gl | difference |
|---|---|---|---|---|
| aa | 108,101.00 | 0.00 | 110,101.00 | 2,000.00 |
| Askari Bank | 355,000.00 | 0.00 | 345,000.00 | −10,000.00 |
| Habib Bank Ltd | 536,822.00 | 50,000.00 | 1,245,000.00 | 658,178.00 |
| Meezan Bank | 3,843,255.00 | 0.00 | 5,000,000.00 | 1,156,745.00 |
| ss | 990,000.00 | 0.00 | 0.00 | −990,000.00 |
| United Bank Ltd | 0.00 | 0.00 | 800,000.00 | 800,000.00 |
| **total** | 5,833,178.00 | 50,000.00 | 7,500,101.00 | **1,616,923.00** |

Three accounts (abl, Bank Alfalah, JS Bank) are exactly 0.00, so the check
discriminates rather than merely always failing.

**The number that matters is 1,616,923 against the subtree check's 938,467.** The
difference — **678,456** — is misrouting between the control and its children
that cancels inside the subtree and was therefore invisible to every check that
existed. Same defect G2 closed on the cash side, surviving on the bank side
purely because nothing asked.

**New finding: bank-to-bank transfers post nothing to the GL.** `ss` is −990,000
and Meezan is 990,000 too high: the Meezan → ss transfer moved the operational
balances and never reached the ledger. Both accounts sit inside the bank subtree,
so the error cancels there — 990,000 of movement, invisible to
`bank_control_equals_bank_accounts` by construction. `bank_transactions` holds
four `transfer` rows netting to 0.00; `journal_entries` has no transfer source
table at all.

**Also visible:** a cash cheque may still name no custodian. 0268 requires one
for cash movements on expenses, invoice_payments, advances and payslips, but
`cheques` was not in that list — and a custodian-less cash cheque posts to the
undifferentiated cash control, which is the G2 shape re-entering through the door
0268 did not close.

---

# The 800,000 — established, not inferred

United Bank Ltd, `5eed0000-…-a3`. Opening balance 800,000.00, current balance
0.00, **zero** `bank_transactions` rows. The audit log has exactly two entries
and they settle it:

```
2026-08-25 06:28:58  insert  balance 800,000  opening_balance 800,000
                             auto_zero_monthly: true
2026-08-26 10:01:38  update  balance 800,000 -> 0
                             last_zeroed_month  null -> 2026-07-01
                             by Sandbox Admin
```

**By what path:** `public.apply_monthly_account_zeroing()`. It loops over every
`bank_accounts` row with `auto_zero_monthly = true` and, for each closed month
since `last_zeroed_month`, resets the balance. UBL had an opening balance and no
transactions, so the reset took the whole 800,000.

**When:** 2026-08-26 10:01:38 UTC, for period 2026-07.

This is the only one of the three components that is not a posting defect, and it
is worse in one specific way: the money did not leave through a path that failed
to post — it left through a path that writes **no `bank_transactions` row and no
journal entry at all**, so neither the ledger nor the operational transaction log
records that 800,000 ever moved. `bank_accounts_equal_transaction_deltas` is red
by exactly −800,000 for this reason, and it is the only check in the suite that
can see it.

Not fixed. Three questions belong to whoever owns the feature:

1. What is monthly zeroing *for*? If it models a sweep to a parent account, the
   counterparty is missing. If it models "this account is reconciled to zero each
   month", it is a display convention that must not touch a balance the ledger
   reads.
2. Should it write a `bank_transactions` row? Anything that moves a balance
   without one is invisible to the operational check by construction.
3. Should it post? An 800,000 movement with no journal entry cannot be right on
   any reading.

---

# The 88,467 — 29 payslips, and the shape is not arbitrary

All 29 are **July 2026**. No other month has a single instance. `bonus` is 0.00
on every one and `advance` is 0.00 on every one, so the excess is neither.

**28 of the 29 are a whole number of days at that employee's own
`per_day_salary`** — 81 extra days in total, between 1 and 6 days each.

| excess | payslips | excess | payslips |
|---|---|---|---|
| 1,000.00 | 2 | 3,194.00 | 2 |
| 1,032.00 | 3 | 4,000.00 | 1 |
| 1,065.00 | 2 | 4,129.00 | 1 |
| 1,097.00 | 1 | 4,355.00 | 1 |
| 2,000.00 | 3 | 4,387.00 | 1 |
| 2,065.00 | 2 | 5,000.00 | 1 |
| 2,194.00 | 1 | 5,161.00 | 1 |
| 3,000.00 | 1 | 5,270.00 | 1 |
| 3,097.00 | 1 | 5,484.00 | 3 |
| | | 6,581.00 | 1 |

The values that look round (1,000 / 2,000 / 3,000) are not a separate class —
they are whole days for employees whose `per_day_salary` happens to be 1,000.00.
TST-00002, TST-00017 and TST-00004 each show 1,032.00 against a `per_day_salary`
of 1,032.00: exactly one day.

**The one exception:** TST-00036, net 54,580.00, paid 59,850.00, excess 5,270.00
against a `per_day_salary` of 1,774.00 — **2.97 days**, 52.00 short of three.
Whether that is a rounding artefact or a hand-typed figure is not established.

**What this means for the policy answer.** The excess is not a bonus and not an
advance; it is extra *days worked*, paid but never accrued. `net_salary` is what
the payslip computed from the attendance it had; `amount_paid` is what left the
bank. The gap is attendance recognised after the payslip was calculated.

So the question is narrower than "what is the excess". It is: **why does paying
more than the accrual not re-accrue?** A5 accrues payroll independently of
disbursement, and `post_payslip_disbursement` relieves Salaries Payable by
`net_salary` while the bank pays `amount_paid`. The difference is a debit with
nowhere to go.

**No fix. Raised.** Three readings, each with a different journal:

1. **Extra days are payroll cost.** The accrual is short; re-accrue, and the
   disbursement relieves the larger payable. Requires deciding whether the
   attendance correction reopens July.
2. **Extra days are an ex-gratia payment.** Dr an expense at the disbursement
   date, Cr bank. July stays as computed.
3. **It is a recoverable overpayment.** Dr Employee Advances Receivable, Cr bank.

They differ in which month bears the cost and whether the employee owes it back.
That is policy, and per CLAUDE.md it is asked, not chosen.

---

## CORRECTION (2026-09-01): reading 1 was ruled, and the measurement refutes it

The ruling on the three readings above was **reading 1, payroll cost** — extra
days worked, accrue in July — taken on the strength of the pattern: whole-day
multiples of each employee's own `per_day_salary`, bonus and advance zero on all
29. That ruling is **withdrawn**, and it should not survive anywhere as received
wisdom.

`payroll_attendance_drift()` (migration 0284) compares each payslip's accrued
`present_days` against the live attendance record for that employee and month.
The status mapping was not assumed — five candidate formulas were measured
against all 48 payslips, and only one holds universally:

```
present_days = count(status = 'present')                48 of 48
present_days = count(present) + count(double_duty)       5 of 48
present_days = count(present) + count(relief_cover)      5 of 48
present_days = count(present) + 2 * count(double_duty)   5 of 48
present_days = count(present) + count(leave)             3 of 48
```

Against that mapping, **drift is zero on all 48 payslips, the 29 over-paid ones
included**. The accrual and the attendance agree exactly.

So the 81 extra days were never recorded as attendance at all. This is not
unaccrued work — reading 1 requires days that were worked and recorded late, and
there are none. It is a payment with no basis in any record, and the whole-day
arithmetic means someone computed it: **the calculation was deliberate and the
authority for it is nowhere in the database.** That is closer to reading 2 or 3
in shape, but neither is asserted here — the point of the correction is that the
evidence which looked like proof of reading 1 (whole-day multiples of each
employee's own rate) is equally consistent with someone computing an off-record
payment, and it never distinguished the two.

This is sandbox data and the 81 days are not being chased. What matters is
carried forward:

* **0277** adds `amount_paid` to `enforce_payroll_run_lock`'s protected set and
  a `payslips_paid_not_over_accrued` CHECK, so paying more than the accrual is
  impossible going forward rather than merely visible.
* **0284** covers the other direction — attendance corrected after accrual —
  which has not fired and has nothing preventing it. Green on arrival, proved
  against synthetic failure per §9.9.

The method note is the durable part: measuring five candidate formulas against
all 48 rows, rather than adopting the one that looked obvious, is the only
reason this came out right. Had `present_days = count(present) + count(leave)`
been assumed, drift would have appeared on 45 payslips and the wrong ruling
would have been confirmed by its own instrument.
