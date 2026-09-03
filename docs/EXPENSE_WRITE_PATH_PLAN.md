# The expense write path — defect, plans, and what was declined

**Production, `crm-design`. Found 2026-09-03, reported 2026-09-04.**

An employee holding `expenses.edit` entered five cash expenses on GGS. Every one
was refused in the dialog with *"You don't have permission to do this"*, and
every one was recorded anyway. The operator retried, because the UI told them it
had failed, and produced a duplicate.

## Cause

`handleAdd` is four independent REST calls with no transaction:

| # | call | outcome |
|---|---|---|
| 1 | `insert expenses` | **committed** |
| 2 | upload receipts to Drive | ok |
| 3 | `update treasury` (`applyCashDelta`) | **committed** |
| 4 | `insert bank_transactions` | **REFUSED — 42501** |

`perm_write_ins` on `bank_transactions` requires `accounting.edit`. The employee
holds `expenses.edit`. **A single user action spans two tables gated on two
different permission keys**, and nothing in the permission UI says the two
travel together.

Six refusals in the Postgres log — 15:05:12, 15:10:03, 15:13:06, 15:15:35,
15:15:59, 15:16:23 — each 9–10 seconds after an expense row was created.

Exactly two profiles can hit it: **Gul Rahman** and **Muhammad Nosherwan Adil**
(`hr`, `expenses.edit`, no `accounting.edit`). **Taha Arshad** (`accounting`)
holds both, which is why the 07:27–07:36 expenses the same morning are clean.

### The second failure, which has no symptom at all

`applyCashDelta` is a `SELECT` then an `UPDATE`. **A blocked `UPDATE` returns
zero rows with no error** (documented in `src/app/lib/supabase.ts`). Where that
happens the cash balance silently does not move and nothing is raised. Step 4
fails loudly; step 3 would not.

## Two things that were NOT wrong

Worth recording because both were assumed and neither held.

- **The reversal carried the custodian.** Deleting the duplicate produced
  `Dr 1000.01 Gul Rehman 400 / Cr 6900 400`. `custodian_held_operational()`
  reports **difference 0.00 on all four custodians**. The ledger is clean.
- **The stranded 400 is not in the journal.** It is
  `treasury.cash_balance` (10,274) against Σ custodian held (9,874) — a cached
  scalar with no derivation from the ledger. See Plan 3.

---

# DECLINED: backfilling the four missing audit rows

Four cash expenses have no `bank_transactions` row, totalling **PKR 1,683**.
Recorded here so the decision is not re-made from the same wrong premise.

| reference_id | amount | cash_delta | description | custodian |
|---|---|---|---|---|
| `0dd73850-1e87-4f46-b8af-dde0a5f07666` | 188 | −188 | Transportation & Fuel (Office): GGS-PCI-GGS Visit by Gul Rehman for meeting with Col Arshad. | Gul Rehman |
| `edabfec2-2d34-4fd2-9f9d-cafe857db285` | 700 | −700 | Refreshment (Office): Breakfast for Reli Saleem & Lunch for Supv Zahid | Zafar Iqbal |
| `d1c1730b-79e4-4deb-9507-cf6cbaa67215` | 480 | −480 | Refreshment (Office): Lunch for CFO | Gul Rehman |
| `804dae1f-1081-4922-a584-eba60f907acb` | 515 | −515 | Refreshment (Office): Refreshment for Office Staff (Tea) | Gul Rehman |

All would be `kind='expense'`, `bank_account_id` null, `company_id` GGS.

**They were not written, and the reason is that the problem they would solve
does not exist.** Cash Custody's transaction log builds its expense entries from
the `expenses` table directly:

```ts
// CashCustody.tsx:286
for (const ex of (cashExps ?? []) as any[]) { ... kind: "cash_paid", cashOut: Number(ex.amount) }
```

Its only `bank_transactions` reads filter `kind='withdraw_to_cash'` and
`kind='payroll'`; `custodian.ts` is the same. **All four movements already
appear** in the custodian log and in every custodian balance — which is also why
`custodian_held_operational` reads 0.00 and why the 1,683 is no part of the 400.

The one place they are absent is `Accounting.tsx`, which reads
`bank_transactions.select("*")` for Banks & Ledgers. For a cash expense
`bank_account_id` is null, so those rows would sit in a list of *bank*
transactions belonging to no bank.

