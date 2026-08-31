# Repost-set audit — every `journal_on_*` trigger

**The rule.** A posting trigger's repost condition must contain every field the
posting body reads. A field that is read but not compared is a posting rule
whose own change-detection ignores it: the row changes, the trigger returns
early, and the ledger keeps a figure derived from the old value. Nothing errors.

Two instances prompted this — `payment_mode` on advances (0256) and the
`contract_id` question on invoices — and the assumption going in was that there
would be more. There are.

## Method, and its one correction

Mechanical inventory to *enumerate*, reading to *judge*, probing to *confirm*.
The inventory is not the check (§9.6: a `prosrc` grep is not a check); it only
produces candidates.

The first pass treated any `old.X` reference as "watched". That is wrong, and it
hid the largest finding: in most of these functions the posting date appears as
`old.<date>` **only inside the `reverse_journal_for_source` call**, never in a
comparison. Counting that as watched made eight date columns invisible. The
second pass extracts only the comparison set — `old.X is [not] distinct from`,
`coalesce(old.X, …)`, `old.X =` — and is what the table below reports.

## The table

`journal_on_interregion` fires on INSERT and DELETE only; its column list cannot
matter and is marked n/a. Everything else fires on UPDATE.

| trigger | compared by the repost test | read but never compared |
|---|---|---|
| `journal_on_invoice` | branch_id, client_id, invoice_amount, invoice_date, period_start, tax_added_total | **— none —** |
| `journal_on_advance` | amount, branch_id, cash_location_id, payment_mode, advance_date, employee_id, client_id | **— none —** (after 0256) |
| `journal_on_payslip` | advance, branch_id, cash_location_id, disbursed_at, employee_id, eobi, eobi_employer, final_salary, income_tax, net_salary, payment_mode, period_month | disbursed |
| `journal_on_cash_deposit` | amount, cash_location_id | **deposit_date** |
| `journal_on_custody_transfer` | amount, from_location_id, to_location_id | **date** |
| `journal_on_fixed_asset` | branch_id, category, cost, payment_mode | **acquisition_date**, name |
| `journal_on_expense` | amount, branch_id, cash_location_id, category_id, payment_mode | **expense_date**, **pl_category**, client_id, description |
| `journal_on_invoice_payment` | amount, branch_id, cash_location_id, withholding_amount | **payment_date**, **payment_mode**, client_id, invoice_id |
| `journal_on_partner_entry` | amount, bank_account_id, cash_location_id, payment_method, type | **partner_id**, **date**, description |
| `journal_on_expense_settlement` | payable_status | **paid_at**, **paid_via**, **amount**, branch_id, cash_location_id, client_id, description, payment_mode |
| `journal_on_cheque` | status | **cheque_date**, **custodian_location_id**, **cheque_type**, **direction**, amount, branch_id, cheque_number |
| `journal_on_interregion` | n/a — INSERT/DELETE only | n/a |

**Two of twelve are clean.** `journal_on_invoice`, because G0.2 forced that
audit, and `journal_on_advance`, because 0256 just did.

## The finding nobody was looking for

**Eight of eleven UPDATE-firing triggers post at a date they never compare.**
Move a transaction to a different month and the ledger leaves it in the old one.
Measured on dev, open months, rolled back:

```
EXPENSE posted at    : 2026-08-01   (expense_date 2026-08-01)
moved expense_date to  2026-07-01
  journal entries now : 1
  latest entry_date   : 2026-08-01   <-- STILL THE OLD MONTH
```

One entry, unmoved. The expense claims July; the P&L charges August.

This interacts badly with the period lock. `enforce_period_lock` has a whole
branch for date moves — *"Moving a transaction out of a closed month requires
reopening it first"* — which exists to stop a transaction leaving a closed
period. It is guarding a move the general ledger does not make.

## The most severe single instance

**`partner_id` on `partner_account_entries`.** The posting reads it to find the
partner's capital account *and* to derive the region. Reassigning an entry
credits the wrong partner's capital, permanently. Measured:

```
PARTNER entry credited: 5fdf4919…   (= partner 1 capital)
reassigned to partner 2 (capital a6091960…)
  credited now        : 5fdf4919…   <-- STILL PARTNER 1
```

Partner capital is F4's subject matter. An entry that moves between partners
without moving its equity posting misstates both partners' accounts and every
allocation computed from them.

