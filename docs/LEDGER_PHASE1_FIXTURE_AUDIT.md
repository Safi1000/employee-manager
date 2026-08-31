# Fixture audit — does each fixture create state the application can produce?

Triggered by the period-split fixture writing `payment_mode = 'Bank'` with a NULL
bank account, which `record_invoice_payment` rejects outright. That fixture
asserted against a row production cannot create — a green test on an impossible
path. This audit applies the same question to every write in the test suite.

**Result: 5 of 7 fixture writes fail. Plus two suite-level breakages that mean
`ledger_foundation.sql` has not actually run since 0224.**

The test is not "did an RPC exist and get skipped" — for advances, payslips and
invoices the application itself writes the table directly, so a direct INSERT is
the right shape. The test is **completeness**: does the fixture write the
columns and companion rows the application always writes alongside?

---

## Suite-level: `ledger_foundation.sql` is dead

**S1 — T9 calls a function that no longer exists.**

```sql
select public.is_ledger_maintenance() into v_ok;   -- T9
```

0224 line 77: `drop function if exists public.is_ledger_maintenance();`
(renamed to `is_maintenance_session()`). Confirmed against the live database:
`pg_proc` count for `is_ledger_maintenance` = **0**.

T9 is **not** wrapped in a `begin … exception` block, so the call raises
`undefined_function` and aborts the entire `DO` block. **T10, T11, T12, T13,
T14, T15 and T16 have not executed since 0224 applied.** The suite still
"reports" — as a rollback exception — but it reports a truncated result nobody
reads to the bottom of.

This is the third instance of the same class: a test that appears to run and
does not test what its name says.

**S2 — T4 and T16 assert on a condition that is now deliberately false.**

```sql
select count(*) into v_failed
  from public.companies c cross join lateral public.ledger_checks(c.id) k
 where not k.passed;                                   -- expects 0
```

Live count: **2**. Both are intentional and documented —
`no_billing_clients_on_head_office` (Ironclad, 1) and
`no_gate_mode_in_attendance_status` (Aamir Shabbir, 24). T4 and T16 are
therefore permanently red *by design*, which is the state that trains a reader
to skip the line. The assertion should compare the **set of failing check
names** against an expected-red allowlist, and fail on anything outside it —
including on a check that stops being red without the allowlist being updated.

---

## Fixture-by-fixture

| # | Where | Verdict |
|---|---|---|
| F1 | `ledger_foundation` T3 — direct `journal_entries` + `journal_lines` insert | **PASS** |
| F2 | `ledger_foundation` T11/T12 — `advances` insert | **FAIL** |
| F3 | `ledger_foundation` T13 — `payslips` insert | **FAIL** |
| F4 | `ledger_foundation` T15 — payslip disbursement | **FAIL** |
| F5 | `attendance_status` T27/T31 — attendance update under `skip_attendance_lock` | **PASS (declared)** |
| F6 | `fixtures_period_split` A/B — invoice inserts | **FAIL** |
| F7 | `fixtures_period_split` C — September receipt | **FAIL in sandbox, fixed in file** |

### F1 — PASS

T3 constructs an unbalanced entry deliberately, to prove the deferred constraint
refuses it, and asserts on the refusal. Constructing an impossible shape is
legitimate when the *assertion is that it is impossible*. It leaves no state.
The distinction from F7 is exactly this: F7 constructed an impossible shape and
then asserted on the resulting data as if it were real.

### F2 — `advances` insert, FAIL

```sql
insert into public.advances (company_id, employee_id, amount, advance_date, payment_mode)
  values (v_co, v_emp, 1234, current_date, 'Bank');
```

Application path — `Expenses.tsx:1615` — always writes, for Bank mode:

