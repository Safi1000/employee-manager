# Migration ledger divergence — repo vs database

**Date:** 2026-08-31
**Project:** `crm-design` (`mmkfpnshxjcyijhuydgr`)
**Status:** **Reconciled.** Ten migrations recovered into the repo; a check now guards the loop.

---

## Where migrations are applied (policy, from 2026-09-01) — SUPERSEDED 2026-09-03

> **THIS SECTION IS HISTORY. DO NOT FOLLOW IT.** `crm-design-dev`
> (`wlyhbvunvdsropqzlpwx`) and the `dev` git branch were both retired on
> 2026-09-03. All work is on `main` against `crm-design`
> (`mmkfpnshxjcyijhuydgr`), which is the only database left. See
> **"Dev is retired"** near the foot of this file for what that costs and what
> still needs deciding. The text below is kept because the rest of the document
> reasons about a two-environment world and would be unreadable without it.

**All migrations are applied to `crm-design-dev` FIRST. Nothing goes straight to prod.**

| role | project | ref | evidence |
|---|---|---|---|
| **PROD** | `crm-design` | `mmkfpnshxjcyijhuydgr` | `.env.local` `VITE_SUPABASE_URL` points the app here; 1,149 employees |
| **DEV** | `crm-design-dev` | `wlyhbvunvdsropqzlpwx` | clone taken 2026-08-31; 1,147 employees |

The git branch is `dev` and the database is now `crm-design-dev`; they promote together.

### Why this is written down

Up to 2026-08-31 the G-series went in through the Supabase SQL editor, to both
environments, by hand. That produced three problems at once, and the third is the
one that bites:

1. **No `schema_migrations` row.** `applied_migration_digests()` cannot see a
   single hand-applied migration, so `npm run check:migrations` reports drift on
   all of them and the loop-closer is closing nothing.
2. **Two environments, one memory.** It was not recorded which had received what,
   and recovering it took a schema-object diff rather than a query.
3. **Prod got a PARTIAL subset — the writers without the guards.** It has
   `post_opening_balances`, `record_cash_deposit`, `cash_account_for`; it does NOT
   have 0243/0248/0251 (tenant guard), 0245 (journal_lines insert guard), 0254
   (no-empty-entries), 0255 (journal_lines period lock), 0259 (still the blind
   8-check `ledger_checks`), 0260 (opening-batch gate) or 0261 (partner entry
   audit). Applying only to dev from now on does not close that gap — it freezes
   it. **Prod must be brought up to dev's guard set as its own piece of work.**

No journal data was written to prod: 0 `opening_balance_batches`, and the
fifteenth cash-control line exists only on dev. The divergence is schema-only.

### Running the checker

`scripts/check-migrations.mjs` already handles both environments:

```
npm run check:migrations                 # every configured environment
npm run check:migrations -- --env dev    # one of them
```

It needs `SUPABASE_DEV_URL` / `SUPABASE_DEV_SERVICE_ROLE_KEY` and
`SUPABASE_PROD_URL` / `SUPABASE_PROD_SERVICE_ROLE_KEY`. **`.env.local` currently
sets neither** — it carries only `VITE_SUPABASE_URL` and the anon key — so the
checker skips with a warning and verifies nothing. Configure both before relying
on it.

---

## What was wrong

The database's `supabase_migrations.schema_migrations` held **244 rows**; the repo held
**227 `.sql` files**. My first description of this — "four migrations in the database and
not in the repo" — was wrong twice over: the count was low, and the worst category wasn't
absence at all.

| Problem | Count | Why it mattered |
|---|---|---|
| **Number collisions** | 2 | The same number meant a *different migration* on each side. |
| **Applied but never committed** | 10 | A fresh environment never got them. |
| Naming-convention change mid-project | ~34 | Cosmetic — but it hid the other two. |

---

## 1. The two number collisions

