# Permission gaps — open findings

Ordered by consequence. **A gap that crosses regions ranks above one that
half-completes an action**, because the first is a confidentiality and
attribution failure and the second is a mess someone notices.

Nothing in this file has been fixed. Each entry says what is reachable today,
measured, not inferred.

---

## 1. Eighteen employee RPCs have no permission check at all

**This outranks everything else in this file, including the branch gaps, and it
is not what the investigation was looking for.**

The 23 volatile writers `branch_guard_gaps()` reported were opened one by one to
answer "is the branch a property of the row or a parameter?". The answer turned
out to be uniform and almost beside the point.

**Not one of the 23 takes a branch parameter.** Every one identifies its target
by a row id — `p_employee_id`, `p_guard`, `p_run_id`, `p_invoice_id`,
`p_contract_id`, `p_appraisal_id`. The branch is a property of the row in all of
them, which settles the fix shape. But reading them turned up this instead:

**Eighteen of the 23 contain no permission check of any kind** — no
`require_perm`, no `has_perm`, no role test — while being `SECURITY DEFINER`
with `EXECUTE` granted to `authenticated`. They check the *company* and nothing
else.

```
amend_employee_identity      archive_employee            assign_display_number
assign_employee_code         assign_guard_code           change_category
change_guard_shift           mark_form_signed            record_separation
rehire_guard                 renew_contract              run_auto_invoices
set_employee_salary          set_performance_enrollment  transition_appraisal
transition_employee_lifecycle  unverify_employee_identity  verify_employee_identity
```

Only five gate: `record_invoice_payment` and `write_off_receivable`
(`invoices.edit`), `disburse_payroll_run` and `payroll_run_attach`
(`payroll.edit`), `transition_record_state`.

`set_employee_salary`, read in full to be sure the grep was not lying:

```sql
CREATE OR REPLACE FUNCTION public.set_employee_salary(...)
 SECURITY DEFINER
AS $function$
declare v_company uuid;
begin
  -- tenant guard [resolved]: owning company looked up from p_employee_id
  if p_employee_id is not null then perform public.assert_same_company(...); end if;
  ...
  insert into public.employee_salary_history (...)
```

The tenant guard is there and correct. There is nothing else. **Any
authenticated user of GGS can set any GGS employee's salary**, archive them,
record their separation, change their category or amend their identity.

### Why this matters more than the branch finding it came from

The branch escalations need a user who already holds a finance permission. This
needs **no permission at all**. GGS has five `hr` users, two of them branched,
and `hr users hold employees.edit` is **false** — so the permission model
already says these five may not edit employees, and eighteen functions ignore
that.

The branch gap is then a second, smaller layer on the same functions: a branched
user reaches another region's employee. But the first question is not "whose
region" — it is "who said they could edit an employee at all".

### Shape of the fix, and why it is not a sweep

Because the branch is a property of the row in all 23, the same two options
apply as to `record_invoice_payment`, and the same reasoning picks between them:

- **`SECURITY INVOKER`** brings back both `perm_write_upd` (`employees.edit`)
  and `branch_scope` in one change, restating nothing. It is the right answer
  for most of the eighteen.
- **A gate plus a resolved branch assertion** is needed where the function
  legitimately writes rows the caller could not write directly — which is what
  `assign_employee_code` and `assign_display_number` may be for, since they
  exist to allocate a value under a lock.

Three need reading individually before anything is decided:
`run_auto_invoices` (cron, company-wide, correct to have no gate — it should be
`BRANCH GUARD EXEMPT` and permission-exempt by comment), `disburse_payroll_run`
and `payroll_run_attach` (gated on `payroll.edit`, and `payroll_runs` carries
its own `branch_id`, so the branch question there is real but different).

**Nothing has been changed.** Eighteen functions is not a sweep, and the two
that look identical from outside are `verify_employee_identity` and
`unverify_employee_identity` — which is exactly the pair where a careless sweep
would get the direction wrong.

---

## 2. An advance needs no permission to create

`advances` carries **no `perm_write_*` policy at all** — only `company_members`
and `branch_scope`. Every other money table has one.

So any authenticated company member can create, edit and delete an advance.
That is **money leaving on nobody's authority**, and unlike finding 1 it is not
a missing check inside a function — it is a missing policy on the table, which
means every path reaches it, not just the RPCs.

It is smaller than finding 1 only because an advance is bounded by what the
custodian holds, and because the balance leg still needs `accounting.edit` — so
the money movement half-fails and shows up as a non-atomic flow (see §4). The
`advances` row itself commits regardless.

**Fix is one policy**, matching the shape every neighbouring table uses. The
open question is which key: `payroll.edit` (an advance is against wages) or
`expenses.edit` (it is money out of the till). That is Shayan's call and it is
the only reason this is not already done.

---