So `bank_transactions` with a null bank is a **second copy of what `expenses`
already holds, that nothing reads for cash**. Writing four rows to settle a
visibility problem that does not exist would create duplicates that
double-count the day the cash path becomes a reader. **Plan 1 decides whether
cash belongs in that table at all; the backfill follows that decision rather
than pre-empting it.**

---

# Plan 2 — done first, unblocks entry today

`0365_an_expenses_own_audit_row_belongs_to_expenses_edit.sql`.

Three policies on `bank_transactions`, a **disjunction, not a swap**:

```sql
has_perm('accounting.edit')
or (has_perm('expenses.edit') and kind = 'expense' and bank_account_id is null)
```

Transfers, deposits, withdrawals and payroll stay on `accounting.edit`.
Replacing the key rather than widening it would hand every expense clerk the
bank transfer log — a bigger hole than the one being closed.

### The carve-out: `bank_account_id is null`

Bank-paid expenses are deliberately **not** opened up. `applyBankDelta` runs
*before* the audit insert and is an `UPDATE` on `bank_accounts`, still gated on
`accounting.edit` — and a blocked `UPDATE` is silent. Widening to bank expenses
would let an `expenses.edit`-only user record the expense, leave the bank
balance untouched without raising, and then write a clean-looking audit row
saying the money moved. Today that user is stopped by a loud refusal.

**Loud and wrong beats quiet and wrong.** The cash path — the one that is broken,
and the one with no bank balance to miss — is the only path opened. Bank-paid
expenses keep failing as they do now until Plan 1 lands.

### The verification proves both halves

Proving only that the expense insert now succeeds would be satisfied by dropping
the policy altogether. Under one impersonated identity, in one session:

- (a) a cash expense audit row **must insert**
- (b) a `kind='transfer'` row **must be refused, by the policy, by message**
- (c) an expense row naming a bank **must be refused** — the carve-out

Two different outcomes under identical conditions cannot both be explained by
"the policy was not applying", which is what makes (b) the control for (a).

The probe identity is *filtered to the property under test and asserted to
exist* (§9.14a): a profile with `expenses.edit` and without `accounting.edit`.
If none exists the migration **refuses** rather than passing vacuously.

---

# Plan 1 — one RPC for the whole action

`record_expense`, `void_expense`, `amend_expense` — `security definer`, one
transaction, one permission key, in that order:

1. `require_perm('expenses.edit')` — one gate
2. validate custodian/bank belongs to `current_company_id()`
3. insert `expenses`
4. adjust cash or bank
5. insert the `bank_transactions` audit row
6. the posting trigger produces the journal entry

Any failure rolls back all of it. **The error-on-success class disappears**
because there is no longer a point at which some of the action is committed and
some is not. The silent `UPDATE` disappears too: inside the RPC that update is
plain SQL under a definer owner, so it either happens or the call raises.

**Receipts stay outside, deliberately.** Google Drive cannot join a Postgres
transaction. The upload runs first; if the RPC then fails, the residue is an
orphan Drive file — a file nobody references — rather than a half-recorded
expense. That is the correct side to fail on, and it belongs in the migration
rather than being rediscovered.

**`handleEdit` is the point, not a bonus.** It currently does reverse-then-
reapply as two delta calls with a log write between them; if the middle throws,
the reversal stands alone. That is the shape that produced the 400. Collapsing
it into `amend_expense` is the reason to do this work.

## Follow-ups to Plan 1 — the six other cross-key paths

Found by enumerating all 28 perm-gated tables from the live policies, then every
handler writing across more than one key, following one level of local helper
calls.

| handler | keys spanned | reached via |
|---|---|---|
| `Expenses.tsx:1499 handleEdit` | `expenses.edit` + `accounting.edit` | `logExpenseTransaction()`, `applyBankDelta()` |
| `Expenses.tsx:941 handleDecision` | `expenses.edit` + `accounting.edit` | same |
| `Accounting.tsx:1349 handleMarkPaid` | `expenses.edit` + `accounting.edit` | `logTransaction()`, `applyBankDelta()` |
| `Accounting.tsx:1434 handleRevertToPending` | `expenses.edit` + `accounting.edit` | same |
| `Invoices.tsx:876 handleEditPayment` | `invoices.edit` + `accounting.edit` | same |
| `ComplianceCases.tsx:58 nextStage` | `compliance.edit` + `compliance.filings` | direct, both tables |

