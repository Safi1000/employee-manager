# C — Audit before deriving `reversed` from `reversal_of_entry_id`

Report only, items 1–4 as asked. Nothing changed.

**Headline: the true size is two call sites, and one of them is already
wrong by 2,582,280 with the sign inverted.**

---

## 1. Every reader of `status = 'reversed'`

Searched functions, views, materialised views, RLS policies, constraints,
indexes, the frontend, Edge Functions and the test suites.

| surface | readers of the literal `'reversed'` |
|---|---|
| database functions | **1 — and it is the WRITER**, `reverse_journal_for_source` |
| views / matviews | 0 |
| RLS policies | 0 |
| indexes | 0 |
| check constraints | 1 — `journal_entries_status_chk` |
| frontend (`src/`) | **0** |
| Edge Functions | 0 |
| test suites | 0 |

Every `reversed` in `src/` is UI prose about cheques, expenses, payroll
verification and payment reversal — none touches `journal_entries.status`.

### Readers of `journal_entries.status` at all — the number that matters

16 functions reference `journal_entries`. **Two** filter on its status:

| function | predicate | role |
|---|---|---|
| `ledger_payroll_by_client` | `je.status = 'posted'` | **the only genuine reader** |
| `reverse_journal_for_source` | `je.status = 'posted'` | the writer, choosing what to reverse — and it *already* carries `and not exists (select 1 from journal_entries rev where rev.reversal_of_entry_id = je.id)`, so it is double-guarded and the status half is redundant today |

**The other 14 ignore status entirely** — including `ledger_checks`, `partner_ledger`,
`ho_overhead_for_month`, `region_profit`, `region_operating_profit`,
`region_operating_profit_range`, `region_cash_entitlement`, `reserve_target`,
`trueup_bonus_provision`, `avg_monthly_overhead`. So does the trial-balance UI
in `ChartOfAccounts.tsx`, which joins `journal_lines → journal_entries` and
filters on date only.

That is the correct double-entry behaviour and it is already the majority
behaviour: a reversal is not an erasure, both entries stay, and they net.

### The two representations already agree exactly

| | |
|---|---:|
| entries with `status = 'reversed'` | 98 |
| entries with a row pointing at them via `reversal_of_entry_id` | 98 |
| `reversed` but no reversal row exists | **0** |
| has a reversal row but not marked `reversed` | **0** |

**No data reconciliation is needed.** The derived form is exactly equivalent on
current data, which makes this a pure representation change.

---

## 2. The one reader is already broken — magnitude 2,582,280

`ledger_payroll_by_client` filters `je.status = 'posted'`. That **excludes the
reversed original** and **includes the reversal**, because a reversal row is
itself `status = 'posted'`. It counts one side of a reversing pair.

Measured on the sandbox ledger, `source_table = 'payslips'`, accounts
`cos_payroll` and `opex_office_salaries`:

| | |
|---|---:|
| what the function returns today | **−1,230,566** |
| correct: no status filter, reversals netting against originals | **+1,351,714** |
| cross-check: originals only, reversals and reversed both excluded | **+1,351,714** |
| the 80 orphan reversal rows it counts alone | −2,582,280 |

**Error 2,582,280, and the sign is inverted — it reports payroll cost as
negative.** The two independent correct computations agreeing at 1,351,714 is
what confirms it: reversals exactly offset their originals, so including both or
neither gives the same answer, and including only one gives this.

This matters beyond tidiness. `ledger_payroll_by_client` is the payroll cost
attributed per client, which feeds client Net Cash and therefore partner
remuneration — F4's waterfall.

**Option 2 fixes it by construction.** With nothing marked `reversed`, the
filter has nothing to exclude and both sides are counted.

---

## 3. Is `draft → posted` affected?

**The transition does not exist.** Verified rather than assumed:

| | |
|---|---:|
| functions writing `'draft'` to `journal_entries` | **0** |
| rows with `status = 'draft'` | **0** |
| column default | `'posted'` |
| rows total / `posted` / `reversed` | 307 / 209 / 98 |

`post_journal` and `reverse_journal_for_source` both insert `'posted'` directly.
Nothing ever creates a draft journal entry.

**And it could not work if it did.** `enforce_journal_immutable` refuses every
UPDATE on `journal_entries` outside a maintenance session, so a draft entry
could never be promoted to posted. The CHECK constraint permits a state the
system can neither create nor leave.

So C does not affect posting. But the answer to "is `draft` real?" is no, and
keeping it in the CHECK preserves a value that is unreachable by design. Flagged
for your call — G0.1 item 4 said `status` keeps draft and posted, and I have not
changed that.

---

## 4. How `reversed` should be expressed afterwards

**Recommendation: express it nowhere by default, and delete both predicates.**

The evidence points at this rather than at a helper. Fourteen of sixteen
functions and the entire frontend already ignore status, and that is *correct* —
in double entry a reversed entry is answered, not hidden, and every aggregate
should see both sides. Introducing a helper or a view column invites the two
remaining sites to keep filtering, which is what produced the 2,582,280 error.

Concretely:

* `ledger_payroll_by_client` — **drop the status filter.** No replacement. This
  is also the fix for §2.
* `reverse_journal_for_source` — **drop `je.status = 'posted'`** and keep the
  `not exists (... reversal_of_entry_id = je.id)` clause it already has. That
  clause is the derived form, already written, already correct.

If a UI later needs to *badge* an entry as reversed, add it then as a column on
a view over `journal_entries`:

```sql
exists (select 1 from journal_entries r where r.reversal_of_entry_id = je.id) as is_reversed
```

One form, one place, used for display only and never in a sum. Recorded here so
nobody reintroduces the status write to satisfy a badge.

**Consistency ruling, since you said it matters more than which:** the canonical
expression of "this entry was reversed" is
`exists (select 1 from journal_entries r where r.reversal_of_entry_id = <entry>)`.
Not a helper function — a per-row STABLE function called inside an aggregate is
a performance trap, and there are too few sites to justify one.

---

## 5. Implementation note for when C is authorised

Backfilling the 98 `reversed` rows to `posted` is an UPDATE on
`journal_entries`, which `enforce_journal_immutable` refuses. **It must run
under a maintenance session** — `app.ledger_maintenance = 'on'` with a
super/bypassrls `session_user`. That is exactly what the escape hatch is for and
it is the correct use of it, but the migration must set it explicitly and unset
it afterwards, and say so in its header.

Order within C:

1. Drop the status filter from `ledger_payroll_by_client` (fixes §2 on its own,
   independent of everything else).
2. Drop the status write from `reverse_journal_for_source` and the redundant
   `status = 'posted'` from its selection.
3. Backfill 98 rows `reversed → posted` under a maintenance session.
4. Narrow `journal_entries_status_chk` to remove `'reversed'`.

Step 1 is separable and could ship first — it is a live 2.58m reporting defect
with no dependency on the rest.
