# Bastion — working rules

## Databases: two projects, and only one of them is yours to write

| Role | Supabase project | Project ref | Loaded by |
|------|------------------|-------------|-----------|
| **PRODUCTION** | `crm-design` | `mmkfpnshxjcyijhuydgr` | `.env.local` → `npm run build` |
| **DEVELOPMENT** | `crm-design-dev` | `wlyhbvunvdsropqzlpwx` | `.env.development.local` → `npm run dev` |

**Write to dev. Never to prod.**

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

### Guards must test the condition they mean

A guard that compares `max(schema_migrations.version)` against a string literal
is a proxy, not a test. Two migrations (`0224b`, `0231b`) shipped with exactly
that and were correct on prod only by accident — prod's versions are timestamps,
so `'2' > '0'` returned early for the wrong reason. Both now test a real marker:
does the column/function that the later migration creates or drops exist?

### Idempotency is a property of the whole migration

`add column if not exists` on every DDL statement is not enough. `0232` would
have aborted at an **assert** two hundred lines above its guarded `drop`,
because the assert read the column the drop removes. Replay the whole file
mentally against an already-migrated database, not just its DDL.

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

## Accounting policy

Do not invent it. Policy lives in `docs/LEDGER_PHASE1_POSTING_RULES.md` and the
Part A/C answers. Where those are silent, **ask** — a plausible-looking default
becomes precedent the moment it posts.

Two settled points that get re-litigated by accident:

- Revenue is recognised at the **service month** (`period_start`), not
  `invoice_date` (A4).
- HO cost is apportioned by **revenue**, never by guard-days (A10). Regional
  partners hold no equity; their share is an expense, and negative shares carry
  with no floor (A9).
