# Post-release work — outstanding, WHT, receivables, payroll custodian

Written 2026-09-02. Measured against `crm-design` (`mmkfpnshxjcyijhuydgr`) for
production facts and the repo working tree for code facts. **Nothing here has
been applied or changed.** Every figure names the database it came from, per
`TENANT_GUARD_REPORT.md` §9.16.

State at the time of writing: the frontend release is complete through `0284`.
`ledger_checks` returns 19 rows, canary 18/18, four accepted reds — all fixture
artefacts under the disposable-financial-data ruling. **`0268` remains deferred**
and is the last item here, because three of its eleven write paths still cannot
satisfy it and two of those paths are rewritten by items 2 and 4.

## Order

| # | item | why it sits here |
|---|---|---|
| **1** | The eight outstanding calculations | Alone, now. Not blocked by anything. |
| **2** | Receivables onto `record_invoice_payment` | Rewrite, not a patch. Changes a `0268` write path. |
| **3** | WHT removal, including `run_auto_invoices` | Depends on 2 — the receipt must capture WHT before invoices stop. |
| **4** | Payroll custodian + the carry-forward mode | Changes two more `0268` write paths. |
| **5** | `0268` | Last. Constrains what 2 and 4 rewrite. |

---

# 1. The eight outstanding calculations — do this first, alone

## The defect

The database computes outstanding **gross**. Four functions do it —
`cash_forecast`, `record_invoice_payment`, `run_auto_invoices`,
`write_off_receivable` — and **not one subtracts `withholding_tax`**.
`ar_control_equals_open_invoices` agrees, and passes.

The frontend computes it **net**, in eight places:

```
src/app/lib/supabase.ts:2033      invoiceOutstanding()   ← the helper
src/app/pages/super-admin/Accounting.tsx:1418, 1607, 2183, 3877, 3884
src/app/pages/super-admin/Invoices.tsx:970, 1149
```

```ts
// supabase.ts:2033 — and open-coded seven more times
return Number(inv.invoice_amount) - Number(inv.withholding_tax ?? 0) - Number(inv.amount_received);
```

**Every aging figure and receivables balance an operator reads is understated by
the withholding, and the ledger is right.** `0221` fixed the posting rule; the
screens were never brought along.

This is the defect diagnosed from the first screenshots of this project — two
report families disagreeing because each computes independently. It is 15.00 on
production today only because there is one fixture invoice carrying WHT. It
scales with real data, and it scales into the number the team collects against.

## The change

1. `invoiceOutstanding()` becomes `invoice_amount − amount_received`.
2. The seven open-coded copies are **deleted** and routed through it.

It stands entirely on its own merits and must not wait for the WHT decision:
even if invoice-time WHT stayed forever, subtracting it from outstanding would
still contradict the ledger.

## Can a check express it? — Honestly, no, and here is what can

**A `ledger_checks` entry cannot see this.** `ledger_checks` runs inside
Postgres; the divergence lives in TypeScript. The database has no visibility
into what the browser computed, so there is nothing for a SQL check to compare.
Saying otherwise would be inventing a control — the §9.6 failure this project
keeps finding in its own instruments.

Two things are genuinely available, and they are different in kind:

**(a) Prevention — remove the second implementation.** Expose outstanding from
the database and have the frontend read it rather than recompute it. Then there
is no second implementation to diverge, which is the same medicine as item 2 and
the reason that item exists. This is the real fix.

**(b) Detection — a repo-level lint.** A test that fails when `withholding_tax`
appears in the same expression as `amount_received` anywhere under `src/`. Crude,
but it is the thing that fires when someone writes the ninth copy, and the
eighth copy is exactly how the ninth gets written. Cheap, and it works today.

**Recommendation: (b) now, in this item, because it costs an hour. (a) as part
of item 2, because that item is already removing a parallel implementation.**

---

# 2. Receivables onto `record_invoice_payment` — a rewrite, not a patch

## What the screen actually is

`Accounting.tsx` — Banks & Ledgers → Client Receivables, the screen operators
use — **does not call `record_invoice_payment`.** It inserts into
`invoice_payments` directly, at `:1574` (standalone) and `:1654`
(invoice-linked), and at `:1654` it updates `invoices.amount_received` by hand.

**This is a second implementation of payment application**, which is the shape
this entire project has been removing. Bringing it across is not "add two fields
to a modal". What it currently skips:

| skipped | consequence |
|---|---|
| the oldest-first waterfall across open invoices | a payment lands on one invoice instead of settling the client's oldest debt first |
| the pro-rata WHT split per settlement | `invoice_payments.withholding_amount` is **never written** on this path |
| `assert_same_company` | no tenant guard on the write |
| the composed `bank_transactions` row | a different description and reference shape than every other receipt |
| `0281`'s client-rate default | `clients.withholding_tax_rate` is unreachable from the screen that needs it |