## 3. The four SECURITY DEFINER RPCs do not scope the branch

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

**`post_manual_journal` is DONE (0366).** `assert_branch_writable()` is one
helper, the branch it is handed is now asserted against the caller's own, and
`branch_guard_gaps()` confirms it no longer reports the function. The helper
also gained a tenant check it did not start with — the migration's own required
tail refused it for `assert_branch_writable.p_branch_id`, and spelling the guard
made the function better rather than merely quieter: a branch from another
*company* is now refused loudly instead of falling through to "not mine".

### `record_invoice_payment` after widening `bank_transactions` — the answer

Widening `bank_transactions` INSERT to admit `invoices.edit` for
`kind = 'receipt'` is the right call and it is **not sufficient on its own**.
Walked write by write for an operator holding `invoices.edit` and nothing else,
under INVOKER, with the widening in place:

| Write | Result |
|---|---|
| `invoice_payments` INSERT | passes — `invoices.edit` |
| `invoices` UPDATE (+ `branch_scope`) | passes — and this is the fix |
| reading `invoices` in the oldest-first loop | scoped to their region — the fix |
| `treasury` UPDATE (Cash) | passes — no permission policy |
| `bank_transactions` INSERT `kind='receipt'` | passes **after the widening** |
| `bank_accounts` UPDATE (Bank) | **REFUSES — needs `accounting.edit`** |

**So: Cash-mode receipts work. Bank-mode receipts still refuse.** Said plainly,
because that is the honest limit and it is exactly the shape 0365 carries.

`bank_accounts` cannot be widened the same way. Its UPDATE policy governs the
whole row — name, account number, balance — and RLS is row-level, so there is no
way to express "`invoices.edit` may move the balance and nothing else" through a
policy. Widening it hands over the account.

**Three options, and the third is one neither of us named:**

1. **Accept the limit.** Receipts clerks hold `accounting.edit`, or they record
   Cash receipts only. Zero new code. On GGS today the single `accounting` user
   holds both keys, so nothing breaks either way.
2. **Widen `bank_accounts` too.** Rejected: hands over the balance and the
   account number to anyone who can record a receipt.
3. **A narrow definer helper for the balance leg alone**, called from the
   invoker function and gated on `invoices.edit OR accounting.edit`. This gives
   up nothing about the branch — `bank_accounts` carries no `branch_scope`, so a
   definer body there loses no regional protection — and keeps every
   branch-scoped write under invoker where the policy does the work. It costs
   one more definer function and restates one permission rule.

**Recommendation: (1) unless Shayan wants receipts clerks who cannot touch bank
transfers.** If he does, (3) is the only version that keeps the branch fix
intact. Not (2).

### The allocation change, to be stated in the migration header

Under INVOKER a branched caller's payment settles only **their own region's**
oldest open invoices. Today it settles the client's oldest across every region.
Almost certainly the intent — but it changes *where money lands*, not just who
may act, and it goes in the header of whatever migration applies it rather than
being discovered afterwards.

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

## 4. Cross-key follow-ups — one reconciled list

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

## 5. Branch guard detector

`branch_guard_gaps()` shipped in 0365 and was refined by 0367 with both
approved changes: trigger functions excluded, and arm B split by volatility so
readers are labelled as readers.

**47 rows across 44 functions → 36 rows across 35.** Eight triggers dropped,
`post_manual_journal` fixed and cleared, nine readers relabelled.

| Shape | Rows | What it means |
|---|---|---|
| `writes` | 24 | Writes a `branch_scope` table without referencing the branch. **§1 is this list.** |
| `stamps` | 3 | Volatile, accepts a branch it never checks: `generate_bonus_pool`, `raise_alert`, `request_approval` |
| `reads` | 9 | Stable, accepts a branch it never checks. **Read escalation** — a branched user learns another region's figures. Real, lesser, separate decision. |

The three `stamps` are `assert_branch_writable()`'s exact shape and are the
cheapest remaining fix in this file. The nine `reads` are
`avg_deployed_guards`, `branch_revenue_for_month`, `employee_in_branch`,
`ho_apportionment_driver`, `interregion_net_position`, `region_cash_entitlement`,
`region_operating_profit`, `region_operating_profit_range`, `region_profit`.

**Still not wired into `ledger_checks`**, and now for a better-stated reason
than "unclassified": 24 of the 36 rows are finding §1, which is a live defect
with no fix applied. Wiring the detector in now would ship a check that is red
because the database is wrong, not because the check is noisy — correct, but it
would sit red for as long as §1 takes, and a permanently red check is one people
stop reading. Wire it the day §1 closes.

0367 asserts its own refinements in both directions: no trigger survives, the
readers were **relabelled and not dropped**, and arm A still finds
`record_invoice_payment`. A detector that quietly stopped matching would
otherwise look identical to one that correctly narrowed.