| # | Repo file | Database row | Resolution |
|---|---|---|---|
| **0109** | `0109_fire_clearance_salary_and_attendance_window.sql` | `0109_regional_receivables_and_invoicing` | DB version committed as **`0109b_`** |
| **0152** | `0152_attendance_employment_window.sql` | `0152_display_number_reallocate_and_backfill` | DB version committed as **`0152b_`** |

Both numbers existed on both sides meaning different things. Anyone reasoning about
migration order got a different answer depending on which side they read.

Resolved by giving the database's version a letter suffix rather than renumbering the
existing repo files — the suffix keeps both identities, preserves ordering (`0109b` sorts
before `0110`, which depends on it), and doesn't invalidate anyone's checkout.

`0109b` matters more than it looks: it creates `receivable_owner_region()`,
`invoice_reminders`, `finance_settings.reminder_cadence_days`, `clients.workout_account`
and the `bad_debt_expense` account. The repo had **no** regional-receivables migration at
all, so `0110_writeoff_status_fix` — which I committed in the same pass — would have failed
on a fresh environment without it.

---

## 2. The ten recovered

All committed verbatim, each with a header recording that it was recovered and why.

| File | Note |
|---|---|
| `0109b_regional_receivables_and_invoicing.sql` | §5/§10/§22. Writes invoice status lowercase; 0110 corrects it. Declares `attendance_billing_suggestion` with different OUT names — which is exactly why 0224 needed an explicit `DROP FUNCTION`. |
| `0110_writeoff_status_fix.sql` | Aligns write-off with the capitalised status vocabulary |
| `0111_secure_backup_table.sql` | RLS on an anon-readable backup table — **a security fix that lived only in the database** |
| `0112_employee_physical_copy_present.sql` | Adds `employees.physical_copy_present` |
| `0122b_phase3d_service_history_approval_union.sql` | Adds approval events to `employee_service_history` |
| `0152b_display_number_reallocate_and_backfill.sql` | Contains a one-time data backfill — guarded, but **must not be replayed live** |
| `0182b_drop_change_category_5arg.sql` | Drops a superseded overload |
| `0209` / `0210` / `0214` `_partner_ledger_*.sql` | Three successive repairs, each superseded by the next and finally by repo 0215/0216/0218. Kept for order fidelity. |

**Five of the ten were follow-up patches** to a migration that *is* in the repo. That is the
mechanism, not an accident: they were written in the SQL editor minutes after an apply, at
precisely the moment nobody is thinking about committing a file.

---

## 3. The naming-convention change

Migrations before ~0109 are recorded in the database under their **descriptive name with no
number prefix**:

| Repo file | Database row |
|---|---|
| `0001_init.sql` | `init_employee_manager_schema` |
| `0002_multitenant_redesign.sql` | `multitenant_redesign` |
| `0034_drive_columns_invoices_cheques_expenses.sql` | `drive_columns_for_invoices_cheques_expenses` |

From `0109` onward they carry the number. Names also drifted slightly (`for` inserted,
words reordered), so **the pre-0109 era cannot be mapped 1:1 by name**. 34 such rows remain
unmatched by the strip rule.

That history is not worth reconstructing. It is baselined in
`scripts/migration-baseline.txt` so the check catches *new* drift instead of relitigating
old naming.

---

## 4. The loop-closer

```
npm run check:migrations
```

`scripts/check-migrations.mjs` reads the applied names via
`public.applied_migration_names()` (migration **0227**, service-role only, returns names
not SQL) and fails if the database has applied anything the repo does not carry.

Current state: **OK — all 244 applied migrations accounted for.**

The baseline file carries its own warning: *do not add to this list to silence a failure.*
A new name there means a migration was applied without committing the file, and the fix is
to write the file.

---

## 5. Why the loop-closer did not close the loop, and what runs now

