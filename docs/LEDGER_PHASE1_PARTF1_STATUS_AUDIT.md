# Part F1 — Attendance status audit (report only)

**Date:** 2026-08-29
**Live org:** `GUARDS AND GUIDES (PVT) LTD`
**Status:** Report only. Nothing changed. No migration written.

---

## F1.1 — Every distinct status value, per org

| Org | Status | Rows | NULL client | First seen | Last seen |
|---|---|---|---|---|---|
| GUARDS AND GUIDES (PVT) LTD | `Present` | 19,064 | 730 | 2026-04-01 | **2026-07-24** |
| | `present` | 13,334 | 302 | 2026-06-01 | 2026-08-29 |
| | `Leave` | 2,998 | 25 | 2026-04-16 | 2026-08-29 |
| | `Absent` | 729 | 3 | 2026-04-28 | **2026-07-15** |
| | `double_duty` | 268 | 0 | 2026-07-24 | 2026-08-28 |
| | `absent` | 223 | 1 | 2026-07-26 | 2026-08-29 |
| | `blocked` | 24 | 0 | 2026-07-01 | 2026-07-24 |
| guards n guides (clone) | `present` | 2,230 | 113 | 2026-08-01 | 2026-08-13 |
| | `Leave` | 200 | 4 | 2026-08-01 | 2026-08-13 |
| | `absent` | 10 | 0 | 2026-08-01 | 2026-08-10 |
| SANDBOX TESTING ORG | `present` | 4,705 | 421 | 2026-06-01 | 2026-08-28 |
| | `double_duty` | 470 | 55 | 2026-06-01 | 2026-08-28 |
| | `absent` | 155 | 48 | 2026-06-01 | 2026-08-28 |
| | `Leave` | 151 | 0 | 2026-06-07 | 2026-08-19 |
| | `rest_day` | 146 | 0 | 2026-06-14 | 2026-08-14 |
| | `rotation_leave` | 113 | 61 | 2026-06-01 | 2026-08-28 |
| | `Present` | 93 | 93 | 2026-07-01 | 2026-07-31 |
| | `relief_cover` | 2 | 2 | 2026-08-21 | 2026-08-21 |

**Ten distinct values.** The four named in the brief were not the whole set:
`Leave`, `rest_day`, `rotation_leave`, `double_duty`, `relief_cover` and `blocked` also occur.
No `leave` (lowercase) row exists anywhere.

### The schema sanctions the duplication

```
attendance_records_status_check
  CHECK (status = ANY (ARRAY['Present','Absent','Leave','present','absent',
                             'rotation_leave','rest_day','double_duty',
                             'relief_cover','blocked']))
```

Both casings are explicitly whitelisted. This is not drift past a constraint — it is a
constraint that was widened to admit two vocabularies rather than pick one.

### Why there are two vocabularies

Two writers, two eras:

