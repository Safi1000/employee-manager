# Bastion — working rules

## Branches

**All work goes on `main`.** There is no `dev` branch — it was deleted on
2026-09-02 after `main` was brought level with it. Commits, migrations, docs:
`main`.

Note what this did *not* change, because the two things are named the same and
are not the same thing:

- The **git branch** `dev` is gone.
- The **Supabase project** `crm-design-dev` (`wlyhbvunvdsropqzlpwx`) is not.
  Migrations still apply there first and reach production only on named
  authorisation. The deployment discipline below is untouched.

`scripts/check-migrations.mjs` has no git-branch logic at all — its repo side
reads `supabase/migrations/` off the working tree, and every `dev` in that file
means the **database** environment. Do not rename them.

## Databases: two projects, and only one of them is yours to write

| Role | Supabase project | Project ref | Loaded by |
|------|------------------|-------------|-----------|
| **PRODUCTION** | `crm-design` | `mmkfpnshxjcyijhuydgr` | `.env.local` → `npm run build` |
| **DEVELOPMENT** | `crm-design-dev` | `wlyhbvunvdsropqzlpwx` | `.env.development.local` → `npm run dev` |

**write in PROD unless you are asked to write in dev.**

This applies to every write channel without exception: `apply_migration`,
`execute_sql`, the Supabase SQL editor, a psql session, a script. A migration
that has been reviewed and is obviously correct is still a prod write.

Both refs are named here because "prod" and "dev" are not distinguishable at the
call site. An MCP tool takes `project_id`, not a nickname, and
`mmkfpnshxjcyijhuydgr` next to `wlyhbvunvdsropqzlpwx` is one glance away from
being the same string. Before any write, read the ref back off the call and
match it against this table.

### The exception, and its shape

A prod write requires the user to authorise **that specific change, by name, in
that message**. Not "go ahead", not authorisation carried forward from an
earlier prod task in the same session, not a general approval of the plan the
change belongs to.

An authorisation that qualifies looks like this one, which is the real example:

> Prod re-apply is APPROVED, named explicitly, this one change only: re-apply
> 0231b to crm-design (mmkfpnshxjcyijhuydgr) so its recorded SQL matches the
> current file. Nothing else on prod.

Note what it contains: the object, the project, the ref, the reason, and a
boundary. Anything short of that is a dev write or a question.

### Prod reads

Reading prod is fine and often necessary — prod is the only database whose state
reflects what customers actually did. Say which database a finding came from
whenever it could be either.

### Credentials

There is **no restricted prod credential**. `.env.local` and
`.env.development.local` carry anon keys only, which cannot read
`supabase_migrations.schema_migrations` at all, so they cannot drive
`scripts/check-migrations.mjs`. Database access in an agent session is the
Supabase MCP server, which is full-access: it can write prod as easily as read
it, and nothing below the discipline in this file stops it.

If a read-only prod service credential is ever issued, put its name here and
point `SUPABASE_PROD_URL` / `SUPABASE_PROD_SERVICE_ROLE_KEY` at it so the
migration checker can run in CI against both environments.

## Migrations

Files live in `supabase/migrations/`, numbered `NNNN[a-z]_name.sql`.

**The recorded SQL must equal the file.** `ledger_checks()` compares digests and
will flag a mismatch. There are no acceptable exceptions — one tolerated
mismatch teaches the next reader that the check is advisory.

Consequences worth stating plainly:

- Applying a migration through the SQL editor records **no** `schema_migrations`
  row on prod. If you do it, backfill the row afterwards via `apply_migration`
  so the SQL travels with it.
- Editing a migration file after it has been applied creates drift. Re-apply it.
- `scripts/check-migrations.mjs` checks **both** directions — repo files with no
  recorded row, and recorded rows with no repo file. The second direction is the
  serious one: something ran against a database that nothing in the repo
  describes.
- `scripts/migration-aliases.txt` maps genuine renames. Adding a pair to silence
  a failure defeats the file's purpose; leave the discrepancy visible instead.