`check:migrations` was written, `scripts/pre-push` was written to run it, and
between them they did not prevent `0237`–`0252` from existing only as
`schema_migrations` rows, or `0240`/`0241` from reaching **production** without a
repo file. Three reasons, all structural rather than accidental:

1. **`core.hooksPath` is per-clone and manual.** A fresh clone has no hook.
2. **The hook skipped itself when the secrets were absent** — deliberately, so it
   would not block work. It therefore never ran.
3. **It runs at push time.** The drift is created by `apply_migration`, often
   hours earlier and in a different session. Push may not happen that day.

What runs now, in the order it fires:

| When | What | Needs secrets? |
|---|---|---|
| the instant `apply_migration` returns | `migration-ledger.mjs record` records the name | no |
| end of session | `migration-ledger.mjs check` blocks while a recorded name has no file | no |
| `git push` | `check:migrations` compares repo against the database | yes — and now **fails** rather than skipping when they are missing |
| `npm install` | `prepare` sets `core.hooksPath`, so a clone arms itself | no |

The first two are the ones that matter, because they need nothing configured and
they fire in the session that created the divergence. The ledger lives at
`.claude/applied-migrations.log`, is gitignored, and prunes each entry as soon as
its file exists — so a session that writes the file before finishing never sees
it.

Note the pre-push check still points at ONE database. Prod is at `0241` and dev
is well past it; a green run against one says nothing about the other.

---

## What was deliberately not done

- **Nothing was replayed against the live database.** Every recovered migration had already
  run there; `0152b` in particular carries a data backfill that must not run twice.
- **No repo file was renumbered.** The suffix approach keeps both identities without
  rewriting history for files that were never wrong.
- **The pre-0109 naming was not reconstructed.** It is baselined instead. If a fresh
  environment is ever needed, a schema baseline dump is the right tool — not migration
  archaeology.

---

# Re-opened, 2026-09-03: four migrations on PRODUCTION with no file in the repo

**Status: RECOVERED AND DIGEST-VERIFIED, 2026-09-03. Four files written from the
recorded SQL; all four md5s match. Nothing was applied to any database and
nothing was deleted.**

Found while wiring the `partnership_posting_day` control, by asking what reads
`partnership_posting_deadline()` — the repo said "nothing", production said
otherwise.

`supabase_migrations.schema_migrations` on `crm-design`
(`mmkfpnshxjcyijhuydgr`) carries four rows above `0359`, the highest file on
`main`:

| version | recorded name | prefix? |
|---|---|---|
| 20260903115952 | `every_reader_takes_the_company_it_was_handed` | **no** |
| 20260903120155 | `the_partnership_run_is_drafted_reviewed_then_posted` | **no** |
| 20260903120338 | `the_posting_deadline_reaches_the_calendar` | **no** |
| 20260903121041 | `the_run_guard_says_out_loud_what_it_checks` | **no** |

The four are bare-named where the recent convention is prefixed. Stated
precisely, because the first version of this note overstated it: prod carries
**190 bare-named rows and 201 prefixed** ones. Bare names are the OLD style —
every row up to `20260828075914` (`partner_ledger_fix_variable_conflict`) is
bare. From `0230` onward the prefix is used without exception, through
`0359_the_regional_pl_...` at `20260903103722`, which is the row immediately
before these four.

So the tell is not "bare names are unheard of". It is that the convention held
for 201 consecutive rows and broke for exactly the four that also have no file
— consistent with `apply_migration` called with a bare name rather than a
migration promoted from the repo, which is the route that leaves no file
behind.

Their own `comment on function` text numbers them **0360–0363**, so the numbers
were chosen; only the files are missing.

## This is the serious direction

`CLAUDE.md` names both directions and says which one matters:

> `scripts/check-migrations.mjs` checks **both** directions — repo files with no
> recorded row, and recorded rows with no repo file. The second direction is the
> serious one: something ran against a database that nothing in the repo
> describes.

This is the second direction, on production, four times.

## What those four actually built

