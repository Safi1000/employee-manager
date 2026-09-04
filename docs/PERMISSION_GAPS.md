# Permission gaps — open findings

Ordered by consequence. **A gap that crosses regions ranks above one that
half-completes an action**, because the first is a confidentiality and
attribution failure and the second is a mess someone notices.

Nothing in this file has been fixed. Each entry says what is reachable today,
measured, not inferred.

---

## 1. The four SECURITY DEFINER RPCs do not scope the branch

**Status: reported, not built.** Same class as the tenant-guard work and it
deserves the same care.

All four are `SECURITY DEFINER`. A definer body is **not subject to the
caller's RLS policies**, so every policy on every table they touch — including
`branch_scope` — is off for the duration of the call. All four scope the
*tenant*; **none of them scopes the branch**, and none so much as mentions
`current_branch_id()`.

That matters because the regional model assumes a user tied to ISB/RWP sees and
touches only ISB/RWP, and that assumption has been tested at the screen level.
These four sit underneath the screens.

`branch_scope` exists on twelve tables: `advances`, `attendance_records`,
`clients`, `employee_branches`, `employee_documents`, `employees`, `expenses`,
`inventory_items`, `invoice_payments`, `invoices`, `issuances`, `payslips`.
Only writes that land on one of those twelve can escalate across regions.

### What a branched user can actually reach through each

| RPC | Writes | Crosses regions? |
|---|---|---|
| **`record_invoice_payment`** | `invoice_payments`, `invoices`, `bank_accounts`, `treasury`, `bank_transactions` | **YES — the serious one.** Both `invoices` and `invoice_payments` carry `branch_scope`. A user tied to ISB/RWP can pay **any** invoice in the company, including Lahore's and Kashmir Branch's, and the payment row lands under that region. They cannot *see* the invoice on any screen; they only need its id. |
| **`post_manual_journal`** | `journal_entries` / `journal_lines` via `post_journal` | **YES, by attribution.** It takes `p_branch_id` and validates only that the branch belongs to the same *company* — the guard is `assert_same_company((select company_id from branches where id = p_branch_id))`. A branched user can therefore stamp a manual journal with **another region's** `branch_id`, which lands in that region's P&L and in `regional_pl_range`. |
| **`record_cash_deposit`** | `treasury`, `bank_accounts`, `cash_deposits`, `bank_transactions`, `audit_log` | **No.** None of those tables carries `branch_scope`. Company cash and company bank accounts are company-scoped by design, and a branched user reaches them through ordinary RLS anyway. |
| **`record_bank_to_custodian`** | `bank_accounts`, `treasury`, `bank_transactions` | **No**, same reason. |

**So the finding is two of four, not four of four**, and saying so matters:
fixing the two that cannot escalate would be motion without a defect behind it,
and would make the two that can look like part of a routine sweep.

### Does the extracted-predicate approach fix all four at once?

**No — and that is the useful part of the answer.**

A `can_write_expense_row(...)`-style predicate, consumed by both the RLS policy
and the RPC, solves the problem for **one table**: the predicate states the rule
once and both consumers read it. Extending that here would need a predicate per
table — `can_write_invoice_row`, `can_write_invoice_payment_row`,
`can_stamp_branch` — because the rule differs per table. `expenses`'
`branch_scope` has a clause for a NULL branch that falls back to the client's
branch; `invoices`' does not.

Three shapes are available, in increasing order of how much they change:

1. **A branch assertion per RPC**, mirroring `assert_same_company`. Small,
   local, and it restates each table's rule in a second place — the shape this
   project has spent two days removing. Cheapest to write, worst to keep.

2. **`assert_branch_writable(p_branch_id)`**, one helper, called by each RPC
   before it writes anything branch-scoped. One definition, four call sites,
   and it handles `post_manual_journal` exactly. It does **not** handle
   `record_invoice_payment`, whose branch is not a parameter but a property of
   the invoice it was handed — that one needs the branch **resolved from the
   row**, which is the `[resolved]` shape the tenant guards already use.

3. **Make them `SECURITY INVOKER`**, as 0364 did for `record_expense`. Then
   `branch_scope` applies by itself and there is nothing to restate. This is the
   right end state and the largest change: each RPC has to be re-checked write
   by write for what the caller can actually do, and at least
   `record_invoice_payment` is likely to need a permission it does not currently
   require of the user.