## The change

Replace both direct inserts with `supabase.rpc("record_invoice_payment", …)`,
passing `p_withholding` and `p_custodian_location_id`, and delete the hand-rolled
`invoices.amount_received` update — the RPC does it.

The custodian half already exists and is correct: a required selector at `:3950`,
a hard guard at `:1480`. **Only the WHT field is new to this modal.**

The standalone case (`:1574`, a payment with no invoice) needs a decision: the
RPC takes `p_invoice_id` and looks the company up from it. A payment with no
invoice has no invoice to look up. Either the RPC gains a client-only entry
point, or the screen keeps a direct insert for that case alone and it is
documented as the one exception. **Recommend the former** — the exception is how
the parallel implementation grows back.

## Also fixed here, while in the file

`resolvePaymentCustodianLoc()` returns `null` when the company id resolves to
null (`view_as_company ?? company_id ?? company?.id`). The `:1480` guard tests
only that a custodian was *selected*, not that it *resolved*. A user whose
company cannot be resolved therefore reaches a constraint instead of a message —
a raw Postgres error in a toast, where `0281` deliberately produced a legible
refusal.

**A validation that checks the input but not the resolution of that input.**
Low severity, one guard, same class as the message `0281` was careful about.

---

# 3. WHT removal — and `run_auto_invoices` is the one that gets missed

## The column and its four writers

`invoices.withholding_tax`. Related and **staying**: `clients.withholding_tax_rate`
(the agreed rate, wired by `0281`), `clients.auto_invoice_withholding`.

| writer | |
|---|---|
| `Invoices.tsx:509` | create |
| `Invoices.tsx:630` | edit |
| `InvoiceGenerate.tsx:496` | `withholding_tax: f.withheldTotal` |
| **`run_auto_invoices()`** | **a database function** — writes `coalesce(rec.auto_invoice_withholding, 0)` |

**A UI-only change is worse than no change.** It removes the field from the
screen and leaves the automated path stamping WHT onto every generated invoice —
a value nobody can see and nobody entered. This needs a migration, and it is the
piece most likely to be forgotten because it is not in any component.

## The change

1. Remove the input from `Invoices.tsx` create and edit, and from
   `InvoiceGenerate.tsx`.
2. **Migration:** `run_auto_invoices()` inserts `0`.
3. **Keep the column.** `invoicePdf.ts:42/65` prints it as an invoice line and
   some clients' invoices legitimately show a withholding line. Dropping it
   breaks the PDF for no gain. Stop writing it; let it read 0.
4. WHT is captured on the receipt, in the modal from item 2, prefilled from
   `clients.withholding_tax_rate` — which is what `0281` built it for.

## Existing data

| | invoices | non-zero WHT | total |
|---|---|---|---|
| production `crm-design` | 9 | **1** | **15.00** |
| dev `crm-design-dev` | 9 | 0 | 0 |

**Leave them.** One fixture row worth 15.00 on the company that gets cleared.
Backfilling it would be work on data that is going away. Stated rather than
assumed.

---

# 4. Payroll custodian, and the carry-forward mode

## 4a. Disbursement needs a custodian

```
payslips:  38 Bank   10 Cash
of the 10 Cash:  2 disbursed with a custodian (0263's backfill)
                 8 UNDISBURSED, no custodian     ← the exposure
```

Two writers cannot satisfy `0268`'s payslip constraint:

- **`disburse_payroll_run()`** sets `disbursed = true` and never sets a custodian.
- **`PayrollManagement.tsx:1239`**, the UI toggle — `custodian_location_id` does
  not appear anywhere in that file.

**Assign at disbursement, not retroactively.** The custodian is the person who
physically hands over the cash, and that is not known until it happens.
Pre-assigning stores a guess in a field whose entire purpose is attribution,
which is worse than a blank because it looks like a record. The 8 are a workflow
item, not a data-repair item.

What the UI needs — mirroring what `Accounting.tsx` already does correctly:

1. A custodian selector on the disbursement action, shown only for
   `payment_mode = 'Cash'`, populated from `cash_locations` with held balances
   (the pattern at `Accounting.tsx:3950`).
2. A hard guard before submit, refusing with a message rather than reaching the
   constraint.
3. `PayrollManagement.tsx:1239` to write `custodian_location_id`.
4. `disburse_payroll_run()` to accept a custodian — see the open question below.

## 4b. `syncOverpayAdvance` — the naming is the small half