Not trivia — a working subsystem the repo has no record of:

| object | from | what it does |
|---|---|---|
| `draft_profit_allocation` | 0361 | computes a month's run and leaves it DRAFT |
| `post_profit_allocation` | 0361 | posts a draft; refuses if the source data moved since |
| `partnership_deadline_title` | 0362 | the single definition of the calendar row's title |
| `sync_partnership_posting_date` | 0362 | raises/updates/removes the calendar row for a month |
| `clear_partnership_deadline_on_post` | 0362 | removes it again when the run posts, restores it on reversal |
| `invoice_reminder_items` | 0362 | what to remind about today, or nothing |

`run_monthly_ledger_jobs` — cron job 7, `20 2 1 * *` — calls
`sync_partnership_posting_date`. So the compliance-calendar chain is live on
production and has been waiting only on `partnership_posting_day`, which is the
setting this round's control now exposes.

## Consequences, stated plainly

1. ~~**Dev cannot reproduce production.**~~ It could not: `crm-design-dev` had
   none of 0342–0363, its latest recorded row being
   `0341_the_chart_of_accounts_refuses_what_the_dialog_only_discouraged`
   (20260903002600), with no `finance_settings.partnership_posting_day` column
   at all. **Overtaken by events** — dev was retired on 2026-09-03 rather than
   caught up. The dev-first policy was not followed for 0342–0363, and there is
   now no dev to follow it to. See "Dev is retired" below.
2. ~~**A rebuild loses the subsystem.**~~ Was true; **fixed below** — the four
   files are now in `supabase/migrations/`, digest-verified.
3. ~~**`ledger_checks()` digest comparison cannot cover them.**~~ Was true for
   the same reason; **fixed below**. There is now a file to digest against, and
   it matches.

## The recovery, and how it was verified

Done on 2026-09-03. Each file was written from the recorded row's
`array_to_string(statements, E'\n')` and then checked against
`applied_migration_digests()`, which is md5 of exactly that string with `\r`
removed and trailing newlines dropped — the same normalisation
`check-migrations.mjs` applies to the file. A file that hashes differently is a
file that lies about what ran, so the digest was the acceptance test, not a
formality:

| file | recorded digest | file digest | verdict |
|---|---|---|---|
| `0360_every_reader_takes_the_company_it_was_handed.sql` | `b528207d…` | `b528207d…` | match |
| `0361_the_partnership_run_is_drafted_reviewed_then_posted.sql` | `33428171…` | `33428171…` | match |
| `0362_the_posting_deadline_reaches_the_calendar.sql` | `533261ab…` | `533261ab…` | match |
| `0363_the_run_guard_says_out_loud_what_it_checks.sql` | `60790ed7…` | `60790ed7…` | match |

All four matched first time. Had one not, it would have been left unwritten and
reported on its own rather than committed alongside three that were fine.

**Nothing was applied and nothing was renamed.** The recovery is repo-side only.

### The ledger rows still carry their bare names, deliberately

Renaming the four `schema_migrations` rows to `0360_…`–`0363_…` is a **write to
production**, and CLAUDE.md requires that be authorised by name, with the
project and ref, in the message that asks for it. That authorisation has not
been given in that shape, so the rename has not been done.

It is also not needed for the check to pass. `check-migrations.mjs` compares by
`key()`, which strips a leading `NNNN[a-z]_` **from the repo filename** and
leaves the recorded name alone:

- repo `0362_the_posting_deadline_reaches_the_calendar` → key
  `the_posting_deadline_reaches_the_calendar`
- recorded `the_posting_deadline_reaches_the_calendar` → same key

They already pair, in both the count check and the digest check. The rename is
consistency with the 201 prefixed rows around them, not a correctness fix.

## Would the pre-push hook have caught these four? No. Three reasons.

The hook was fixed last round so that a missing credential **blocks** rather
than silently skipping. That fix is right, and it is not what was needed here.

