# The read/write sweep — columns wired at one end only

Report only. Nothing changed on the strength of this.

The `cash_location_id` defect had a mechanically checkable shape: **read by
database code, written by no application code, NULL on every row.** Every reader
was internally consistent and every writer was internally consistent; only the
join between them was wrong, which is why no test caught it and why it cost
595,990.13. This sweep runs that shape across the schema, and its inverse.

Environment: `crm-design-dev`. `ANALYZE` run first so `pg_stats.null_frac` is
current.

---

## Direction 1 — read by code, written by nobody

Method, in three filters:

1. `pg_stats.null_frac = 1` — the column is NULL on every row.
2. The column name appears in at least one `public` function body.
3. `grep -rn <name> src/` returns nothing — the frontend never writes or reads it.

Filters 1 and 2 alone return **86 columns**, which is noise: `fn_reads` counts
any function *mentioning* the name, so common names like `client_id` score 66
because 66 functions mention some table's `client_id`. Filter 3 is what made
`cash_location_id` conclusive, and it cuts 86 to **14**.

Of those 14, eight are written by database code rather than the frontend, which
is legitimate — they are derived or system-set:

| column | written by |
|---|---|
| `ai_credit_ledger.ai_usage_id` | `ai_credit_spend` |
| `ai_credit_ledger.stripe_reference` | `ai_credit_topup` |
| `ai_credit_ledger.topup_after` | `ai_credit_topup`, `ai_credit_spend` |
| `journal_lines.cost_center` | `post_journal`, `reverse_journal_for_source` |
| `payslips.payroll_run_id` | `payroll_run_attach`, `disburse_payroll_run`, +3 |
| `employees.last_appraisal_rating` | `transition_appraisal`, `generate_bonus_pool` |
| `employees.last_appraisal_year` | `run_appreciation` |
| `attendance_records.swap_partner_id` | `sync_attendance_0188` |

All-NULL for these means the feature has not been exercised in the sandbox, not
that it is broken.

### The six that resemble `cash_location_id`

Read by database code, written by **neither** the frontend nor any function, NULL
on every row. All six are on `employees`:

| column | functions reading it |
|---|---|
| `cash_payment_approved_by` | 1 |
| `final_pay` | 1 |
| `pay_fixed_on_probation` | 1 |
| `performance_enrolled_by` | 1 |
| `performance_enrolled_on` | 2 |
| `probation_period_months` | 1 |

**These are candidates, not findings.** The writer detection is a regular
expression over `prosrc` looking for `set <col>`, `<col> = new/v_/p_` and
`insert into … <col>`; it will miss a dynamic `EXECUTE format(...)`, a column
written via `to_jsonb`/`jsonb_populate_record`, or a bulk `insert … select`.
`performance_enrolled_on` in particular has a plausible writer in
`set_performance_enrollment` that the regex did not match, so at least one of the
six is likely a false positive.

Two of them are worth a look regardless of the sweep's precision, because of what
they gate:

- **`employees.cash_payment_approved_by`** — a name that reads like an
  authorisation control on paying an employee in cash. If something checks it and
  nothing sets it, the control is either always-open or always-closed, and either
  way it is not doing what its name says.
- **`employees.final_pay`** — settlement money. `release_final_dues` exists; if it
  does not in fact write this column, final settlement figures live somewhere
  else and this one is a decoy.

Each needs reading individually before any conclusion. That is a separate item.

---

## Direction 2 — written by the app, read by nobody

Not yet run. It needs a different method: `null_frac` cannot find it (the column
is populated, which is the point), so it requires enumerating columns the
frontend writes and testing each for any reader in SQL, views, RPC return
signatures or the frontend itself.

Worth doing, and the reason is worth stating plainly: this is where **a value
someone believes is being used quietly is not**. Somebody fills in a field every
day, and nothing anywhere consumes it. That is a different and more human kind of
defect than direction 1 — direction 1 wastes the machine's time, direction 2
wastes a person's, and only one of them is visible to the person doing it.

---

## The sweep's limits, stated so nobody over-trusts it

- **`null_frac` is a sandbox fact, not a code fact.** A column can be correctly
  wired and still be all-NULL because nobody used the feature. That is why
  direction 1 needs the frontend filter, and why every survivor still needs
  reading.
- **Name matching is not reference analysis.** `prosrc ~ '\ycol\y'` cannot tell
  `expenses.client_id` from `invoices.client_id`. A real version would parse
  dependencies rather than grep text.
- **It cannot see reads that happen outside the database and the repo** — a
  report built in a spreadsheet, an export someone wrote once.
- **It will not find the next `cash_location_id` if that column happens to be
  populated.** The three filters agreed here because the column was never written
  at all; a column written *sometimes* and read *wrongly* is invisible to all
  three.

