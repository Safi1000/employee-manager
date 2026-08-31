# Vacuous-assertion audit

For every assertion in `ledger_foundation.sql` and `attendance_status.sql`: does
the code path under test actually execute in the session the suite runs in, or
does it short-circuit before reaching the thing being asserted?

Prompted by the `enforce_period_lock` precondition found while writing
`period_lock.sql` — the lock returns early when `current_company_id()` is NULL,
which it is in every service-role session, so all sixteen assertions would have
passed without the lock existing.

**29 assertions audited. 5 defects, in 5 distinct shapes.** Four were in
`attendance_status.sql`; `ledger_foundation.sql` came out clean.

---

## The session these suites run in

| | |
|---|---|
| `session_user` / `current_user` | `postgres` |
| `postgres` | `rolsuper=false`, **`rolbypassrls=true`** |
| `service_role` | `rolsuper=false`, **`rolbypassrls=true`** |
| `auth.uid()` | **NULL** — no JWT |
| `current_company_id()` | **NULL** — it reads `profiles` via `auth.uid()` |
| `is_ssa_unscoped()` | **false** — same reason |

Three consequences, and every finding below is one of them:

1. **Any guard that early-returns on NULL company context does not run.** Across
   the whole schema exactly one does: `enforce_period_lock`. Verified by scanning
   every function body for `current_company_id() is null`.
2. **Every RLS policy is bypassed.** Both usable roles carry `rolbypassrls` and
   no relevant table sets `FORCE ROW LEVEL SECURITY`.
3. **Trigger-enforced rules DO fire** for privileged roles. The period lock,
   journal immutability and the attendance gates are all triggers, so they are
   genuinely testable here.

The rule that falls out: **trigger-enforced rules are testable from these
suites; policy-enforced rules are not, at all, ever.**

---

## `ledger_foundation.sql` — 16 assertions, 0 defects

| Tests | Kind | Verdict |
|---|---|---|
| T1, T2, T3 | expect a raise from `post_journal` / the deferred balance constraint | Sound — no context gate on either |
| T4, T16 | `ledger_checks` over all companies | Sound — takes the company as an argument, no context dependency |
| T5, T6 | expect a raise from `enforce_journal_immutable` | Sound — a trigger, not a policy, so `bypassrls` is irrelevant |
| T7 | expects an **allow** under the maintenance flag | Sound **only** because T5 establishes the same statement is refused without it |
| T8, T10 | catalog queries | Immune |
| T9 | `is_maintenance_session()` with the flag off | Sound |
| T11–T15 | expect journal entries to post | Sound — `journal_on_advance` / `journal_on_payslip` have no context gate |

**T7 is the one worth naming.** An assertion that expects success passes if the
thing succeeds *for any reason*, so on its own it cannot distinguish "the
maintenance flag opened the gate" from "the gate was never closed". It is
rescued by T5: same statement, same session, flag off, refused. The differential
is the test; neither half means much alone. Any future "this is permitted"
assertion needs a paired "and refused without it" or it is decoration.

This suite also already does the thing the other one did not — it asserts its
fixture exists before using it (`No AR account for company % — run
seed_chart_of_accounts() first`). That is the pattern.

---

## `attendance_status.sql` — 13 assertions, 5 defects

### 1. T29 could not fail

```sql
v_results := ... case when v_n >= 1
  then 'T29 residue_is_named  PASS  (' || v_n || ' guard(s))'
  else 'T29 residue_is_named  PASS  (none left)' end
```

**Both branches say PASS.** A print statement wearing a test's name, in the
suite whose entire subject is gate-mode residue.

Replaced with a real biconditional: `attendance_gate_mode_residue()` and
`ledger_checks`' `no_gate_mode_in_attendance_status` are two views of one fact
and must agree — residue present ⇔ that check red. Either direction failing
means one has drifted. Now passes as `(1 residue, red=true)`.

### 2. T31 passed on an UPDATE that touched nothing

T27 and T31 both act on `v_emp` / `v_day` from a `SELECT ... LIMIT 1`. If that
finds no row both are NULL, both UPDATEs match **zero rows**, and no exception
is raised. T27 then reports FAIL — the safe direction. **T31 reports PASS**:
green for an assertion that never ran.

A row exists on dev today, so this was latent rather than active. Fixed two
ways: an explicit `NO FIXTURE` outcome when the SELECT finds nothing, and
`get diagnostics v_n = row_count` so T31 asserts it changed exactly one row.

### 3. T23 contained a dead query that looked like an assertion

Ten lines counting employees absent in lowercase but not uppercase, whose result
was **overwritten by the next statement** before anything read it. It was also
unanswerable by construction — after 0224 the token `'Absent'` does not exist,
so the set is empty regardless of what the predicate does. Deleted; the
structural assertion that was doing the work remains.

### 4. No canary

`ledger_foundation.sql` has one; this suite did not. An abort part-way through
truncated the output silently — precisely the defect the canary was introduced
for after T9 killed the other suite from 0224 onward. Added, `13/13`.

### 5. T21 failed against correct code, because of a comment

The sharpest one. T21 asserts the `continue` that dropped near-zero regions is
gone, by grepping `pg_proc.prosrc`:

```sql
and strpos(p.prosrc, 'continue') = 0
```

0225's rewrite contains:

```
-- No `continue` on zero: a branch that billed nothing reaches zero through
-- the proportion itself, and any shortfall surfaces in the assert
```

**A comment documenting the absence of `continue` reads as its presence.** The
function is correct; the test said FAIL.

This is the session's recurring shape inverted. Everywhere else a test passed
while the code was wrong. Here it failed while the code was right — the variant
that gets a real check deleted for being noisy.

**And it is environment-dependent through comments alone.** The same test, same
day:

| | `strpos(prosrc,'continue')=0` |
|---|---|
| dev | FAIL |
| **prod** | **PASS** |

Both databases hold the *same* `run_ho_cost_allocation` — identical once
comments and whitespace are stripped (`a6a0d2`). Prod simply stores fewer
comments, because prod's copy was applied through the SQL editor and dev's from
the file. A test that greps source is a test of how the code was *deployed*.

Fixed by stripping `--` comments before searching. The one condition that
legitimately targets a comment (`does not exhaust the pool`) still reads raw
`prosrc`, and says so inline.

---

## What cannot be tested from either suite

The attendance SA-lock is enforced by **RLS policies** — `no_modify_sa_locked`
and `no_delete_sa_locked` (0014, 0053) — not triggers. `attendance_records` does
not set `FORCE ROW LEVEL SECURITY`, and both roles these suites can run as carry
`rolbypassrls`. **Those policies cannot be exercised from any session either
file can open.**

Adding an SA-lock assertion here would report PASS with the policies deleted.
This is now recorded in the suite header so nobody adds one. Testing RLS needs
an authenticated non-privileged session — the application, or a harness that
signs a JWT.

The same holds for every RLS policy in the schema. That is a real coverage hole,
not a nitpick: multi-tenant isolation is enforced almost entirely by policies.

---

## Result

| Suite | Assertions | Defects |
|---|---:|---:|
| `ledger_foundation.sql` | 16 | 0 |
| `attendance_status.sql` | 13 | 5 |

`attendance_status.sql` now runs **13/13 PASS with a complete canary** on dev,
where before the fixes it ran 12 with one false failure, one assertion that
could not fail, one that could pass without executing, and no way to detect
truncation.