`PayrollManagement.tsx:1015` inserts an `advances` row with
`payment_mode: "Cash"` hardcoded and no custodian, on every payroll save where
an employee is overpaid (`:1071`, `:1321`). No cash moves; it is a carry-forward
marker that nets against next month.

It is **the only synthetic row in the system carrying a payment mode it does not
mean.** Every other hardcoded literal (`Expenses.tsx:156/191/225`,
`Invoices.tsx:134`) is a form default the user then changes.

### Naming: `Carry-forward`, not `Payable`

Asked to choose, and the answer is not symmetry. `Payable` on `expenses` means
**we owe a vendor**. An overpaid employee owes **us**. Reusing the word would
import a term that means the opposite direction, in the one place whose whole
problem is a mode that describes a movement that did not happen. `Carry-forward`
says what the row is.

### The finding that makes this more than a rename

Renaming the mode is **not sufficient and is actively dangerous**, because the
posting resolver has a fall-through:

```sql
-- settlement_account()
select case
  when p_payment_mode = 'Cash'    then cash_account_for(...)
  when p_payment_mode = 'Cheque' and p_outgoing then coa_id('unpresented_cheques')
  else public.bank_account_gl(p_company_id, p_bank_account_id)   -- ← everything else
end;
```

A carry-forward advance has `bank_account_id = NULL`. Measured on production:

```sql
settlement_account(SANDBOX, 'Payable', null, null, true)  →  1010 Bank Accounts
```

**It resolves to the bank control account.** So a carry-forward under any new
mode would post a credit to the bank control for money that never moved —
silently corrupting `bank_control_equals_bank_accounts`, which is already one of
the four reds and would absorb it without anyone noticing.

This is the project's recurring shape again: the change produces a **plausible
posting rather than an error**, which is the expensive kind.

So 4b is three pieces, not one:

1. Add `Carry-forward` to the `advances.payment_mode` CHECK.
2. **Teach `settlement_account()` the mode, or exempt the row from posting.**
   Which one is a policy question — see below.
3. Change `syncOverpayAdvance` to write it.

### The accounting question underneath, for Shayan

Should a carry-forward advance post **at all**? The overpayment is already in
the ledger: the payroll disbursement moved the cash and posted it. A second
posting for the same money would double-count it. The likely correct answer is
that `journal_on_advance` should skip carry-forward rows entirely, rather than
`settlement_account()` learning a fourth destination.

**Not deciding this.** It is a posting rule, policy lives in
`LEDGER_PHASE1_POSTING_RULES.md`, and a plausible-looking default becomes
precedent the moment it posts.

**Production exposure is zero** — one advance, `payment_mode = 'Bank'`, no
carry-forwards. This path has never fired on production.

## The open question for Shayan — one custodian per run, or per payslip?

`disburse_payroll_run()` disburses a whole run at once. Both shapes are viable
and they cost differently. **Not picking.**

| | **One custodian for the run** | **Per-payslip mapping** |
|---|---|---|
| signature | `disburse_payroll_run(p_run_id, p_custodian_location_id)` | `disburse_payroll_run(p_run_id, p_map jsonb)` |
| UI | one selector on the disburse action | a column in the payslip table, set per row before disbursing |
| effort | small — one parameter, one selector, one guard | substantial — a per-row editor, partial-completion state, a "who is missing" view |
| truthful when | one person draws the cash and hands it out | several people disburse, by branch or by site |
| failure mode | attributes everything to one custodian; the custody balance is wrong per person but right in total | none, if operators actually fill it in — and a blank blocks the whole run |
| mixed runs | cannot express them | handles them natively |
| reversible later | yes — a per-payslip map can be added over it | — |

**The deciding fact is operational, not technical: does one person hand over all
the cash for a run, or several?** If the answer is "usually one, occasionally
several", the run-level parameter with a per-payslip override is the shape that
fits, and it can start as run-level only.

---

# 5. `0268` — last

Applied only once items 2 and 4 have landed and every write path can satisfy it.

Its data has always been clean and always would have been: **0 violating rows on
all four tables** (`expenses`, `invoice_payments`, `advances`, `payslips` — not
`cash_deposits` or `custody_transfers`). The pre-flight is not a data query. It
is:

1. A cash receipt through the receivables screen, post-item-2, storing a
   `custodian_location_id`.
2. A payroll disbursement, post-item-4, storing one on the payslip.
3. A payroll save that produces a carry-forward advance, storing the new mode.

All three exercised through the UI, logged in. `TENANT_GUARD_REPORT.md` §9.17
records why: the constraint has to be proved against what it accepts, against
the writers, and against the rows those writers are about to move.