The value is not that the sweep is complete. It is that this particular defect
shape is now checkable at all, and it took a query rather than an accident to
find it the second time.

---

# Direction 1, resolved: the two columns worth reading

Read individually, as required. **Both hypotheses in the section above were
wrong, and the truth is worse in one respect and better in another.**

`employees.cash_payment_approved_by` and `employees.final_pay` are read by
exactly **one** function, `guard_completeness(p_employee_id)`, and by nothing
else — no other function, no view, no frontend.

```
  -- Tier 3 — Payable
  t3 := t2
    and ( (e.account_title is not null and ... and e.iban is not null)
          or (e.cash_payment_flag and e.cash_payment_approved_by is not null) )
    and e.probation_period_months is not null
    and e.pay_fixed_on_probation  is not null
    and e.final_pay               is not null
    ...
```

**`cash_payment_approved_by` is not an authorisation control.** Nothing consults
it before paying anyone in cash; no trigger, no RPC, no RLS policy. It is one
clause of a completeness *score*. The sweep guessed "always-open or
always-closed" — that framing presumes an enforcement point, and there is none.

**`final_pay` is worse, and structurally.** It appears as an unconditional `and`
in Tier 3. Nothing writes it, so Tier 3 is unreachable for **every** employee,
cash-paid or bank-paid — and Tier 4, which is `t3 and ...`, with it. The same is
true of `probation_period_months` and `pay_fixed_on_probation`, two more of the
six. Three unwritten columns in one conjunction make two of the four tiers dead.

Measured rather than reasoned: `guard_completeness` returns `highest = 0` for
**all 69 employees** in the sandbox. Not tier 3 — tier *zero*.

And the function itself is called by nothing. The only mention of it in `src/`
is a comment:

```
src/app/pages/super-admin/EmployeeManagement.tsx:847
  // Phase 3: tabbed record. The guard_completeness tiers that used to sit above
```

So the honest finding is not "an authorisation control that nothing sets". It is
**a scoring function that nothing calls, which scores everyone zero, and whose
zero is caused by columns nothing writes.** The six columns are its inputs. They
are dead because it is dead.

That does not make them safe to drop: if the tiers are meant to come back, the
columns are the specification of what "Payable" means. The decision is a
product one — revive `guard_completeness` and fill its inputs, or delete both
and stop implying a gate exists. Not decided here.

---

# Direction 2 — written by the app, read by nothing

Scoped as instructed to **money, authorisation and status** columns, not the
whole schema. A value someone believes is enforced and is not is worth a
person's time; a stale display field generally is not.

Method: every column whose name matches a money / authorisation / status
pattern, tested for readers in `pg_proc.prosrc`, in view definitions, and in
`src/`. 35 columns have **zero** database readers. Filtering those to ones the
frontend actually writes leaves four worth naming.

## Worth a person's time

**`clients.withholding_tax_rate`** — written by `Clients.tsx:406`, derived from
the client's `tax_profile`, and displayed back at `Clients.tsx:1443`. **No
database function or view reads it.** Withholding is captured per receipt as
`invoice_payments.withholding_amount` (policy A1: the deduction is only known
when the client pays). So the rate is maintained, shown, and consumed by nothing
— the exact shape direction 2 exists to find. Anyone setting it expecting
withholding to follow is mistaken, and nothing tells them.

**`treasury.cash_opening_balance`** — written and read only by
`Accounting.tsx`. No database reader. There are now **two** opening-balance
concepts for cash, and the ledger uses the other one:
`custodian_held_operational()` opens from `cash_locations.opening_balance`.
Setting the treasury figure expecting the ledger to move will not move it.

**`partners.opening_balance_locked`** — written and enforced entirely in
`Partners.tsx` (it disables the input). No trigger, no constraint, no policy. A
lock that exists only in the UI is not a lock; the same pattern as the contract
edit permission, which is documented as UI-only. Worth deciding whether it
should be enforced, because its name promises that it is.

## Read by the PDF only, and correctly so

**`invoices.tax_withheld_total`** — written by `InvoiceGenerate.tsx:504`, read
by `invoicePdf.ts:199`. Not a finding: it is a document field. Worth recording
that no ledger path reads it, which is consistent with A1 rather than in
conflict with it.

## Neither written nor read anywhere

`guard_documents.waiver_approved_by`, `incidents.corrective_action_status` and
`employees.group_insurance_status` have zero references in functions, views and
`src/` alike. These are direction-1 cases the first pass missed because they are
not all-NULL for the reason it filtered on.

## What this sweep still cannot see

The same limits as direction 1, plus one specific to it: a column read by a
report someone built outside the repo — a spreadsheet, a one-off export — is
indistinguishable from a column read by nobody. Direction 2 can prove a column
has no reader *in this system*; it cannot prove it has no reader.
