# G0.1 — Which paths write `journal_lines` in a closed period

Report only. Nothing changed. Every result below has a control in the same
transaction proving the mechanism was engaged.

---

## 0. First, a retraction

**My earlier finding — "the period lock does not protect `journal_lines`, a
balanced restatement of a closed month commits" — was produced inside the
maintenance escape hatch and is wrong as stated.**

That probe opened with `perform set_config('app.ledger_maintenance', 'on', true)`,
copied from `period_lock.sql`'s preamble without noticing what it does.
`is_maintenance_session()` requires *both* that GUC and a `session_user` holding
`rolsuper` or `rolbypassrls`; the probe ran as `postgres`, so both held. I then
reported the documented escape hatch as a hole.

The control I ran did not catch it, and the reason is worth recording: my
control was "`journal_entries` UPDATE is refused", which passed — but it passed
because `enforce_period_lock` **does not honour maintenance mode**, while
`enforce_journal_immutable` **does**. Two triggers, two different gates. A
control that exercises a different trigger from the one under test is not a
control.

`journal_lines` has `trg_journal_lines_immutable` (BEFORE DELETE/UPDATE). Re-run
with `ledger_maintenance` off, as a real `authenticated` tenant user:

```
is_maintenance_session = false
CTRL-A  line UPDATE, period OPEN    : refused ("Posted journal rows are immutable")
CTRL-B  header INSERT, month CLOSED : refused ("Period for 2026-06-04 is closed")
T1      line UPDATE, month CLOSED   : refused ("Posted journal rows are immutable")
```

UPDATE and DELETE on `journal_lines` are blocked in any normal session, in any
period. The restatement I described is not possible.

---

## 1. The real hole: INSERT is guarded by nothing

`enforce_journal_immutable` is attached **BEFORE DELETE OR UPDATE**. It says
nothing about INSERT, and `enforce_period_lock` is not attached to
`journal_lines` at all. So new lines can be appended to an already-posted entry.

Verified as a real `authenticated` user of the company, both controls firing:

```
CTRL1 line UPDATE                        : refused (immutability engaged)
CTRL2 header INSERT in closed month      : refused (period lock engaged)
TEST  append balanced pair to a POSTED
      entry in a CLOSED month            : ACCEPTED
      entry debits 48,533.00 -> 53,533.00
```

Balanced, so `assert_journal_balanced` has nothing to say; survives
`set constraints all immediate`, so it is what a real COMMIT gives.

**Reachability is direct, not theoretical.** `authenticated` holds
`INSERT` on `journal_lines`, and the `via_entry` RLS policy permits any row
whose entry belongs to `current_company_id()`. Any logged-in user can append
lines to any posted entry of their own company, in any period.

Note this is not only a period-lock gap. Appending to a **posted** entry defeats
immutability in an open period too — the trigger blocks the two verbs that
rewrite history and leaves open the one that adds to it.

### Magnitude

**Zero rupees today.** `accounting_periods` is empty on both environments, and
no evidence of appended lines: every `journal_entries` row's line set matches
what its posting produced. It becomes live at the first close, and the
open-period half is live now.

---

## 2. The four paths

### Q1 — `post_journal` writing new lines: unreachable in a closed period ✓

Confirmed as predicted. `post_journal` inserts the `journal_entries` header on
the first line of the loop, *before* the first `journal_lines` insert, so the
header's period lock fires first and the statement aborts.

```
CTRL post_journal, OPEN period   : posted
Q1   post_journal, CLOSED period : refused ("Period for 2026-06-06 is closed")
Q1   orphan lines written        : 0
```

The control matters: without it, "refused" would be indistinguishable from
`post_journal` being broken. No carve-out is needed here and no line can be
orphaned.

### Q2 — `reverse_journal_for_source`: the second defect, confirmed, and worse than expected

**Every caller reverses at the ORIGINAL date.** Read from the catalogue, not
sampled — 12 trigger functions across 11 source tables, plus two RPCs:

| caller | date passed to the reversal |
|---|---|
| `journal_on_invoice` | `coalesce(old.period_start, old.invoice_date)` |
| `journal_on_payslip` | `old.period_month` (and `old.disbursed_at` for disbursement) |
| `journal_on_invoice_payment` | `old.payment_date` |
| `journal_on_expense` | `old.expense_date` |
| `journal_on_advance` | `old.advance_date` |
| `journal_on_cheque` | `old.cheque_date` |
| `journal_on_cash_deposit` | `old.deposit_date` |
| `journal_on_custody_transfer` | `old.date` |
| `journal_on_fixed_asset` | `old.acquisition_date` |
| `journal_on_interregion` | `old.txn_date` |
| `journal_on_partner_entry` | `old.date` |
| `journal_on_expense_settlement` | `coalesce(old.paid_at::date, old.expense_date)` |
| `repost_payslip_accruals_for_month` | `p_period_month` |
| `run_ho_cost_allocation` | month-end of the target month |
| `accrue_bonus_reserve` | `v_end` |

