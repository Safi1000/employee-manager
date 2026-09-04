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

## 4b. Converting the 21 `writes` to INVOKER — the shape, before converting any

**Asked: which write only branch_scope tables (clean invoker), and which also
touch something needing a key their caller may not hold?**

Every table each of the 21 writes, with its write key and whether it is
branch-scoped:

| Companion table | Write key | Under invoker |
|---|---|---|
| `employees` `[branch]` | `employees.edit` | caller holds it — 0368 gated every one of these on the same key |
| `contracts` | `contracts.edit` | `renew_contract`'s own key |
| `invoices` `[branch]` | `invoices.edit` | `write_off_receivable`'s own key |
| `payslips` `[branch]` | none | `company_members` + `branch_scope` — passes |
| `deployments`, `employee_lifecycle_events`, `employee_code_history`, `employee_salary_history`, `employee_approval_events`, `appraisals`, `contract_lines`, `payroll_runs` | none | `company_members` (ALL) — passes |
| **`audit_log`** | none | **NO INSERT POLICY AT ALL** — `company_members_read` and `ssa_all` only |

**18 of 21 are clean. Three are not, and they are not the three you would
guess.**

### Blocker 1 — `audit_log` has no insert policy

`amend_employee_identity` and `unverify_employee_identity` write `audit_log`
directly. RLS is on and the only policies are a **read** policy and `ssa_all`.
Under invoker both functions would be **refused at the audit write** — the
`record_invoice_payment` problem exactly, on two functions.

It is also the more interesting half: an audit row is written *because* an
action happened, and the actor should not need a separate permission to be
audited. The fix is an insert policy on `audit_log` for company members — the
same reasoning as 0369's receipt carve-out — not a definer helper.

### Blocker 2 — 0368's three exceptions are the three invoker blockers

`renew_contract` is gated `contracts.edit`, `transition_appraisal` and
`set_performance_enrollment` are gated `performance.approve`. All three write
`employees`, which requires `employees.edit`.

**Under a definer gate that was correct**: the employees write is a cascade of an
authorised action, and requiring both keys would mean nobody could renew a
contract without HR rights. **Under invoker it stops working**, because RLS does
not know what a cascade is — it sees a user without `employees.edit` writing
`employees` and refuses.

So the three exceptions argued in 0368 are exactly the three functions that
cannot simply become invoker. That is not a contradiction; it is the same fact
seen from both sides — **a cascade is a thing only a definer function can
express**. Converting them means deciding that renewing a contract really does
require the right to edit staff records, or keeping them definer with a resolved
branch assertion.

### So: one migration, plus two decisions

**18 clean conversions** are one migration of one shape — remove `SECURITY
DEFINER`, and `branch_scope` plus the permission policies do the rest. The
`require_perm` calls 0368 added become redundant for those and should stay
anyway: they fail fast with a better message than an RLS refusal.

**Two decisions first**, neither of which is mine:

1. An insert policy on `audit_log` for company members — needed before the two
   identity functions can convert, and arguably needed regardless.
2. Whether `renew_contract`, `transition_appraisal` and
   `set_performance_enrollment` should require `employees.edit` as well. If yes,
   they convert with the rest. If no, they stay definer and get
   `assert_branch_writable((select branch_id from employees where id = ...))` —
   a resolved branch assertion rather than an invoker conversion.

---

## 4c. There was no orphan. This tree was twelve commits behind.

**Correcting §4c as first written.** I reported two migrations "recorded with no
repo file" and proposed recovering them from their recorded SQL. That premise
was wrong and the correction is the finding.

`git fetch` showed `main` and `origin/main` **diverged: 9 commits mine, 12
theirs**. All three files I could not see already exist on `origin/main`:

- `0341_employee_branch_follows_client.sql`
- `0364_the_repo_reaches_the_database_on_a_schedule.sql`
- `0365_an_expenses_own_audit_row_belongs_to_expenses_edit.sql`

Nothing was lost. Another session applied and pushed through 0365 while this
working tree sat twelve commits behind, and I read "the highest file is 0364"
off a stale tree. `migration_ledger_drift()` was right the whole time — it
compares the database against the **fetched remote manifest**, which had those
files, against a local tree that did not.

### The collision, and how it is repaired

My seven migrations were numbered 0364-0370 from that stale reading, so `0364`
and `0365` each named two different migrations. Renumbered, preserving the order
they actually ran in:

| was | now |
|---|---|
| `0364_an_expense_and_the_money_it_moved_are_one_transaction` | **0366** |
| `0365_a_detector_for_the_branch_the_tenant_detector_never_looked_at` | **0367** |
| `0366_a_branch_handed_in_is_asserted_not_inherited` | **0368** |
| `0367_the_branch_detector_stops_reporting_triggers_and_readers_as_stampers` | **0369** |
| `0368_nineteen_definer_rpcs_ask_for_a_permission_before_they_touch_an_employee` | **0370** |
| `0369_a_receipt_is_recorded_by_the_caller_not_on_their_behalf` | **0371** |
| `0370_an_advance_needs_a_permission_wrong_key_beats_no_key` | **0372** |

**Mine renumbered, not the existing three**, and the reason is not preference:
the three on `origin/main` are already applied, already pushed, and their
recorded names embed those numbers. Moving them would mean editing a file whose
SQL has run. Mine were recorded under BARE names with no number at all, so the
prefix on my files is purely a repo-side ordering device and renaming is free.

**The files were renamed and their contents were NOT touched.** Every header
still cites the old number — `0364 REFUSED`, `0365's header warned`, and so on.
That is deliberate: the recorded SQL must equal the file, and rewriting those
strings would break the digest for seven migrations that have already run. The
prefix is stripped from both sides before `migration_ledger_drift()` compares,
so the renamed files still match their rows.

So the numbers inside those seven headers are two lower than the filenames that
carry them. Ugly, correct, and the reason to get the number right the first
time. The rule is now in CLAUDE.md.

### What is still owed

`main` and `origin/main` have diverged and **that is not mine to resolve.** Nine
local commits, twelve remote. Until they are reconciled and pushed,
`migration_ledger_matches_repo` stays red for my seven — and it reads the
fetched manifest, not the working tree, so **no amount of local committing will
clear it.** A push and the next manifest fetch will.

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

---

## 6. The branch detector taken to zero `writes` and zero `stamps` (0377–0379)

`branch_guard_gaps()` went **15 rows → 10**: `writes` 3 → 1, `stamps` 3 → 0,
`reads` 9 (untouched, see §6d). `tenant_guard_gaps()` = 0 throughout.

### 6a. The two set-processors (0377)

`disburse_payroll_run` and `payroll_run_attach` were held out of 0376's
conversion because both take a RUN and write many payslips. Under invoker a
regional operator would not be refused — they would process only their own
region's payslips and be told it worked.

Both keep the definer body and assert the run's own branch:

```sql
perform public.assert_branch_writable(
  (select branch_id from public.payroll_runs where id = p_run_id));
```

**The NULL run is the part worth reading.** `payroll_runs.branch_id` is
nullable and NULL means "every region". `assert_branch_writable()` returns
early on NULL — correct for a head-office journal line and exactly wrong here,
because it would let a regional operator disburse the whole company. So the
NULL case is refused explicitly in both bodies rather than left to the helper.
**A helper's NULL semantics are a property of the helper, not of every caller.**

Production holds **zero** `payroll_runs`, so neither arm has ever executed
against real data here.