- `bank_account_id` (non-null; Cheque mode derives it from the cheque's bank)
- `cheque_id`, `custodian_location_id`, `client_id`, `notes`
- then `applyCashDelta` / `logAdvanceTransaction`: a `bank_transactions` row and
  a `bank_accounts.balance` (or `treasury.cash_balance`) movement

The fixture writes a Bank-mode advance with **no bank account and no cash
movement**. The column is nullable, so nothing complains. Same defect shape as
F7, in a test that has been in the suite longer.

T12 asserts the journal line carries its `employee_id` dimension — which is
true, and would remain true on a correctly-shaped advance. The assertion is
sound; the state it runs against is not reachable.

### F3 — `payslips` insert, FAIL

```sql
insert into public.payslips (..., disbursed, payment_mode)
values (..., false, 'Bank');
```

`PayrollManagement.tsx` writes `amount_paid`, `status`, `bank_account_id`,
`cheque_id` and `updated_at` on every payslip write. A Bank-mode payslip with no
bank account is, again, unreachable.

Undisbursed with `amount_paid` absent is *nearly* reachable (a generated,
unpaid payslip) — this one is the mildest of the three.

### F4 — payslip disbursement, FAIL (the sharpest of the three)

```sql
update public.payslips set disbursed = true, disbursed_at = now() where id = v_e;
```

The application never sets `disbursed` directly. `PayrollManagement.tsx:1229`
derives it:

```ts
const newDisbursed = target > 0 && target >= net;
```

and writes it in one claim together with `amount_paid = target`,
`status = 'Cleared'`, `payment_mode`, `bank_account_id` — then moves the money
(`bank_accounts.balance` or `treasury.cash_balance`) and inserts a
`bank_transactions` row of kind `payroll`.

The fixture produces `disbursed = true` with `amount_paid = 0`, `status`
unchanged, no bank account, no cash movement and no bank transaction. **The
application cannot reach that row by any path**, and the code comment at
`PayrollManagement.tsx:1233` exists specifically to say why the claim and the
money move are inseparable.

T15 asserts a disbursement journal entry was posted. It is asserting that the
ledger reacts correctly to a state the ledger will never be shown.

### F5 — PASS (declared)

T27/T31 set `app.skip_attendance_lock = '1'` to get past the backdate gate. This
is a bypass, but a *declared* one: the header says so, the row is chosen to
satisfy every other gate, and the assertion is on the exception's message text
(`v_msg like '%gate refusal%'`) rather than on the mere fact that something
raised. That message assertion is what makes it honest — it was added after the
trigger-ordering false pass, and it is the pattern the other fixtures need.

### F6 — invoice inserts, FAIL

```sql
insert into public.invoices
  (company_id, client_id, invoice_number, invoice_date, period_start, period_end,
   invoice_amount, subtotal, total_due, status, branch_id)
```

`InvoiceGenerate.tsx:490` always writes, additionally:

`contract_id`, `withholding_tax`, `amount_received`, `tax_added_total`,
`tax_withheld_total`, `previous_balance`, `amount_in_words`, `remit_account`,
`financial_year`, `invoice_group`, `variable_grid`, `generated: true` — plus
`invoice_lines` **and `invoice_taxes`**.

Confirmed live: both `FIX-SEP-%` invoices have **`contract_id` NULL**.

`contract_id` is the one that matters. Migration 0113 added
`uq_invoice_contract_month` — one invoice per contract per month. A fixture
invoice with a NULL `contract_id` **sits outside that constraint entirely**, so
it can never collide, and any report that reaches invoices through a contract
join will not see it. For F4's waterfall work — which is about invoices reaching
the right region and the right partner — an invoice with no contract is exactly
the kind of row that silently drops out of the middle of a join chain.

`generated`, `financial_year` and `invoice_group` are each plausible filter
columns for a report that has not been written yet.

### F7 — September receipt

Documented in full in the fixture header. Four divergences; the file is
corrected, **the sandbox still holds the divergent row**. See the correction
script below.

One consequence not previously stated: because the divergent row says
`payment_mode = 'Bank'`, `trg_yyy_payments_journal` posted the receipt to
**`bank`**:

```
bank  Dr 150,000.00
ar    Cr 150,000.00   (client dimension set)
```

No `bank_accounts.balance` moved and no `bank_transactions` row exists, so the
sandbox ledger currently claims 150,000 of bank money that the operational
tables have no record of. The AR side is fine, which is why `ledger_checks`
stays green — the AR control reconciles against `invoice_payments`, and the
bank side has no control account check to catch it.

**That gap is itself a finding: there is no reconciliation check tying the
`bank` control account to `bank_accounts.balance` + `bank_transactions`.** Had
one existed, this fixture would have been caught by the harness rather than by
reading the RPC.

---

## Rule going forward

1. Where an RPC exists for an operation, **call it**. Do not reproduce it.
2. Where the application writes the table directly, the fixture must write
   **every column and every companion row** the application writes — not just
   the ones the assertion reads.
3. Where neither is possible — an RPC requiring an authorised app session, a
   gate that must be bypassed — say so **in the fixture header**, name the
   divergence precisely, and treat that fixture's coverage as **partial by
   declaration**.
4. A test asserting on a *refusal* may construct an impossible shape (F1, F5),
   provided it asserts on the refusal's **message**, not merely on the fact
   that something raised.

## The general finding

An RPC that cannot be exercised outside an authorised application session cannot
be tested by anything except the application. `record_invoice_payment` compares
`current_company_id()` to the invoice's company and raises *"Not authorised for
this company"*, so no maintenance session, no `psql`, and no CI job can call it.
Every test of it is therefore a test of somebody's model of it.

The fix is not to weaken the check. It is for such functions to take the acting
company as an explicit argument, and to derive authorisation from a check that a
service-role session can satisfy — so the RPC has one code path and the test
exercises the same one production does.