**1. There was no push.** The hook is `pre-push`. `main`'s last commit is
`1b6d1d3` at 2026-09-03 16:12 +0500 (11:12 UTC); the four migrations were
applied between 11:59 and 12:10 UTC — 47 to 58 minutes *after* it, with no
commit and no push following. A pre-push hook cannot fire on a push that never
happens. This is the same mechanism the hook's own header describes for the
first ten recoveries — "the commits never mentioned them" — and last round's fix
did not address it, because it cannot: the detector runs on the wrong event.

**2. Its credentials cannot exist in this project.** The hook demands all four
of `SUPABASE_PROD_URL`, `SUPABASE_PROD_SERVICE_ROLE_KEY`, `SUPABASE_DEV_URL`,
`SUPABASE_DEV_SERVICE_ROLE_KEY`. None is set in this clone; `.env.local` carries
`VITE_SUPABASE_URL` and the anon key only, and there is no
`.env.development.local` at all. CLAUDE.md states the reason plainly: there is
no restricted prod credential, and anon keys cannot read
`supabase_migrations.schema_migrations`. So the hook, as armed
(`core.hooksPath = scripts`, confirmed), blocks **every** push from this clone
with "BLOCKED - the migration drift check needs BOTH environments", and its own
message names the way out: `git push --no-verify`.

That is the failure worth naming. Last round's fix traded a silent skip for a
block that cannot be satisfied, and a block nobody can satisfy is trained around
within a day. The old failure was invisible; the new one is visible and
universal, which is a different kind of bad, not a smaller one.

**3. The applies did not go through git at all.** These reached production
through the Supabase MCP `apply_migration` tool. No git operation occurred, so
no git hook of any kind — pre-push, pre-commit, or otherwise — was ever in the
path. The only controls that could catch this class are (a) a scheduled audit
running against prod on a timer rather than on a developer's action, or (b)
discipline at the point of apply. There is no (c).

**What would actually have caught it:** `run_scheduled_ledger_checks` already
runs nightly under pg_cron on prod, with database credentials, needing no
developer and no push. A check there comparing `schema_migrations` against a
known file list would have reported these four the next morning. That needs the
repo's file list to reach the database, which is the part that has to be
designed rather than asserted — so it is named here as the candidate, not
claimed as done.

## Dev is retired — the catch-up is cancelled, and what replaces it is not nothing

**Decision recorded 2026-09-03: `crm-design-dev` (`wlyhbvunvdsropqzlpwx`) and the
`dev` git branch are both retired. All work is on `main`, against
`crm-design` (`mmkfpnshxjcyijhuydgr`).**

This supersedes "Where migrations are applied (policy, from 2026-09-01)" at the
top of this file. That section says *"All migrations are applied to
`crm-design-dev` FIRST. Nothing goes straight to prod."* **That is no longer
true and should be read as history.**

The twenty-two-migration catch-up described in earlier drafts of this section is
therefore cancelled. It was a session of careful ordered work; it is now work
nobody needs to do. That is the saving, and it is real.

What follows is the cost, stated once so it is on the record rather than
rediscovered.

### 1. `npm run dev` now runs against production

Measured, not inferred. This clone has exactly one env file:

```
.env.local        VITE_SUPABASE_URL=https://mmkfpnshxjcyijhuydgr...   ← PRODUCTION
```

There is no `.env.development.local`. Vite loads `.env.local` in every mode
including `development`, so `npm run dev` resolves to the production URL and the
production anon key. A developer running the dev server is pointed at the live
database — reads are live, and every write a screen makes is a live write.

The anon key means RLS still applies and no schema change is possible from a
browser. It does **not** mean the data is safe: creating a partner, drafting a
partnership run, or saving a policy from a local dev server writes to
production rows for real.

If a throwaway database is ever wanted back for this purpose, the fix is a
`.env.development.local` pointing at it; the loading order already works.

