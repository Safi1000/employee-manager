# G2 — why 15 posted cash lines carry no location

Investigation only. Nothing changed.

**Database: `crm-design-dev` (wlyhbvunvdsropqzlpwx).** The first pass of this
investigation ran against `crm-design`, which is still at 0229 and does not have
the 0239/0259 checks at all. Numbers below are from dev, and they reconcile to
the check exactly.

## The answer

**The location is present. The posting path reads the wrong column.**

My earlier claim — that most call sites cannot route through `cash_account_for()`
because the source rows may not carry a location — is **wrong**, and it was wrong
in a way I should have checked before asserting it.

Four tables carry **two** columns for the same fact:

| table | `cash_location_id` | `custodian_location_id` |
|---|---|---|
| `expenses` | **0 rows set** | 2 rows set |
| `invoice_payments` | **0 rows set** | 2 rows set |
| `advances` | **0 rows set** | 0 rows set (latent) |
| `payslips` | **0 rows set** | *column does not exist* |

`cash_location_id` is set on **zero rows of every table in the database**. The
application never writes it: `grep -rn cash_location_id src/` returns hits only
for `partner_account_entries`, a different table. What the application does write
is `custodian_location_id`, through `ensureCustodianLocation()`.

Seven posting functions read `cash_location_id`:

```
journal_on_advance              cash_location_id   -> DEFECTIVE (dual-column table)
journal_on_expense              cash_location_id   -> DEFECTIVE
journal_on_expense_settlement   cash_location_id   -> DEFECTIVE
journal_on_invoice_payment      cash_location_id   -> DEFECTIVE
journal_on_payslip              cash_location_id   -> DEFECTIVE (+ upstream gap)
post_payslip_disbursement       cash_location_id   -> DEFECTIVE (+ upstream gap)
journal_on_cash_deposit         cash_location_id   -> correct: cash_deposits has only this column
journal_on_partner_entry        cash_location_id   -> correct: partner_account_entries has only this column,
                                                     and the UI writes it
```

Two functions read `custodian_location_id` instead — `journal_on_cheque` and
`record_bank_to_custodian` — and those are the only routine paths whose postings
land on a per-location account. That is the control experiment: where the
posting path reads the column the application populates, the routing works.

So the resolver is right, the accounts are right, the check is right. One column
name is wrong in seven places.

## Per line, with money

15 lines, net Dr **595,990.13** — matching `cash_control_equals_cash_locations`
to the paisa.

### Category 1 — location on the source row, ignored by the posting path (4 lines, +556,000.13)

| source | amount | location it should have carried |
|---|---|---|
| `expenses` 7b4392ee "EOBI" | 1,999.87 Cr | **Safi** |
| `expenses` 2340a084 "Taxes" | 2,000.00 Cr | **HAMNA** |
| `invoice_payments` afe3c792 | 60,000.00 Dr | **HAMNA** |
| `invoice_payments` 227b4057 | 500,000.00 Dr | **Kiran Shah** |

Straightforward code defect. Fix the call site and the repost lands correctly
with no upstream change and no data entry.

### Category 2 — location known to the app, never persisted (2 lines, −110,010.00)

| source | amount | location, recovered from |
|---|---|---|
| `payslips_disbursement` 002af113 | 48,533.00 Cr | **Kiran Shah** — `bank_transactions.reference_id` |
| `payslips_disbursement` 79c10a5a | 61,477.00 Cr | **HAMNA** — `bank_transactions.reference_id` |

`PayrollManagement.tsx` computes `custodianLocId` at disbursement and writes it
**only** into `bank_transactions.reference_id`, never onto the payslip —
`payslips` has no `custodian_location_id` column to write it to. Both values are
recoverable today, so the repost can be correct, but the recovery route is a
`uuid` stuffed into a `text` reference column, which is not a foundation.

### Category 3 — genuinely no location (1 line, +150,000.00)

`invoice_payments` 59bd7029, the 2026-09-15 period-split fixture receipt. Both
location columns NULL, because the fixture wrote none. **This is fixture data,
not production data.** The remedy is the fixture, not a reversing entry — and it
is a seventh divergence for the fixture-audit rule: the corrected fixture still
writes a cash receipt with no custodian, which `record_invoice_payment` via the
Cash Custody path would never produce.

### Category 4 — reversal/original pairs, net zero (8 lines, 0.00)

Payroll accrual Jun ±48,533, payroll accrual Jul ±63,613, "TEST fuel" ±1,500,
payment ±8,000. Two of the four source rows (`expenses` a49a2cc9,
`invoice_payments` c181a02c) **no longer exist** — deleted after reversal.

These are already reversed. Reversing them again would be nonsense, and for two
of them there is no source row to repost from. They contribute nothing to the
595,990.13 and need no correction.

### Which means the correction is 6 lines, not 15

| category | lines | net | action |
|---|---|---|---|
| 1 — column misread | 4 | +556,000.13 | reverse + repost |
| 2 — location not persisted | 2 | −110,010.00 | reverse + repost, from the recovered location |
| 3 — fixture | 1 | +150,000.00 | fix the fixture |
| 4 — already reversed | 8 | 0.00 | leave alone |

## The three answers, directly

**1. Does the source row carry a location?** For 4 of the 15, yes — in
`custodian_location_id`, which the posting path does not read. For 2 more, the
app knew it and put it somewhere else. For 1, no, and that one is mine. For 8,
the question does not apply.

**2. If not, why not?** Not a nullable-column problem and not a UI-collection
problem. It is **two columns for one fact**, with the writer using one and the
reader using the other. The one genuine gap is `payslips`, which has no
custodian column at all while the disbursement UI plainly knows the value.

**3. How many in each category, and how much.** Table above. Category 1 is 93.3%
of the 595,990.13 and needs no upstream work at all.

## What this changes about the fix

The upstream remedy you sketched — NOT NULL plus a UI change — is not the
remedy, because the UI is already collecting it. The remedy is:

- **repoint the seven readers at `custodian_location_id`** where the table has
  it (5 functions), leaving `cash_deposits` and `partner_account_entries` alone;
- **add `custodian_location_id` to `payslips`** and have the disbursement write
  it, instead of smuggling it through `bank_transactions.reference_id`;
- **then** a NOT NULL is meaningful — a cash movement cannot be posted to an
  unnamed box — but only once every writer has a column to fill;
- **drop `cash_location_id`** from `expenses`, `invoice_payments` and `advances`,
  or the next reader picks the wrong one again. A column nothing writes and
  something reads is the defect itself, not a side effect of it.

The per-location check stops the 16th either way, and should be written first.

## Built and unwired — the wider sweep you asked for

`cash_location_id` on those four tables **is** the pattern, found by looking:
created, referenced by seven posting functions, written by nothing, for however
long the sandbox has existed. The ledger at Phase 0 was in exactly this state.

Two related readings from this pass, correcting an earlier statement of mine:
the per-location cash accounts are **not** entirely unused. Seven journal lines
sit on them — 5 from `opening_balance_batches` (all on bank-mirror locations)
and 2 from `custody_transfers`. So the custodian cash accounts have exactly two
lines between them, both from the one path that reads the right column.

A fuller sweep for "built and never wired" is worth doing as its own item rather
than inline here; the query shape that found this one is *columns referenced by
functions but never written by the application*, and it generalises.