**Recommendation: (3) for `record_invoice_payment`, (2) for
`post_manual_journal`, nothing for the other two.** They are different defects
and a single sweep would disguise that.

### Is it exploitable on GGS today? No — and that is a timing fact, not a defence

Measured on production, GGS profiles:

| Role | Users | `accounting.edit` | `invoices.edit` | Branched |
|---|---|---|---|---|
| accounting | 1 | 1 | 1 | 0 |
| hr | 5 | 0 | 0 | **2** |
| super_admin | 1 | implicit | implicit | 0 |
| super_super_admin | 1 | implicit | implicit | 0 |

`record_invoice_payment` opens with `require_perm('invoices.edit')`. **The two
branched users are `hr` and hold neither key**, so they cannot call it at all.
Nobody is standing in the hole.

It becomes live the moment Shayan gives a regional user `invoices.edit` — which
is exactly what the regional model implies he will do. Fix it before that, not
after.

### What switching `record_invoice_payment` to INVOKER actually changes

Read write-by-write against the live policies. **It is correct, and it is not a
drop-in.**

| Write | Under DEFINER | Under INVOKER |
|---|---|---|
| `invoice_payments` INSERT | unfiltered | needs `invoices.edit` — **already required** by `require_perm`, no change |
| `invoices` UPDATE | unfiltered | needs `invoices.edit` + `branch_scope` — **this is the fix** |
| the oldest-first loop reading `invoices` | sees every region | sees only the caller's — **allocation changes for a branched caller** |
| `bank_accounts` UPDATE | unfiltered | **needs `accounting.edit`** |
| `treasury` UPDATE | unfiltered | no permission policy, no change |
| `bank_transactions` INSERT (`kind='receipt'`) | unfiltered | **needs `accounting.edit`** — the `expenses.edit` carve-out is only for `kind='expense'` with a null bank account |

**Two consequences worth deciding before applying:**

1. **An `invoices.edit`-only operator would be refused on both Cash and Bank**,
   because the bank/treasury write and the receipt row both want
   `accounting.edit`. On GGS today the only such operator holds both keys, so
   nothing breaks — but that is luck, not design. The choice is to grant
   `accounting.edit` to whoever records receipts, or to widen the
   `bank_transactions` policy to admit `invoices.edit` for `kind='receipt'`.
   **That is a policy decision and it is Shayan's, not a code detail.**

2. **The oldest-first allocation changes for a branched caller.** Today a
   payment settles the client's oldest open invoices across all regions. Under
   invoker it settles only those the caller can see. That is almost certainly
   the intent — but it is a change in *where money lands*, not just in who may
   act, and it should be said out loud rather than discovered.

### Also worth knowing

`is_branched_user()` and `current_branch_id()` are the predicates; both are
already used by the twelve policies, so no new concept is needed. And the
existing tenant-guard detector (`tenant_guard_gaps()`) does **not** look for
branch guards at all — a branch-guard detector of the same shape is the thing
that would keep this closed once it is fixed, rather than fixed once.

---

## 2. Cross-key follow-ups — one reconciled list

Two lists were being kept: the agreed cross-key seven, and the five sibling
flows found while building `record_expense`. They overlap. **One table.**

"Cross-key" = a single user action whose writes need **two different permission
keys**, performed as separate round trips with no transaction around them. Half
the action commits and half refuses, and the operator is told about the second
half.