**Not one reverses in the current period.** This is the defect predicted in
G0.1: reverse-and-repost at the original date is a restatement of a closed month
by another name.

Today it does not silently restate — it fails:

```
Q2a reverse at ORIGINAL closed date : refused ("Period for 2026-06-01 is closed")
```

So the repost paths abort rather than rewrite. That is the correct outcome
reached by the wrong mechanism, and it is exactly the shape already named once
in this project: **a downstream lock refusing what an upstream path should never
have attempted is not a policy, it is a worse error message.**

### Q2b — the correct behaviour is currently impossible

The policy in G0.1 is that a correction posts a reversal in the **current** open
period. That does not work either:

```
Q2b reverse at CURRENT open date : refused ("Posted journal rows are immutable")
```

`reverse_journal_for_source` ends with:

```sql
update public.journal_entries set status = 'reversed' where id = v_entry.id;
```

`enforce_journal_immutable` is BEFORE UPDATE on `journal_entries` and refuses
every update outside a maintenance session — regardless of period. **A posted
entry cannot be marked reversed by any normal caller, so it cannot be reversed
at all.**

### Q3 — the repost paths, and a blocking consequence

The same mechanism means **editing a posted financial document fails today, in
an open period, with no period ever closed.** Verified as a normal
`authenticated` user, control first:

```
closed periods for this company           : 0
CTRL entries posted on invoice INSERT     : 1
TEST edit that invoice in the OPEN month  : REFUSED ("Posted journal rows are immutable")
```

Creating works. Editing does not. This applies to all 11 source tables above,
since every one routes through `reverse_journal_for_source`.

**Magnitude: zero rupees, and it blocks normal operation from the first day of
go-live.** No user has hit it because the two live orgs have no invoices,
payslips or journal entries at all — the only financial data anywhere is
SANDBOX TESTING ORG. That is timing, not safety.

### Q4 — `is_maintenance_session()`: correct, and the only escape hatch

```sql
select coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
   and exists (select 1 from pg_roles
                where rolname = session_user and (rolsuper or rolbypassrls));
```

`session_user`, deliberately and correctly — the comment in the function says
SECURITY DEFINER rewrites `current_user`, which is the same trap that made
0242's guard a no-op. An app role reaching this through a definer function does
not pass. Both conditions are required. This is the right shape and needs no
change.

It is also what my first probe accidentally entered, which is the strongest
argument for the standing rule: **a control must exercise the same mechanism as
the test.**

---

## 3. What this means for the fix

The user's instruction was: if a repost path genuinely needs to write a closed
period, fix it at the source rather than granting a carve-out. **No path needs
it.** But three things must be fixed together, and the order matters:

**A. `journal_lines` INSERT must be guarded.** Resolve the period through
`journal_entry_id -> journal_entries.entry_date`. This is the G0.1 fix as
specified. It closes the append hole for both closed periods and — separately —
appending to posted entries.

**B. Reversals must post in the current period.** Every one of the 15 call sites
passes an original date. The reversal entry's date should be the current date
(or the first day of the current open period); the *reversed* entry keeps its
own date, which is what makes the audit trail readable.

**C. `reverse_journal_for_source` must be able to mark the original reversed.**
This is the blocker for A and B both, and it is a genuine design question rather
than a bug with an obvious fix, so I am not choosing:

* narrow the immutability trigger to permit `status` transitioning
  `posted -> reversed` and nothing else, leaving every other column and every
  other transition immutable; **or**
* stop mutating the original altogether and derive "is reversed" from the
  existence of a reversal row — `reversal_of_entry_id` already exists and is
  already populated, so the data is there and the `status` column is redundant.

The second is cleaner and matches double-entry practice, where a reversed entry
is not altered but answered. It is also the larger change, since anything
reading `journal_entries.status = 'reversed'` would need to move to the derived
form. I have not audited those readers yet.

**Do not fix B before C**, or every repost path starts failing on the status
update instead of the period lock — the same class of error-message shuffle
already identified.

---

## 4. Ordering note

A is the narrow security fix and is independent. B and C are a posting-rules
change to the finance path and need the same report-then-approve cycle 0237 had.
G0.1 as written asks for A; B and C are what the investigation found underneath
it, and they block Period Close and F4 more directly than A does.