### 2. The pre-push hook is now permanently unsatisfiable

`scripts/pre-push` gates on **all four** of `SUPABASE_PROD_URL`,
`SUPABASE_PROD_SERVICE_ROLE_KEY`, `SUPABASE_DEV_URL`,
`SUPABASE_DEV_SERVICE_ROLE_KEY`, and blocks the push if any is missing. Two of
those name a database that no longer exists. The hook can no longer be
satisfied by anyone, ever — not through carelessness but by construction — so
every push is either blocked or pushed with `--no-verify`.

Its own header explains why it was made to fail rather than skip: *"a control
with a silent skip is a control nobody looks at."* The same reasoning now
condemns it in the other direction. A control nobody **can** satisfy is a
control everybody routes around, and the routing-around is a documented flag on
the command they type every day.

**It needs amending to gate on prod alone.** The comment inside it explaining
why BOTH are required ("prod and dev have diverged more than once") describes a
divergence that can no longer occur, because there is nothing left to diverge
from. Not done here: changing a control's threshold is a decision about what the
control is for, and it should be made deliberately rather than as a side effect
of a database being switched off.

### 3. There is no rehearsal environment for a migration

Every migration from here is written directly against the database that holds
1,149 employees and the ledger. The mitigations that already exist in this
project's migration style — an anchor asserted before surgery, a probe that
proves the effect and then deliberately rolls itself back, a `REFUSED` raise
when the shape is not what was expected — stop being good practice and become
the only protection there is.

`0361` and `0362` are the model: both compute their effect, assert it, and then
`raise exception 'ROLLBACK_PROBE_…'` to undo the proof. That pattern was
optional when a dev database existed to try things on. It is not optional now.

### 4. `supabase/tests/` has nowhere to run

The suites roll back via a deliberate exception, so running them on production
is *survivable* — but "it rolls back" is a claim about the happy path, and a
suite that aborts before its rollback leaves its fixtures behind in the live
database. `PRODUCTION_CLEANUP.md` already records these as "dev only, and now
genuinely blocked on production". With dev gone they have no home at all.

That is a gap, not a plan. Naming it here so it is not mistaken for a solved
problem.

### 5. CLAUDE.md's central rule no longer describes reality

The file opens with a two-database table and the rule **"Write to dev. Never to
prod."**, with a narrow named-authorisation exception. With one database left,
every write is a prod write, and the exception becomes the only path.

**That file has not been edited here.** Rewriting the project's main safety rail
is a policy decision, and the replacement — whether every migration now needs
naming in advance, or whether migrations are routine and only data changes need
authorising — is a question with real consequences either way. It is flagged,
not answered.

## The frontend half of the same gap — rebuilt

The four migrations were not the whole loss. Nothing in `src/` called
`draft_profit_allocation`, `post_profit_allocation`, `partnership_run_blocker`
or `partnership_uninvoiced_clients`, and no such caller exists anywhere in git
history: `git log --all -S"draft_profit_allocation"` returns nothing,
`git fsck --lost-found` finds no dangling objects, there is no second clone on
the machine, and no Claude session transcript under `~/.claude/projects`
mentions the screen. The work never entered this repository in any form.

So it was **rebuilt, not recovered**:
`src/app/pages/super-admin/PartnershipRun.tsx`, routed at
`/super-admin/partnership-run` and linked from the Finance nav group beside the
Partnership Report. It calls the seven database functions above and restates
none of their rules.

One thing the rebuild uncovered: `0361` gates posting on the permission
`partnership.post`, and that key was not in `PERMISSION_GROUPS` in
`src/app/lib/supabase.ts`. `has_permission()` waves `super_admin` and
`super_super_admin` through unconditionally, so the two admin accounts could
always have posted — but the key could not be granted to anyone else, because
the grant screen had no checkbox for it. Zero profiles carry it. The key has
been added to the catalogue.