## Ranking, for whoever fixes these

1. **`partner_id`** — wrong partner's equity. Silent, permanent, F4-relevant.
2. **The eight date columns** — a transaction in the wrong month, and the period
   lock guarding a move the GL does not perform.
3. **`paid_via` / `amount` on `journal_on_expense_settlement`** — the same
   Cash/Bank defect 0256 just fixed for advances, on the settlement path, plus a
   settlement whose amount can drift from the accrual it clears.
4. **`payment_mode` on `journal_on_invoice_payment`** — the same defect again, on
   the receipt path. Three instances of one bug across three tables.
5. **`custodian_location_id` / `cheque_type` / `direction` on
   `journal_on_cheque`** — the cash location the cheque cleared into, and whether
   it should have posted at all. G3 rewrites this function; fold it in there.
6. **`pl_category` on `journal_on_expense`** — changes the expense account key
   through `map_expense_to_coa_key` with no repost.

**Judged not to be defects**, recorded so they are not re-raised:

* `client_id` on expenses and advances — `inherit_region_expense` and
  `inherit_region_advance` fire on it and write `branch_id`, which *is* compared,
  so a client change normally reposts. Probed and confirmed. It remains a real
  gap only when two clients share a region; that case is unproven either way.
* `description` / `name` / `cheque_number` — memo text on the entry. The memo
  goes stale; no figure moves.
* `amount` / `bank_account_id` on cheques — refused by a separate immutability
  trigger before the repost condition is ever reached.
* `disbursed` on payslips — `disbursed_at` is compared and moves with it.

## What is fixed

| fix | migration | verified by |
|---|---|---|
| `payment_mode` + `advance_date`, `employee_id`, `client_id` on advances | 0256 | probe, then P1 |
| `partner_id` on partner entries | 0257 | P2 |
| **the posting date, in all eight remaining triggers** | 0258 | P1 across 9 source tables |

`supabase/tests/repost_sets.sql` asserts the class as one property — move a
posted row's date, the old month must be vacated — rather than eight separate
assertions. **9 passed, 0 failed** on dev.

Two of the eight were not a one-line edit, and that is worth remembering.
`journal_on_cheque` and `journal_on_expense_settlement` have no general "did
anything relevant change" test; both are driven by a status transition and
return early when the status did not move. The date case needed a *third*
branch — staying in the state while the date moves — alongside entering and
leaving it. Added as an `or` they would have compiled, matched the other six by
eye, and changed nothing.

## What is still open



Everything in the ranked list except items 1 and 2, which are done. Remaining,
in the same order:

3. **`paid_via` / `amount` on `journal_on_expense_settlement`** — the Cash/Bank
   defect 0256 fixed for advances, on the settlement path, plus a settlement
   whose amount can drift from the accrual it clears.
4. **`payment_mode` on `journal_on_invoice_payment`** — the same defect again,
   on the receipt path. Three instances of one bug across three tables, and only
   one of the three is fixed.
5. **`custodian_location_id` / `cheque_type` / `direction` on
   `journal_on_cheque`** — G3 rewrites this function; fold it in there.
6. **`pl_category` on `journal_on_expense`** — changes the expense account key
   through `map_expense_to_coa_key` with no repost.

And one that is not in the table at all, because it is a different shape:
**`journal_on_partner_entry` depends on three columns of the PARTNERS row** —
`coa_account_id`, `scope`, `branch_id`. Changing a partner's capital account or
scope does not repost the entries already posted against them. Cross-table
staleness; no repost condition on the entry can see it.

Separately: **`partner_account_entries` had no audit trigger.** advances,
cheques, expenses, invoices and payslips all carry `log_audit_change`; the table
holding partner capital movements did not. That is why "has any row ever changed
partner_id" could not be answered from history and had to be answered from state
instead — which is the better question, and is now the standing form, but it was
not a choice at the time.

**Fixed in 0261**, verified by `supabase/tests/opening_gate_and_partner_audit.sql`
(A1–A3: insert, update and delete each write an `audit_log` row, and the update
row names `partner_id` with both before and after). The table is empty on both
environments, so the trigger lands before the rows do and no blind window
survives.

**`public.partners` still has none**, and `journal_on_partner_entry` depends on
three of its columns. Both sides of the cross-table staleness above are
therefore unaudited on the partners side. Reported, not fixed.
