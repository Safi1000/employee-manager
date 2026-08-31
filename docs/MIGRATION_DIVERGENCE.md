# Migration ledger divergence — repo vs database

**Date:** 2026-08-31
**Project:** `crm-design` (`mmkfpnshxjcyijhuydgr`)
**Status:** **Reconciled.** Ten migrations recovered into the repo; a check now guards the loop.

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