| Flow | Where | Keys | Non-atomic money | Status |
|---|---|---|---|---|
| `handleAdd` | Expenses.tsx | `expenses.edit` + `accounting.edit` | yes | **CLOSED** by `record_expense` (0364) |
| `handleDecision` | Expenses.tsx:941 | `expenses.edit` + `accounting.edit` | yes | **CLOSED** by `record_expense` (0364) |
| `handleEdit` | Expenses.tsx:1457 | `expenses.edit` + `accounting.edit` | yes | open |
| `reverseExistingPayment` | Expenses.tsx:1411 | `expenses.edit` + `accounting.edit` | yes | open — reached from `handleEdit` and `handleDelete` |
| `handleAddAdvance` | Expenses.tsx:1733 | *none* + `accounting.edit` | yes | open |
| `reverseAdvancePayment` | Expenses.tsx:1830 | *none* + `accounting.edit` | yes | open |
| `handleEditAdvance` | Expenses.tsx:1856 | *none* + `accounting.edit` | yes | open |
| `handleMarkPaid` | Accounting.tsx:1349 | `expenses.edit` + `accounting.edit` | yes | open |
| `handleRevertToPending` | Accounting.tsx:1434 | `expenses.edit` + `accounting.edit` | yes | open |
| `handleEditPayment` | Invoices.tsx:876 | `invoices.edit` + `accounting.edit` | yes | open |
| `nextStage` | ComplianceCases.tsx:58 | `compliance.edit` + `compliance.filings` | **no** | open |

**Reconciliation notes, each of which changes the agreed list:**

- **`handleDecision` is closed too**, not just `handleAdd`. Converting the Add
  form and the fixed-expense approval was one change, because both build the
  same expense; the agreed list had them as separate items.
- **`reverseExistingPayment` was on neither list under that name.** It is the
  shared helper behind expense delete *and* expense edit — the "five sibling
  flows" counted those as two entries when they are one function with two
  callers. Fixing it fixes both.
- **The three advance flows are cross-key in one direction only.** `advances`
  carries no `perm_write_*` policy at all — only `company_members` and
  `branch_scope` — so any company member can write an advance, and the second
  key (`accounting.edit`, for the bank balance) is the only one in play. That
  is a finding in its own right: **an advance needs no permission to create.**
- **`nextStage` is the odd one and stays odd.** It is the only entry whose
  second write is not money, and the only one where the surviving half is a
  *false record* rather than a missing one: a case worker without
  `compliance.filings` advances the case and fails to record the filing, so the
  record says filed when it was not. Everything else leaves money unmoved, which
  is visible in a reconciliation. This is not.

**Shape of the fix.** Nine open flows, and they do not all want the same thing.
The six that move money want `record_expense`'s treatment — an invoker RPC per
flow, row-count-asserted balance writes, one transaction. `nextStage` wants
something else entirely, because there is no balance to assert: it wants the
case advance and the filing row in one statement, or the advance refused.

---

## 3. Branch guard detector — first run

`branch_guard_gaps()` shipped in 0365 and is **deliberately not wired into
`ledger_checks`** until this list is classified. Its first run returns **47
rows across 44 functions**, which is why.

| Shape | Kind | Functions | Verdict |
|---|---|---|---|
| `writes` | trigger | 8 | **Exempt.** A trigger fires as a consequence of a write RLS already vetted, and is not directly callable. A branch assertion here would be wrong. |
| `writes` | volatile | 23 | Mixed — see below |
| `stamps` | reader (stable) | 9 | **Different, lesser defect.** These read a region they were handed. A branched user learns another region's numbers; nothing is written. |
| `stamps` | volatile | 4 | `post_manual_journal`, `generate_bonus_pool`, `raise_alert`, `request_approval` |

**Two refinements the first run earned, and neither is guesswork:**

1. **Exclude trigger functions** (`prorettype = 'trigger'`). Eight of the 47
   vanish and none of them was ever an attack surface.
2. **Split arm B by volatility.** It was written for functions that *stamp* a
   branch onto a row, and it is catching nine pure readers as well. Those are a
   real but lesser gap — read escalation, not write — and folding them into one
   number hides the difference.

Of the 23 volatile writers, most are employee-lifecycle functions
(`archive_employee`, `record_separation`, `transition_employee_lifecycle`,
`set_employee_salary`, …) that write `employees`, which carries `branch_scope`.
**That is a real hole and a larger one than the RPCs** — a branched HR user can
plausibly reach another region's employee record through any of them — but it is
its own investigation, not a footnote to this one. `run_auto_invoices`,
`disburse_payroll_run` and `payroll_run_attach` are company-wide jobs and are
correct to have no branch assertion; they need exempting by name.

**Do not wire this into `ledger_checks` until the 23 are classified.** A check
that is red on day one with 47 rows teaches people to ignore reds, which is the
failure this project exists to remove.

