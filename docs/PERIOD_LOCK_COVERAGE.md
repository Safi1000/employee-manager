# Period lock: coverage audit, and two defects it found

Prompted by the standing rule that **a test asserting on a hand-listed subset of
a schema-defined set can only ever describe the bug it was written against.**
`period_lock.sql` protected eight payslip columns by name. `payslips` has
seventeen numeric columns.

**Nothing here is fixed.** Both defects are reported first, with magnitude, per
the standing instruction.

---

## 1. What was changed: the payslips column set is now derived

The suite now computes its protected set from `information_schema`:

```sql
c_permitted_numeric constant text[] := array['amount_paid'];   -- hand-maintained, and short
...
select array_agg(c.column_name order by c.column_name) into v_protected
  from information_schema.columns c
 where c.table_schema='public' and c.table_name='payslips'
   and c.data_type in ('numeric','integer','bigint','smallint','double precision','real')
   and c.is_generated = 'NEVER'
   and not (c.column_name = any (c_permitted_numeric));
```

The hand-maintained half is now the **permitted** list — short, and exactly what
0237 decided. A money column added to `payslips` next month joins the protected
set automatically instead of falling into neither list. The canary is derived
the same way: `array_length(v_protected, 1) + c_fixed_tests`, never a literal.

Generated columns are excluded because `UPDATE` on one raises "cannot update a
generated column" — not the period lock refusing, and a suite that only checked
that *something* raised would score it as a pass.

**Coverage went from 8 columns to 16. Result: 24/24.**

The eight that were previously unproven: `absent_days`, `allowance`,
`eobi_employer`, `leave_days`, `per_day_salary`, `present_days`,
`unmarked_days`, `working_days`. All are refused correctly — the lock was right,
nothing proved it. **`eobi_employer` is the one that matters for F4**: the
employer statutory share is a direct client cost feeding client Net Cash and
therefore partner remuneration.

### One test artifact fixed on the way

`per_day_salary` first reported FAIL. It is nullable, the fixture left it NULL,
and `per_day_salary + 1` is NULL — so the row did not actually change and
0237's carve-out correctly permitted a no-op. The mutation is now
`coalesce(%I, 0) + 1`. **A test whose mutation does nothing tests nothing**, and
it fails against code that is behaving properly, which is the worst kind of red.

---

## 2. DEFECT — the period lock does not protect `journal_lines`

**The GL that Phase 1 makes the source of truth is editable in a closed month.**

`enforce_period_lock` is attached to seven tables: `advances`, `cheques`,
`expenses`, `invoice_payments`, `invoices`, `journal_entries`, `payslips`.
**`journal_lines` is not one of them.** The lock guards the journal *header* and
not the amounts.

Demonstrated on dev against a real posted entry, with a control first:

```
CONTROL journal_entries UPDATE : refused ("Period for 2026-06-01 is closed…")
        journal_lines  UPDATE  : ACCEPTED
        journal_lines  DELETE  : ACCEPTED
```

The control matters: it proves the lock was live and the month genuinely closed,
so the two ACCEPTEDs are about `journal_lines` specifically.

The deferred balance constraint is not a backstop. It only catches an edit that
leaves an entry unbalanced. A **balanced restatement** passes both, verified
with `set constraints all immediate` so the answer is what a real COMMIT gives:

```
BALANCED RESTATEMENT of closed month 2026-06-01: ACCEPTED
entry debits 48,533.00 -> 49,533.00
```

+1,000 on one debit line and +1,000 on one credit line. Balanced, committed,
closed month, no refusal anywhere.

### Magnitude

**Zero rupees today, and unbounded the day Period Close runs.**
`accounting_periods` is empty on both prod and dev — no month has ever been
closed — so nothing has been protected yet and nothing has been restated. The
exposure begins at the first close, which is PRE_GO_LIVE item 1.

### Why it is not a one-line fix

`journal_lines` has no date column of its own; the lock resolves the period from
a configurable date column on each table it guards. Guarding lines means
resolving the period through `journal_entry_id -> journal_entries.entry_date`,
which is a different shape from every existing attachment. It also needs a
carve-out decision: `post_journal` and the repost paths insert lines into
entries they have just created, and reposting migrations legitimately rewrite
history under `app.ledger_maintenance`. Getting that wrong locks out the
posting engine.

---

## 3. DEFECT — four invoice columns ride along with a receipt into a closed month

The `invoices` carve-out permits an UPDATE when `amount_received` changed and a
**hand-listed five** are unchanged:

```sql
if old.amount_received     is distinct from     new.amount_received
   and old.invoice_amount  is not distinct from new.invoice_amount
   and old.invoice_date    is not distinct from new.invoice_date
   and old.client_id       is not distinct from new.client_id
   and old.withholding_tax is not distinct from new.withholding_tax
   and old.invoice_number  is not distinct from new.invoice_number
then return new;
```

`invoices` has eight numeric columns. Five are pinned; the rest are not
mentioned, so **changing them alongside a receipt is permitted**. Demonstrated,
control first:

```
CONTROL bare total_due edit (no receipt) : refused
subtotal            : ACCEPTED (100,000 -> 109,999)
total_due           : ACCEPTED (100,000 -> 109,999)
tax_withheld_total  : ACCEPTED (0 -> 9,999)
previous_balance    : ACCEPTED (0 -> 9,999)
tax_added_total     : refused
```

Same defect shape as the payslips carve-out that 0237 fixed: **an exclusion list
written by naming what must not change, rather than by naming what may.** The
payslips branch was rewritten to compare `to_jsonb(old) - c_payslip_open`
against `to_jsonb(new) - c_payslip_open` — permitted columns named explicitly,
everything else protected by construction. The invoices branch never got the
same treatment.

`tax_added_total` refusing is not yet explained and is not assumed to be a
second mechanism working correctly; it is simply not claimed either way.

### Magnitude

**Zero rupees today, same reason** — no period has ever been closed. It becomes
live at Period Close. `subtotal` and `total_due` are the invoice face and
`tax_withheld_total` feeds WHT receivable, so a restatement here moves both
revenue and the tax control account.

### The fix, when it is authorised

Rewrite the invoices branch the way 0237 rewrote payslips: an explicit
`c_invoice_open` array — `amount_received`, `status`, `updated_at` and whatever
else a receipt legitimately touches — and a jsonb difference for everything
else. That is a change to the finance path and needs the same
report-then-approve cycle 0237 had.

---

## 4. Coverage of the lock overall

The lock guards seven tables. The suite exercises four, and two of those on a
single path:

| table | covered |
|---|---|
| `payslips` | **fully** — 16 numeric columns, plus month-move and the disbursement carve-out |
| `journal_entries` | insert refused |
| `invoice_payments` | backdated insert refused, current-month insert allowed |
| `invoices` | `invoice_amount` refused, `amount_received` allowed — **1 of 8 numeric columns**, and §3 is what that gap was hiding |
| `advances` | **not tested at all** |
| `cheques` | **not tested at all** |
| `expenses` | **not tested at all** |
| `journal_lines` | not guarded at all — §2 |

`advances`, `cheques` and `expenses` all carry money and all reach the ledger.
None has ever had its lock exercised, on either environment. Extending the
derived-column-set treatment to them is the obvious next step and is the same
mechanical change made here.
MDEOF
