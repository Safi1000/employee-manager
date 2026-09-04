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

### Also worth knowing

`is_branched_user()` and `current_branch_id()` are the predicates; both are
already used by the twelve policies, so no new concept is needed. And the
existing tenant-guard detector (`tenant_guard_gaps()`) does **not** look for
branch guards at all — a branch-guard detector of the same shape is the thing
that would keep this closed once it is fixed, rather than fixed once.

---

## 2. Cross-key follow-ups

**Not transcribed.** These were enumerated in a round that is not in this
session's context, so listing them here from memory would risk a list that
quietly differs from the agreed one. They belong directly below finding 1, in
the order they were given. Paste them in and they slot straight in here.

What is known and belongs with them: `record_expense` (0364) closed the expense
**creation** path, both call sites. The same non-atomic, read-modify-write,
silent-zero-row-UPDATE shape remains on **five** other flows in
`Expenses.tsx`, all still going through `applyCashDelta` / `applyBankDelta` /
`logExpenseTransaction`:

- expense **reversal / delete** (both the paid and unpaid arms)
- expense **edit** when the amount or the payment mode changes
- **advance** creation
- **advance** repayment
- **advance** edit

These were deliberately left: 0364's brief was the creation path, and each of
the others needs its own RPC with its own thinking about what "reverse" means
when the balance has moved since. They are not worse than they were — but they
are no better, and the creation path being fixed makes them easier to forget.