The general rule this produced is in CLAUDE.md ("A set operation is not safe to
convert to SECURITY INVOKER"), in `scripts/migration-template.sql` §3(a), and
on the `branch_guard_gaps()` comment.

### 6b. The three stampers (0378), and what guarding them does not close

> **SUPERSEDED BY §10 (0387).** The four tables are company-wide by design and
> the three guards below have been reverted. Kept because the reasoning that
> reached the wrong conclusion is worth reading beside the answer.

`generate_bonus_pool`, `raise_alert` and `request_approval` all took a
`p_branch_id` that decided which region the row landed in, and all three already
called `assert_branch_in_company(p_branch_id)` — **the company boundary wearing
a branch helper's name**, which is why `branch_guard_covered()` deliberately
does not count it. All three now call `assert_branch_writable()`.

Two things are not uniform and both matter:

- **`generate_bonus_pool` is guarded on `v_scope_branch`, not `p_branch_id`.**
  The head-office arm writes `head_office_region()` while `p_branch_id` is
  NULL, so a guard on the parameter would return early on that NULL and let a
  regional approver generate the head-office pool and its allocations. 0378's
  probe asserts the guard's **position** is after the scope assignment, because
  a guard placed too early reads NULL, asserts nothing, and still reads as
  covered to the detector.

- **`raise_alert` has three in-database callers and the guard changes one.**
  `sweep_ammo_discrepancy_alerts()` loops over every discrepancy in the company
  and raises one alert per branch; a regional caller now hits the guard on the
  first foreign branch and the whole sweep rolls back. That is a refusal rather
  than a partial result, which is the preferred failure mode — but **a branched
  user can no longer run the company-wide sweep at all.** That is a behaviour
  change, not a no-op. `check_deploy_guard` and `check_disbursement` pass a
  branch resolved from the row they act on and are unaffected;
  `run_scheduled_ledger_checks` is cron-only, has no `auth.uid()`, and
  `assert_branch_writable()` returns early for it.

**STILL OPEN, and this is the finding of 0378.** `alerts`,
`approval_requests`, `bonus_pools` and `bonus_pool_allocations` carry
`company_members` (ALL, `company_id = current_company_id()`) and **no branch
policy at all**. So a regional user can still insert an alert or an approval
request naming another branch by writing the table directly, and one with
`performance.approve` can still write `bonus_pools` directly.

> **A function guard on top of an unguarded table makes the detector go green
> and leaves the hole.**

The real fix is `branch_scope` on those four tables, which is a policy question
— is the alert feed company-wide by design? — and is **not** taken.

### 6c. The definer parents conversion did not close (0379)

`CURRENT_USER` inside a definer body is the owner, so an invoker child called
from a definer parent still bypasses RLS. The full audit of definer functions
calling a now-invoker plpgsql child:

| Parent | Child | Shape |
|---|---|---|
| `auto_standdown_on_adverse_vetting` | `transition_employee_lifecycle` | trigger — intended cascade, left alone |
| `enforce_identity_lock` | `amend_employee_identity` | trigger — left alone |
| `sync_employee_active_client` | `assign_display_number` | trigger — left alone |
| `reassign_client_employee_codes` | `assign_employee_code` | **callable — fixed** |
| `run_appreciation` | `set_employee_salary` | **callable — fixed** |

(`client_statement_loaded`, `partner_basis_for_report`,
`partnership_allocation` and `regional_pl_range` call `resolve_company_scope`,
which reads and writes nothing. Not a path.)

Both callable parents are set-processors returning a count, so **neither is
converted** — they get body assertions of two different shapes, because the two
functions are different:

- `reassign_client_employee_codes` takes a CLIENT and a client has a branch →
  resolved from `clients.branch_id`.
- `run_appreciation` takes a COMPANY and re-salaries every enrolled employee in
  it. There is no branch to resolve because the act is company-wide by
  construction, so a regional caller is **refused outright** — the same shape
  as 0377's NULL run. Giving it a branch parameter would be inventing a
  feature; refusing it states what it already is.

### 6d. The nine `reads` — what each actually exposes

> **DECIDED BY §10 (0387).** Same answer: not a defect. The table below still
> describes accurately what each one exposes.

Reported, not fixed, per the brief. Two facts frame the whole list:

1. **All nine return a SCALAR** — one `numeric`, or one `boolean`. None returns
   rows. The exposure is an aggregate figure per call, never row-level data.
2. **None is called by the frontend.** A repo-wide grep of `src/` and
   `supabase/functions/` finds no `rpc(` call to any of them. The one hit —
   `Treasury.tsx:182` — reads a **column named** `interregion_net_position` off
   the `cash_entitlements` view, not the function.

| Function | Returns | Reached from | What a branched caller learns |
|---|---|---|---|
| `employee_in_branch(p_employee, p_branch)` | boolean | `user_can_see_employee` | **Not a leak, and must NOT be guarded — see below** |
| `region_operating_profit(co, branch, year)` | numeric | `generate_bonus_pool`, `regional_scorecard` view | another region's annual operating profit |
| `region_operating_profit_range(co, branch, from, to)` | numeric | `accrue_bonus_reserve` | the same for an arbitrary window |
| `region_profit(co, branch, year)` | numeric | nothing in-database | another region's profit |
| `region_cash_entitlement(co, branch)` | numeric | nothing in-database | another region's cash + bank + bonus-reserve balance |
| `interregion_net_position(co, branch)` | numeric | `cash_entitlements`, `regional_scorecard` views | what another region owes or is owed |
| `branch_revenue_for_month(co, branch, period, basis)` | numeric | nothing in-database | another region's monthly revenue |
| `avg_deployed_guards(co, branch, period)` | numeric | nothing in-database | another region's headcount |
| `ho_apportionment_driver(co, branch, period)` | numeric | `run_ho_cost_allocation` | another region's share of HO cost |

**`employee_in_branch` is a false positive of a fourth shape the detector does
not have: a POLICY HELPER.** Its only in-database caller is
`user_can_see_employee`, which is the `branch_scope` predicate on `payslips` —
and it is always called as `employee_in_branch(emp, current_branch_id())`, the
caller's own branch. Guarding it against the caller's branch would be circular:
the policy asks "is this employee in branch X" and the helper would refuse to
answer. **Do not guard it.** Its residual direct-call exposure is a branched
user enumerating "is employee E also attached to branch B" one boolean at a
time, which is smaller than what `employees` RLS already permits about the
existence of a row.

The remaining eight are genuine read escalation, all of the same kind: a
regional manager can read another region's financial aggregates. Whether that
should be refused is a **policy decision, not a defect** — regional scorecards
are commonly comparative on purpose, and two of the eight already feed views
(`regional_scorecard`, `cash_entitlements`) whose whole point is a company-wide
table of regions side by side. Guarding the functions while those views stay
open would close nothing and would break `generate_bonus_pool`,
`accrue_bonus_reserve` and `run_ho_cost_allocation`, which call them across
regions by design.

**Recommendation:** guard nothing here; instead decide whether the
`regional_scorecard` and `cash_entitlements` *views* are company-wide, and let
the functions follow that answer. Awaiting a decision.

### 6e. `transition_record_state` asks a role where everything else asks a permission

The last remaining `writes` row, deliberately untouched by 0377. It is not
ungated — which is why it was never in 0370's nineteen — but it gates on a role
string:

```sql
select role::text into v_role from public.profiles where id = auth.uid();
...
if v_role not in ('finance_director','super_admin','super_super_admin') then
```

**Which permission should it ask?** The rule is: what a direct write to the
target table would require. It writes `employees` → `employees.edit`. But that
flattens a deliberate two-stage separation of duties into one key: Ops-verify
and Finance-approve are meant to be different people, and `employees.edit` is
held by everyone who can edit staff at all. So the answer is **two keys, one
per stage**:

| Arm | Should ask | Exists in `PERMISSION_GROUPS`? |
|---|---|---|
| `ops_verify` | `employees.ops_verify` | **NO** |
| `finance_approve` | `employees.finance_approve` | **NO** |
| `reverse` | the key for the stage being reversed from | — |

`employees.ops_verify` is **already referenced in the body today**, as an
alternative to the role list — and it is not in `PERMISSION_GROUPS`, so it can
never be granted to anybody. That is the `partnership.post` defect of 0361
repeating exactly: *a permission the database demands and the grant screen
cannot offer is a permission nobody can be given.* (Note `attendance.ops_verify`
does exist and is a different thing.)

So the fix is three parts and none of them belongs in a branch migration:
add both keys to `PERMISSION_GROUPS`, replace the role literals with
`require_perm`, and only then convert the function. **Awaiting a decision on
the two key names before any of it.**

---

## 7. The cross-key flows closed (0380–0383), and two defects found doing it

### 7a. It was EIGHT flows, not nine — and then it was eight again

Two corrections to §4, in opposite directions:

- **`nextStage` was never cross-key.** `ComplianceCases.tsx:144` is a single
  `update compliance_cases set stage`. The `statutory_filings` writes are
  separate buttons on a separate tab, and neither table has a trigger linking
  them. The description in §4 — a case worker advancing a case and failing to
  record the filing — describes something this code does not do. Removed.
- **`handleDeletePayment` (Invoices.tsx:984) was missing.** It shares
  `reverseOldPaymentEffects` with `handleEditPayment`, exactly as
  `reverseExistingPayment` served both expense edit and expense delete. The
  list counted helpers, not the callers that reach them — the same mistake
  §4's own reconciliation note called out, made again.

### 7b. `apply_money_delta()` — one definition of how money moves (0380)

Eight bodies would have grown eight copies of decisions that each took a probe
to get right: the arithmetic under the row lock, the row-count assert, the
treasury bootstrap, and the two different zero-row diagnoses (treasury reads
and writes under one policy, so an invisible row is genuinely absent;
`bank_accounts` reads under `company_members` and writes under
`accounting.edit`, so a *visible* row that did not update is a permission
refusal and says so by name).

`p_delta` is **signed**. A reversal is not a separate concept — it is the same
call with the opposite sign, which is what the frontend helpers were already
doing one round trip at a time.

`record_expense` was **restated onto it** in the same migration, behind an md5
precondition (single author, so restatement is the sanctioned path). Leaving it
with its own copy would have meant the helper is the definition of how money
moves everywhere except in the one place that already worked.

**The probe caught a real bug.** `bank_transactions.company_id` is NOT NULL and
was being left to `fill_company_id`, which reads the session. The fix is better
than the bug: `p_company` is passed explicitly, because it came off the row
whose balance just moved rather than off the session, and those differ for
cron, SQL and definer callers.

`describe_expense()` and `describe_advance()` moved into the database for the
same reason — the sentence on an audit line is now built in one place whether
the row was created, amended or reversed.

### 7c. The expense flows (0381)

`expense_reverse_money()` holds "undo the money this expense represents", which
is four rules and not one:

| State | Reversal |
|---|---|
| Cash | return the cash |
| Bank | return it to `bank_account_id` |
| Payable, Pending | nothing moved, nothing to return |
| Payable, **Paid** | return it via `paid_via` / `paid_bank_account_id` |
| Cheque | nothing — a cheque moves money when it clears |

The fourth line is the one that gets forgotten, **because a settled payable
pays out of a different account from the one on the expense**. It is read off
the row, so no caller can pass the wrong account for its own reversal.

On top of it: `amend_expense`, `delete_expense`, `settle_payable_expense`,
`revert_payable_expense`.

**`handleMarkPaid` had the worst ordering of the four** — it moved the money
first and updated the expense last. A user with `accounting.edit` and without
`expenses.edit` paid the vendor and left the payable at Pending, learning why
only after the cash was gone. `settle_payable_expense` writes the row first,
and refuses a payable that is already settled rather than paying it twice.

`revert_payable_expense` reverses **before** clearing the status, because the
refund reads `paid_via` off the row and the update is what erases it. Clearing
first would refund nothing and report success.

**Probe:** record → amend → delete returns cash to exactly the starting figure;
recording a Payable moves nothing; settle → revert returns it again; a second
settle is refused *by message*. The round trip is the assertion that matters —
each step on its own "succeeds", and only the closing balance shows a sign or
an account being wrong.

### 7d. The advance flows (0382)

`record_advance`, `amend_advance`, `delete_advance`, plus
`advance_reverse_money`. Deliberately **not** folded into the expense helpers:
an advance has no payable state, so there is no `paid_via` to read back, and
its audit lines carry `kind = 'advance'`, which the cashflow screens filter on.
What they share is `apply_money_delta()` — the part that was worth sharing.

These flows became *more* cross-key than §4 recorded, not less: 0372 gave
`advances` a permission (`expenses.edit`, provisionally) where it had none, so
the row and the bank balance now need two different keys.

**Probe:** a **Cash → Bank amend**, which the expense probe could not test.
Both balances are measured, because a reversal reading the caller's *new*
parameters instead of the stored row would return the money to the account the
advance is moving *to* — cash short, bank twice credited — and a test watching
one balance would call that correct.

### 7e. The receipt flows (0383), and a defect that is not about permissions

`record_invoice_payment` credits the receivable with **cash and withholding
together** (A1: outstanding is gross). Both frontend flows undid the cash only:

```
handleEditPayment:   newReceived = amount_received - old.amount + new
handleDeletePayment: newReceived = amount_received - old.amount
```

So **every edit or delete of a payment carrying withholding left the invoice
over-credited by exactly the withholding** — silently and permanently, because
nothing recomputes `amount_received` from the payment rows.

Not yet money on GGS: no `invoice_payments` row carries a non-zero
`withholding_amount` today. It is a live defect waiting for the first client
with a WHT rate, which is why it is fixed rather than logged.

`amend_invoice_payment` and `delete_invoice_payment` move
`amount + withholding_amount` in both directions, read off the stored row. The
"exceeds invoice total" check moved into the RPC, where it can be made *after*
the reversal against a figure nothing else can move in between.

**Probe:** the withholding half specifically. Production holds **zero
invoices**, so the probe creates one inside the rolled-back block rather than
skipping the arm — a skipped arm is a test reporting success without having
run.

### 7f. What the frontend lost

`applyCashDelta`, `applyBankDelta`, `logExpenseTransaction`,
`logAdvanceTransaction`, `describeExpense`, `describeAdvance`,
`reverseExistingPayment`, `reverseAdvancePayment` and
`reverseOldPaymentEffects` are **deleted** from `Expenses.tsx` and
`Invoices.tsx`. Leaving them would have left the next flow a way to move a
balance in a round trip.

**Still client-side, and out of scope:** `Accounting.tsx` keeps
`applyCashDelta`/`applyBankDelta`/`logTransaction` for bank transfers and
reconciliation. Those are single-key (`accounting.edit`), so they are not
cross-key — **but a transfer debits one account and credits another in two
separate round trips**, which is an atomicity hole of a different kind. Next
candidate.

### 7g. `ComplianceCases.tsx` — silence is not success

The `run()` helper treated "no error" as success. A user without
`compliance.edit` clicking "→ submitted" got no error, a refreshed screen, and
a case still on the stage it started on. Same for File/Pay and
`compliance.filings`.

Every caller now asks for the rows back with `.select()`, and zero rows is
reported as a refusal naming the permission that would have allowed it. This is
the frontend half of the rule the RPCs enforce with
`get diagnostics v_n = row_count`.

---

## 8. `transition_record_state` and the permission catalogue (0384–0385)

### 8a. The check that would have caught it twice

`permission_keys` mirrors `PERMISSION_GROUPS`. `permission_keys_demanded()`
reads every key actually required — `require_perm`/`has_perm` in any function
body, and `has_perm` inside any RLS policy — and `permission_key_gaps()`
reports demanded-but-uncatalogued. `ledger_checks()` evaluates it nightly as
`every_demanded_permission_is_grantable` (canary 33 → 34).

Only the harmful direction is reported. Catalogued-but-unused is not a defect —
a key may gate a screen rather than a row.

**0384's probe runs the check against the real historical case before closing
it:** the catalogue is seeded *without* `employees.ops_verify`, and the gap
report must name that key and nothing else. Then the two new keys are added and
the arm must be green. A checker that came back empty at the first step would
have been inert, and adding the keys would have made it look like it worked.

### 8b. The two stage keys

`employees.ops_verify` and `employees.finance_approve`, replacing four role
literals. `employees.ops_verify` was **already demanded by the body** and had
never been in `PERMISSION_GROUPS`, so it could not be granted to anybody and
the role list has been the entire gate since it was written.

The rule — require what a direct write to the target table would require —
is set aside here, and the exception is now in CLAUDE.md beside it: **where a
function exists so that two different people act, the key follows the stage,
not the table.**

### 8c. It stays SECURITY DEFINER, and that is a departure

The brief said: add the keys, replace the literals, **then convert**. The
conversion is not done, and doing it would undo what the keys just bought.

Under invoker the `update employees set record_state` runs against the caller's
own policies, and `employees` carries `perm_write_*` on `employees.edit`. A
converted `transition_record_state` would demand `employees.ops_verify` **and**
`employees.edit` — putting back exactly the flattening the stage keys were
chosen to avoid. An Ops verifier would need full staff-edit rights to verify a
record.

This is 0375's cascade argument in its clearest form. So it pays for the
definer body the same way — with a resolved branch assertion, from the employee
being moved. **That closes the last `writes` row.**

The probe asserts the function is **still definer**, because a conversion would
have quietened the detector and passed a "does it ask a permission" test while
quietly requiring `employees.edit` of every verifier.

---

## 9. State after this round

| | |
|---|---|
| `branch_guard_gaps()` | **9** — all `reads`, all logged as a policy decision (§6d) |
| `writes` / `stamps` | **0 / 0** |
| `tenant_guard_gaps()` | **0** |
| `permission_key_gaps()` | **0** |
| `ledger_checks()` | 34 checks; canary green; the permission arm green |
| Probe residue | none — no PROBE expenses, advances, invoices, payments or bank transactions |

**Open, and for Shayan:**

1. `alerts`, `approval_requests`, `bonus_pools`, `bonus_pool_allocations` carry
   no branch policy (§6b). Company-wide by design, or branch-scoped?
2. `regional_scorecard` and `cash_entitlements` show regions side by side by
   design; the nine `reads` feed them (§6d). Same question, possibly a
   different answer.
3. `advances` is still behind `expenses.edit`, explicitly provisional (§2).
4. Bank transfers in `Accounting.tsx` debit and credit in two round trips
   (§7f).

---

## 10. DECIDED: the four tables are company-wide, and three guards come out (0387)

**Shayan, 2026-09-04: `alerts`, `approval_requests`, `bonus_pools` and
`bonus_pool_allocations` stay company-scoped with no branch policy. That is the
design, not a gap.**

This supersedes the open questions in **§6b** and **§6d**. Both are now
**DECIDED**. Nothing above has been deleted — the reasoning that led to the
wrong conclusion is worth keeping next to the answer.

### 10a. What was wrong, and what was right

§6b was right that *a function guard on top of an unguarded table makes the
detector go green and leaves the hole.* It was wrong that there was a hole. It
read "no branch policy" and inferred an omission, because **a table with no
branch policy looks identical whether that is a decision or an oversight** —
there was nothing on the table saying which.

There is now. All four carry a `COMPANY-WIDE BY DESIGN` table comment naming
the decision, the date, and the reason, so the next reader does not have to
infer it from silence as 0378 did.

### 10b. The three guards are reverted

0378 guarded `generate_bonus_pool`, `raise_alert` and `request_approval`
against a boundary that does not exist. **Left standing, a wrong assumption
becomes the system's behaviour**, so they come out.

| Function | Was the guard over-tight? | What the revert gives back |
|---|---|---|
| `raise_alert` | **Yes, and it cost something** | `sweep_ammo_discrepancy_alerts()` works again for a branched user. 0378's guard aborted it on the first foreign branch and rolled the whole sweep back — a refusal-over-partial-result trade that was justified by the boundary Shayan has now said does not exist |
| `request_approval` | Yes | Nothing was lost while it stood — no in-database caller — but a regional user filing a request naming another region is the queue working as designed |
| `generate_bonus_pool` | Yes — **and flagged, see below** | A holder of `performance.approve` can generate any region's pool again, head office included |

**The flag, said out loud rather than buried in a revert.** Of the four tables,
`bonus_pools` is the only one where a row determines a **payment**:
`bonus_pool_allocations.share_amount` is what an employee is actually paid. So
"company-wide" here means someone with `performance.approve` can generate any
region's pool, head office included, and rebuild its allocations wholesale.
That follows from the decision exactly as stated, and `performance.approve`
remains the gate — but it is a materially different sentence from "anyone can
file an alert about another region". **One word from Shayan puts that one guard
back on its own**; the table comment on `bonus_pools` records the same note.

### 10c. The `reads` are decided too, by the same answer

The nine `reads` (§6d) follow from the same decision and are **closed as
decided, not open**. `regional_scorecard` and `cash_entitlements` exist to show
regions side by side; the tables behind the shape are company-wide; a scalar
aggregate about another region is not an escalation.

`employee_in_branch` remains a separate and permanent NO: it is the
`branch_scope` predicate's own helper, called with `current_branch_id()`, and a
guard would make it refuse the question it exists to answer.

### 10d. So the detector's own description had to change

Otherwise `branch_guard_gaps()` reads **12 forever** and somebody eventually
"finishes" it, putting back exactly the guards 0387 removes. The function
comment now records, per shape:

- **`writes`** — the **mechanical** shape. A table carrying `branch_scope` is
  branch-scoped by definition. **This is the only shape `ledger_checks`
  asserts**, and it is at zero.
- **`stamps`** — **advisory**. It fires on any definer function taking a uuid
  branch parameter, regardless of what that function writes, so each member
  needs a judgement about its target table. The three current members are
  DECIDED.
- **`reads`** — **decided**, as above.
- And: **a new stamp or read is a new judgement.** It does not inherit this one.

`ledger_checks`'s `no_definer_function_crosses_a_branch` arm narrowed from
`writes + stamps` to **`writes` only**. That is not a carve-out to keep it
green: `stamps` stopped being a mechanical property the moment the tables
behind it were decided, and a future stamper writing a genuinely branch-scoped
table is caught by the `writes` arm anyway — arm A tests the **table**, not the
parameter. Nothing mechanical is lost. The check count does not change (35).

### 10e. State

| | |
|---|---|
| `branch_guard_gaps()` | **12** — 3 stamps + 9 reads, **all decided**, 0 writes |
| `no_definer_function_crosses_a_branch` | green, asserting `writes` only |
| `tenant_guard_gaps()` / `permission_key_gaps()` | 0 / 0 |

**Still open after this:** `advances` behind `expenses.edit` provisionally
(§2), and bank transfers in `Accounting.tsx` debiting one account and crediting
another in two round trips (§7f) — single-key, so not cross-key, but an
atomicity hole of a different kind. Next.

---

## 11. Bank transfers, and the last balance moved in a browser (0388–0389)

### 11a. `bonus_pools` is DEFERRED, not DECIDED (0388)

Shayan is leaving the `generate_bonus_pool` flag as it stands: the guard stays
off, which follows from the company-wide decision exactly as stated. **But it
was asked and left open, not settled**, and the table comment now says so in
those words.

The distinction that earned the flag is unchanged: the other three company-wide
tables are **visibility** — who may see or file a record about another region.
This one determines a **payment**. A pool sets
`bonus_pool_allocations.share_amount`, which is the figure an employee is
actually paid, and `generate_bonus_pool()` rebuilds those allocations
wholesale.

`DECIDED` means asked, answered, do not reopen without a reason. `DEFERRED`
means asked, deliberately left open, still owed an answer. **A flag that is not
marked slides into the first by default**, because nothing on the object
distinguishes "settled" from "not yet returned to" — six months on, the comment
reads as a decision nobody made.

The phrase `COMPANY-WIDE BY DESIGN` is deliberately **dropped from this one
comment** and kept on the other three: "by design" is a claim about settled
intent, and that is the exact claim not being made. The scoping is the same; the
confidence is not. 0388's probe asserts the marker is on `bonus_pools` and on
**none** of the other three — widening the wording to all four would bury the
one open question in three closed ones.

Reversing it is one line: re-add `assert_branch_writable(v_scope_branch)` to
`generate_bonus_pool()`.

### 11b. `record_bank_transfer()` (0389)

`handleTransfer` did **five round trips with nothing around them**: debit,
credit, two log lines, then a pairing update.

**A failure between the first two destroys money.** Not "leaves a record
inconsistent" — the company's total bank balance is lower than it was and
nothing anywhere says why. A failure between 2 and 3 leaves both balances right
and the movement absent from the transaction log, so the next reconciliation
cannot explain either side.

This is **not** the cross-key defect the eight flows had: a transfer needs
`accounting.edit` and nothing else, so no half can be refused for want of a
second permission. It is the same shape one layer down — **several writes that
are only correct together, issued separately.**

**The observation that says where to look next:** the two *harder* cash-and-bank
moves on this screen were already atomic RPCs — `record_bank_to_custodian()`
for a withdrawal, `record_cash_deposit()` for a deposit. The simple one was the
one left in the browser. **Difficulty does not predict this; whether somebody
happened to reach for an RPC does.**

**Deliberately not added: an overdraw refusal.** The old path did not check, and
0366 removed exactly that kind of check from the expense form on purpose — it
measured a cached company-wide scalar, and an overdrawn account is a fact the
ledger holds rather than something to prevent at the keyboard. Adding one here
would smuggle a new refusal in under a transaction fix. If transfers should
refuse an overdraw, that is its own decision.

**Added, because the browser could not enforce them:** the two accounts must
differ (checked in a form a stale tab can get round) and must belong to the same
company (**not checked at all** — RLS would have caught a foreign account, but
as a silent zero-row UPDATE on the *second* leg, after the first had committed).

**Probe:** **conservation.** After a transfer the two balances have moved by
equal and opposite amounts and the total is unchanged — the property the old
path could break, and the one thing neither leg can demonstrate alone, since
each leg "succeeds". Then two paired legs summing to zero in the log, dated by
the transfer date; then both refusals **asserted on their messages**. The
cross-company arm says out loud when it cannot run rather than passing silently.

### 11c. What is left on that screen

`applyCashDelta`, `applyBankDelta` and `dateToTs` are **deleted** from
`Accounting.tsx`. **Nothing on that screen moves a balance from the browser any
more** — withdrawals, deposits and transfers are all RPCs.

`logTransaction` stays, used by two flows that write a *log line* beside an
opening balance rather than moving money.

**Next, and found while doing this:** `handleSetCashOpening` writes
`cash_balance: cashBalance + amt`, where `cashBalance` comes from React state.
That is the read-modify-write race in its purest form, on the cash balance
itself, and it is followed by a separate log-line insert. It *sets* an opening
balance rather than moving one, so it is a different thing from the eight flows
and from the transfer — but it is the last read-modify-write on a balance in the
codebase. Not fixed here; scope was transfers.

### 11d. Also still open

- **`advances` behind `expenses.edit`, provisionally.** An advance to a guard is
  money against their future pay, and neither `expenses.edit` nor `payroll.edit`
  is obviously right. Owed to Shayan as its own question.