### Number from `max(repo file, recorded name)`, never from the repo alone

`supabase/migrations/` is HALF the ledger. The other half is
`supabase_migrations.schema_migrations`, which is exactly why
`scripts/check-migrations.mjs` reads both directions.

Numbering a new migration from the highest file in a `git`-stale working tree
produced two collisions in one sitting: `0364` and `0365` each named two
different migrations, because another session had applied — and pushed — through
0365 while this tree sat twelve commits behind. The database knew. The tree did
not.

Before choosing a number:

```sql
select name from supabase_migrations.schema_migrations order by version desc limit 5;
```

and `git fetch` first. Take the higher of the two maxima.

**A collision is repaired by renaming the FILE and never by editing its
contents.** The recorded SQL must equal the file, and the numeric prefix is not
part of the recorded name — `migration_ledger_drift()` strips `^\d{4}[a-z]?_`
from both sides before comparing. So a renamed file still matches its recorded
row, while rewriting the `NNNN` inside the header to agree with the new filename
would break the digest for a migration that has already run.

The consequence is a file whose header cites a number the filename no longer
carries. That is ugly and it is correct. It is also why the number should be
right the first time.

### Guards must test the condition they mean

A guard that compares `max(schema_migrations.version)` against a string literal
is a proxy, not a test. Two migrations (`0224b`, `0231b`) shipped with exactly
that and were correct on prod only by accident — prod's versions are timestamps,
so `'2' > '0'` returned early for the wrong reason. Both now test a real marker:
does the column/function that the later migration creates or drops exist?

### A set operation is not safe to convert to SECURITY INVOKER

Converting a `SECURITY DEFINER` function to `SECURITY INVOKER` is the cleanest
way to restore RLS to a body that was bypassing it — the policy is restated
nowhere and cannot drift. **It is safe for a single-row operation and unsafe for
a set one, and the difference does not show up in the syntax.**

- **Single row.** `update t set … where id = $1` under RLS affects zero rows
  when the policy hides the row. With the row-count assert this project already
  requires, the caller is **refused**. A refusal is a control.
- **A set.** `update t set … where run_id = $1` under RLS simply touches fewer
  rows. The function returns a smaller count, reports success, and the work
  looks done. **An unauthorised act becomes a silently smaller result** — a
  defect wearing success's clothes, which is the failure mode this project
  exists to remove.

So: **anything processing a set behind a permission boundary must be checked
for this before conversion.** If the write touches N rows chosen by a
predicate rather than one row named by an id, invoker is the wrong instrument;
keep the definer body and assert the boundary inside it.

Found on `disburse_payroll_run` and `payroll_run_attach` (0377), which were in
0376's conversion list and were pulled out of it; then again on
`reassign_client_employee_codes` and `run_appreciation` (0379), which are not
detected at all because they write nothing directly. There will be others.

This is deliberately **not** automated. Whether a write is "a set" is a
judgement about intent — `where id = $1` and `where run_id = $1` are the same
shape — and a checker that guessed would be advisory, which is the one thing
this file does not tolerate. It is stated here, in
`scripts/migration-template.sql`, and on `branch_guard_gaps()` itself.

### Converting a child does not close its definer parents

`CURRENT_USER` inside a `SECURITY DEFINER` body is the function's **owner**. A
child converted to invoker, called from a definer parent, still runs with the
parent's privileges and still bypasses RLS. Conversion closes the direct path
and nothing above it.

This makes `branch_guard_gaps()`'s transitive blindness an **enforcement** gap
and not only a detection one: it reads one body at a time, so a parent that
writes nothing itself and delegates every write to a child is invisible to it
and is exactly as open as the child used to be. After converting anything, list
the definer functions whose source names it, and treat each as its own case.

A definer **trigger** parent is the exception and is left alone: it fires inside
a statement the caller already passed RLS to make, which is why permission gates
in this codebase skip themselves at `pg_trigger_depth() > 0`.