**These are follow-ups to the RPC work, not six more policy widenings.** Once
each write is one RPC under one key, a cross-key span cannot exist. Patching the
policies individually fixes the symptom six times and leaves the class.

`nextStage` needs its own look and has a different consequence: a case worker
without `compliance.filings` advances the case and fails to record the filing —
**a compliance record that says it was filed when it was not.**

`cross_key_write_paths()` as a suite check is deferred by decision: it cannot
see `src/`, so it needs `0364`'s treatment or it stays a hand-run sweep. Decide
after Plan 1, when the number of real spans is known — if Plan 1 takes six to
zero, the check has almost nothing to watch.

---

# Plan 3 — derive Cash in Hand from the ledger

`treasury.cash_balance` is one mutable scalar per company with **eleven write
sites in two languages**:

- three *separate copies* of the same `applyCashDelta` helper —
  `Accounting.tsx:824`, `Expenses.tsx:1084`, `Invoices.tsx:402`
- two inline writes in `Accounting.tsx:982,992`
- two inline writes in `PayrollManagement.tsx:1355,1540`
- four database functions — `record_invoice_payment`, `record_cash_deposit`,
  `record_bank_to_custodian`, `cheque_apply_balance`
- `seed_company_defaults`

Every browser-side one is a read-modify-write over HTTP. Two operators at once
lose one delta, silently. There is no history and no derivation — which is why
the 400 **can be measured and never attributed. That unfalsifiability is worse
than the 400**, and it is the argument for doing this rather than deferring it
again.

The same quantity is already held correctly twice: per-custodian in
`cash_locations` plus the operational tables, and in the ledger on `1000.xx`.
`custodian_held_operational` reconciles those two at 0.00. The scalar is the
only one of the three that is wrong.

1. **Add `cash_in_hand(p_company_id)`** — Σ over the `1000` subtree via
   `trial_balance_for`. A reading, not a computation.
2. **Measure every company's divergence and record it. Do not skip this.** It is
   the only chance to see how long this has been drifting. GGS is +400 today;
   the others are unmeasured. This step changes nothing.
3. **Repoint the readers**, starting at `CashCustody.tsx:340`. The
   `custodyRecon` footer then compares two figures derived from the same ledger,
   so it goes to zero and stays there — and if it moves again it means a real
   posting problem, not a lost HTTP write.
4. **Stop writing the scalar** as each action moves into an RPC.
5. **Drop `treasury.cash_balance`** once nothing reads it — the discipline
   `0280` used on the opening columns. A column kept "just in case" is a column
   something starts writing again.

**Step 3 waits for the opening batch.** `custodian_held_operational` includes
`cash_locations.opening_balance`; the ledger subtree does not until the opening
batch is posted. GGS's difference between the two is exactly Gul Rehman's 890
opening, and that batch is unposted. Waiting is cleaner than making
`cash_in_hand()` add openings explicitly, and it is the same figure the opening
balances work is already blocked on.

---

# Also fixed: month pickers offering months that cannot exist

Period Close offered months back to **March 2025** on a ledger that starts
**August 2026** — sixteen months that cannot hold anything, on the one screen
whose job is to say which months are settled.

**They did not share a source.** Three independent copies of the same
`for (let i = 0; i < 18; i++)` loop: `PeriodClose.tsx:35`, `Accounting.tsx:218`,
`Expenses.tsx:668` — the last two byte-identical. Two other pickers,
`Invoices.tsx:284` and CashCustody's `ledgerMonthOptions`, already derive their
months from the rows they show and were already correct.

All three now use `src/app/lib/monthRange.ts`, bounded by **the earliest posted
journal entry**, falling back to the company's `created_at`, falling back to the
current month.

Not the opening batch date: GGS has not posted one, so that bound would be null
exactly where it is needed, and a company can post before it seeds openings. Not
`created_at` as the primary rule either — GGS was created in May and its books
start in August, which would offer three empty months — but it is the fallback,
because a company with nothing posted still needs a picker that renders.

On GGS this takes Period Close from 18 months to **2** (August and September
2026).