- **`AttendanceManagement.tsx`** (legacy) — `STATUSES = ["Present","Absent","Leave"]`,
  typed by `AttendanceStatus = "Present" | "Absent" | "Leave"` at
  [supabase.ts:1480](../src/app/lib/supabase.ts#L1480). Writes capitalised.
- **`AttendanceBoard.tsx`** / **`BulkMarkByEmployeeModal.tsx`** / **`AttendanceSheetModal.tsx`**
  (the spec vocabulary) — write lowercase `present` / `absent` / `double_duty` /
  `relief_cover` / `rest_day` / `blocked`.

The date ranges confirm the handover: `Present` stops on **2026-07-24**, `Absent` on
**2026-07-15**, and everything after is lowercase. The legacy page is effectively retired
but its 19,793 rows remain.

`Leave` is the deliberate exception — migration `0141_fold_rotation_leave_into_leave`
made capitalised `Leave` the canonical fold target, and both new writers honour it
([AttendanceBoard.tsx:1134](../src/app/pages/super-admin/AttendanceBoard.tsx#L1134),
[BulkMarkByEmployeeModal.tsx:457](../src/app/components/BulkMarkByEmployeeModal.tsx#L457)).
That is why no lowercase `leave` exists.

---

## F1.2 — Every exact-string comparison against `status`

### Database — WRONG today (case-sensitive, misses live rows)

| # | Object | Predicate | Sees | Misses | Effect |
|---|---|---|---|---|---|
| 1 | `attendance_records_enforce_reliever` (trigger fn) | `new.status = 'Present'` | capitalised only | every lowercase mark | A reliever marked via the Board takes the `<> 'Present'` branch and has `worked_for_client_id` **silently set to NULL** instead of being required. |
| 2 | `avg_deployed_guards` | `a.status = 'Present'` | 19,064 | 13,615 | Counts **19,064 of 32,679** working rows — understates average deployed guards by **41.7%**. Feeds regional P&L and the danger bands. |
| 3 | `accrue_attendance_bonuses` | `a.status = 'Absent'` | 729 | 223 | Disqualification misses lowercase absences: **63 employees** who were absent still qualify for the attendance bonus. |
| 4 | `attendance_billing_suggestion` | `a.status = 'present'` | 13,347 | 19,064 | Counts **13,347 of 32,411** present-days — understates the suggested billing figure by **58.8%**. |
| 5 | `attendance_leave_history` | `status = 'Leave'` | 3,349 | 0 | **Correct today only by luck** — no lowercase `leave` row exists. Breaks the moment one is written. |

### Database — already correct (normalise with `lower()`)

`attendance_billable_quantity`, `attendance_payroll`, `client_statement_loaded`,
`payroll_cash_by_client`, `payroll_cost_by_client`, `payslip_client_split`,
`record_separation`, and the view `v_client_billing_reconciliation`.

**The money path is clean.** Every function feeding the ledger, payroll split and client
statement already does `lower(status) in ('present','double_duty','relief_cover')`.
The five defects above sit in *operational* reporting, bonus accrual and the reliever
trigger — not in the posting rules. That is why the ledger figures held up under Part D.

### Application code

| Vocabulary | Files |
|---|---|
| **Capitalised only** | `AttendanceManagement.tsx` (225–227, 406–407, 518, 547, 558, 704, 729, 847–849, 1209, 1515, 1542, 1737), `Dashboard.tsx` (301, 320–322), `supabase.ts:1480` (`AttendanceStatus` type) |
| **Lowercase only** | `attendanceSheet.ts` (30–33), `tone.ts` (112–127), `PayrollManagement.tsx` (325–327), `AttendanceBoard.tsx`, `BulkMarkByEmployeeModal.tsx`, `AttendanceSheetModal.tsx` |
| **Both, in one file** | `AttendanceManagement.tsx` — lines 225–227 read `"Present"`, lines 954–957 read `"present"`. The same page counts one vocabulary in its summary and renders the other in its sheet. |

Two consequences worth naming:

- **`Dashboard.tsx:301`** — the headline present-count is capitalised-only, so it has
  read **0 present** for every day since 2026-07-24.
- **`AttendanceManagement.tsx:518/547/558`** — the client-side reliever guard also tests
  `status === "Present"`, mirroring defect #1. Fixing the trigger alone leaves this.

---

## F1.3 — Proposed canonical form

**Lowercase spec vocabulary.** The evidence is one-sided:

- it is the only form the three *active* writers emit;
- it is already the form of `double_duty`, `relief_cover`, `rest_day`, `blocked`, `rotation_leave`;
- every money-path function already `lower()`s to reach it;
- capitalised writes stopped over a month ago.

### Rows moving

| Org | `Present` → `present` | `Absent` → `absent` | Total |
|---|---|---|---|
| GUARDS AND GUIDES (PVT) LTD | 19,064 | 729 | **19,793** |
| SANDBOX TESTING ORG | 93 | 0 | 93 |
| guards n guides (clone) | 0 | 0 | 0 |
| **All orgs** | **19,157** | **729** | **19,886** |

### `Leave` — I am not deciding this one

Folding `Leave` → `leave` moves a further **3,349 rows** (2,998 live + 200 clone + 151 sandbox)
but it is not a casing fix, it is a vocabulary decision, and it collides with something:
migration 0141 made capitalised `Leave` the deliberate canonical target that `rotation_leave`
folds *into* — yet 113 `rotation_leave` rows survive in the sandbox. So there are arguably
three leave tokens, not two.

**Question 1.** Three options, and I would not pick between them without you:
(a) leave `Leave` capitalised as 0141 intended and accept one exception to the casing rule;
(b) rename to `leave` and fold `rotation_leave` into it as well (3,462 rows, and 0141's
intent is preserved under a new spelling);
(c) make `rotation_leave` canonical and drop `Leave` entirely.
My preference is **(b)** — one token, consistent casing, 0141's fold honoured — but it
changes what two writers emit and what four readers match, so it is your call.

---

## F1.4 — Preventing recurrence: CHECK, not enum

**Recommendation: keep a CHECK constraint, tightened to the canonical set.**

An enum is stricter, but:

- values cannot be *removed* from a PG enum — the whole point here is retiring `Present`,
  and an enum would make that a type-rebuild, not a one-line change;
- the column is `text` today and is compared with `lower()` in eight functions; converting
  to enum forces `::text` casts through all of them for no gain;
- adding a status later (`suspended`, `training`) is `ALTER TABLE ... DROP/ADD CONSTRAINT`
  versus `ALTER TYPE`, and only the former composes with the existing migration style.

The CHECK also already exists — the fix is to *narrow* it, not introduce a mechanism.

The real recurrence guard is not the constraint but **`supabase.ts:1480`**: while
`AttendanceStatus = "Present" | "Absent" | "Leave"` exists, TypeScript actively certifies
the wrong vocabulary. That type should become the canonical union so the compiler rejects
the next capitalised write.

---

## F1.5 — Re-running the reliever logic against normalised data

### Rows that change client attribution: **0**

| Org | Reliever rows | Status | NULL client |
|---|---|---|---|
| GUARDS AND GUIDES (PVT) LTD | 57 | `Present` | **57 (100%)** |
| | 3 | `Absent` | 3 |
| SANDBOX TESTING ORG | 139 | `present` | **139 (100%)** |
| | 20 | `rotation_leave` | 20 |
| | 18 | `absent` | 18 |
| | 12 | `double_duty` | **12 (100%)** |
| | 2 | `relief_cover` | **2 (100%)** |

Nothing changes because **every reliever row in every org already has
`worked_for_client_id` NULL.** There is no attribution left to lose — the trigger has
already erased all of it. 60 live rows are recoverable (F2), 173 sandbox rows are not.

### The sandbox is the proof of defect #1

139 `present` + 12 `double_duty` + 2 `relief_cover` reliever rows, **100% NULL client**.
These were written by the Board in lowercase, took the `<> 'Present'` branch, and were
silently nulled. The `raise exception` that was supposed to *demand* a client never fired
once. Live has no lowercase reliever rows only because relievers there were last marked
on the legacy page.

### Correcting my earlier report

In the Part E document I called the case duplication *the mechanism* of the reliever bug
in the live org. That was too strong. The live org's 60 reliever rows are all `Present`
(capitalised) — the lowercase branch never touched them, so something else nulled them
(both employees' rows are April-only and both retain a `client_id` pointer, which is why
all 60 remain backfillable). The lowercase branch is demonstrably the mechanism **in the
sandbox**, and is the latent mechanism for the live org the next time a reliever is marked
on the Board. The defect is real; my attribution of the live-org rows to it was not.

### Rupee magnitude: **Rs 0**

There are **zero payslips for any reliever in any org**. No payroll cost has ever been
misattributed by this defect. Its cost to date is nil; its cost begins the first time a
reliever is paid.

---

## F1.6 — The normalisation UPDATE will be rejected on 1,739 rows

This is the finding that changes how F1.3 gets implemented. `attendance_records` carries
**eight** BEFORE triggers, five of which fire on UPDATE. A bulk `update ... set status = lower(status)`
runs every one of them, and the status *is* changing, so none of their no-op fast-paths apply.

Against the 19,793 live rows to be normalised:

| Blocker | Rows | Bypass available? |
|---|---|---|
| `enforce_attendance_backfill` — service-window hard bound | **1,304** | **No.** The `app.skip_attendance_lock` escape returns *after* the hard bound check. |
| `enforce_confirmed_month_end_lock` | 435 | Only per-row `supervisor_override = true`. |
| `enforce_attendance_month_lock` — OPS verification | 429 | Only by un-verifying the month. |
| **Union (not additive)** | **1,739** | |

The 1,304 service-window failures are guards whose attendance sits outside their current
join/exit or contract window — mostly separated staff. That check has *no* bypass by
design, so a naive normalisation aborts on the first such row and rolls back all 19,793.

**Question 2.** How do you want the normalisation to pass these gates? The options are:
(a) `alter table ... disable trigger` for the duration of the migration — clean, but it
suspends the OPS-verification and confirmation locks for the whole table while it runs;
(b) extend `is_ledger_maintenance()` (0220) to cover these attendance triggers, so the same
role-gated flag that authorises journal maintenance authorises this — consistent with the
protocol already in place, and the flag can never be satisfied by an app role;
(c) narrow each trigger's fast-path to ignore an update that changes *only* the casing of
`status` — the smallest permanent change, and it makes any future normalisation safe.

I recommend **(b)**, because the precedent exists, it is role-gated rather than a blanket
suspension, and it leaves the locks intact for everyone else. It is a policy question about
the attendance locks, not an accounting one, so I am asking rather than choosing.

---

## Summary of what F1 found

- **Ten** status values, not four. The CHECK constraint whitelists both vocabularies.
- **Five** case-sensitive DB comparisons are wrong; one more is correct only by luck.
- **The money path is already case-insensitive** — the ledger, payroll split and client
  statement were never affected. The damage is in operational reporting, bonus accrual and
  the reliever trigger.
- Largest measurable distortions: **avg deployed guards understated 41.7%**, **billing
  suggestion understated 58.8%**, **63 employees wrongly bonus-eligible**, **dashboard
  present-count reading 0 since 2026-07-24**.
- Reliever defect rupee magnitude to date: **Rs 0** (no reliever has ever been paid).
- The normalisation itself is blocked on **1,739 rows** by three attendance locks.

**Three decisions needed before F1.3 is written:** the `Leave` question (F1.3),
the lock-bypass mechanism (F1.6), and — carried over from F2 — what `blocked` means.