### Idempotency is a property of the whole migration

`add column if not exists` on every DDL statement is not enough. `0232` would
have aborted at an **assert** two hundred lines above its guarded `drop`,
because the assert read the column the drop removes. Replay the whole file
mentally against an already-migrated database, not just its DDL.

### A function edited by more than one migration has no canonical file

This generalises "never restate `ledger_checks`", and the general form is the
one to remember, because the next function it applies to will not be
`ledger_checks`.

Once two or more migrations have edited a function, **no single file holds its
true text.** Each file holds the text as of the moment it was written. Restating
the function from any of them silently discards every edit made since — and it
*succeeds*, which is what makes it dangerous. Nothing raises, nothing goes red,
and the checks that vanish take their own alarm with them.

- **Edited by many → amend by surgery against the live definition**
  (`pg_get_functiondef`), with an anchor asserted to appear exactly once. If the
  anchor is missing or doubled, refuse; do not widen it until it matches.
- **Edited by exactly one → may be restated**, provided the migration first
  asserts that the body it is replacing is a digest it recognises, and refuses
  anything else. An unrecognised body means a third edit nobody recorded, which
  is precisely the case where restating destroys something.

How this was learned, twice. `0286` and `0288` restated `ledger_checks` from a
copy and dropped two checks; `0318` had to put them back. Then a re-apply of
`0316` to dev — approved, and obviously correct on its face — would have
replaced a 27-check `ledger_checks` with the 9 checks that existed when `0316`
was written, including one added the same afternoon, and reported success with
the canary agreeing with itself at `0316`'s number. `0325` exists because
`run_auto_invoices` is the *other* kind: one author, full text in the repo, so a
restatement behind a digest precondition was safe. `0326` then had to use
surgery, because after `0325` the function has two authors.

## Tests

`supabase/tests/` runs inside a transaction that rolls back via a deliberate
exception. Two rules earned the hard way:

1. **Every harness must prove it ran.** Count executed assertions and compare
   against an expected total, or end with a deliberate failure. A suite whose
   silence cannot distinguish "all passed" from "aborted at test 9" is not a
   harness. `ledger_foundation.sql` sat dead from 0224 onward for exactly this
   reason.
2. **Failure looks like success.** A test asserting on a refusal must assert on
   the refusal's **message**, not on the fact that something raised. Three
   separate tests passed against the wrong trigger before this was enforced.

`ledger_checks()` reports the **count of checks evaluated** alongside failures,
for the same reason.

## Reading versus computing, and the one stated exception

The ledger answers; the frontend reads. A screen that recomputes what a view
already holds is the defect this whole project removed — the Trial Balance
screen pulled 1,304 journal lines and summed them in JavaScript beside a view
that answered in 56 rows, while the check suite read the view.

`trial_balance` (0299, given a period by 0319) and `trial_balance_for` (0320,
which folds branch and period to whatever grain the caller asks for) exist so
that no screen has to add anything up.

**The exception, and it is deliberate: a table's own footer total is computed
in the browser.**

A trial balance footer means "the sum of the column above it". Fetched
separately, it contradicts its own table the moment the row set differs — a
hide-zero filter, a row RLS withheld — and a header figure that disagrees with
the table under it is §9.16, which is worse than the duplication. A footer that
cannot contradict its table has to be folded from the table.

This is the only place arithmetic belongs in a ledger screen. Do not "correct"
it, and do not extend it to anything that is not literally the sum of displayed
rows.

## Accounting policy

Do not invent it. Policy lives in `docs/LEDGER_PHASE1_POSTING_RULES.md` and the
Part A/C answers. Where those are silent, **ask** — a plausible-looking default
becomes precedent the moment it posts.

Two settled points that get re-litigated by accident:

- Revenue is recognised at the **service month** (`period_start`), not
  `invoice_date` (A4).
- HO cost is apportioned by **revenue**, never by guard-days (A10). Regional
  
  with no floor (A9).
