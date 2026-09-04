# Production cleanup

Everything here is measured against **PRODUCTION** (`crm-design`,
`mmkfpnshxjcyijhuydgr`). Nothing in this document has been applied.

Order: `guards n guides` (delete), then build the archive flag, then SANDBOX
TESTING ORG (export, archive-then-remove) and `sa@sandbox.test`.

---

## 1. `guards n guides` — `f706043b-c548-4d15-b4c7-ef81f77f8d2a`

### Correction to what I proposed

I put this company first as "no profile, no ledger, nothing depends on it, the
cheapest rehearsal". Two of those are true. **"Nothing depends on it" is true
only of the outside world — the company itself is not empty.** It holds roughly
5,300 rows across 18 tables, including 527 employee records and 43 client
records. It is the cheapest rehearsal available, but it is not a trivial one,
and the plan below is sized for what is actually there.

### What is in it

| Table | Rows | | Table | Rows |
|---|---:|---|---|---:|
| `attendance_records` | 2440 | | `shift_definitions` | 40 |
| `employee_salary_history` | 784 | | `sites` | 34 |
| `deployments` | 675 | | `contracts` | 30 |
| `employees` | 527 | | `locations` | 8 |
| `audit_log` | 272 | | `branches` | 4 |
| `company_counters` | 68 | | `alerts` | 2 |
| `contract_lines` | 67 | | `contract_addendums` | 2 |
| `chart_of_accounts` | 53 | | `finance_settings` | 1 |
| `clients` | 43 | | `notification_deliveries` | 1 |

**Zero** invoices, payslips, journal entries, bank accounts, profiles,
opening-balance batches, employee/guard documents, subscription payments.

### It is a duplicate of GUARDS AND GUIDES, and that is measured

- **234 of 234** `guards n guides` employees that carry a CNIC have that CNIC on
  a GUARDS AND GUIDES employee. Not most — all of them.
- **43 of 43** client names appear in GUARDS AND GUIDES, which has 43 clients.
- Created 2026-08-13; the last employee row was created the same day.
- `audit_log` has **0 distinct actors** — every row has a null `changed_by`.
  Its entries are all migration backfills: the 50 `chart_of_accounts` inserts on
  2026-08-29 (CoA seeding), 200 `attendance_records` updates on 2026-08-31, and
  the single insert on 2026-09-02, which is `unearned_revenue` from 0323.

No human has ever operated this company. It is an import that was made twice.

### Nothing outside it points in — proven, not assumed

A sweep of every foreign key in `public` whose parent is one of `employees`,
`clients`, `contracts`, `sites`, `branches`, `chart_of_accounts`, `locations`,
`shift_definitions`, `contract_lines`: **153 (child, column, parent) pairs
examined, 22 with rows, cross-company count 0 on every one of them.**

The 153 is stated because a sweep that returns nothing is indistinguishable from
a sweep that did not run. 22 pairs came back non-zero from *inside* the company,
which is what proves the loop executed.

### What the delete will actually do

`companies` has 128 inbound foreign keys: **114 CASCADE, 10 NO ACTION, 3 SET
NULL, 1 RESTRICT.** Each of the four groups was checked against this company:

- **RESTRICT** — `journal_entries.company_id`. **0 rows**, so it does not block.
  It is also the reason this company is the right rehearsal: a company with a
  ledger cannot be deleted at all, by design.
- **NO ACTION** (10 tables: `cash_locations`, `custody_transfers`,
  `finance_investors`, `finance_projects`, `investor_ledger_entries`,
  `partner_account_entries`, `profit_allocation_runs`,
  `profit_distribution_rules`, `project_investments`, `referral_arrangements`) —
  **0 rows across all ten.** Any one of them would refuse the delete.
- **SET NULL** (`billing_events`, `profiles`, `signup_intents`) — **0 rows.**
  This matters: a non-zero count here would not fail, it would leave orphan rows
  with a null `company_id` and no way to tell what they belonged to.
- **CASCADE** — the 114 that carry the 5,300 rows away.

**The one thing that cannot be settled by reading.** `attendance_records.branch_id`
is NO ACTION against `branches`, and `branches` cascades from `companies`. The
2,440 attendance rows should be removed by their own CASCADE from `companies`
within the same statement, so the branch constraint's end-of-statement check
finds nothing to complain about — but that is a claim about Postgres's ordering,
not a measurement. Three checks in this project have been green for the wrong
reason. It gets tested.

### The plan

1. **Export first.** All 18 tables written to `exports/guards-n-guides-2026-09-02/`
   as one JSON file per table, plus a row-count manifest. Read-only. The export
   is verified by re-reading the files and comparing counts against the database
   before anything is deleted.
2. **Rehearse the delete and roll it back.** In one transaction on production:
   `delete from public.companies where id = 'f706043b-…'`, capture the row
   counts of all 18 tables plus the four constraint groups afterwards, then
   `raise exception 'REHEARSAL_ROLLBACK'`. This is a write, and it needs its own
   authorisation — but it is the only thing that answers the cascade-ordering
   question, and it unwinds through the transaction rather than through a
   compensating write.
3. **Report the rehearsal.** What the cascade removed, what it left, whether
   anything refused.
4. **Then the delete for real**, under a second authorisation naming this
   company — same statement, no rollback, with the same post-conditions
   asserted: 0 rows in all 18 tables, the other three companies' counts
   unchanged, `ledger_checks` still 29 checks + canary green on the remaining
   three, journal still 427 entries / 1304 lines.

Steps 2 and 4 are separate authorisations on purpose. The rehearsal can be
approved without committing to the removal.

### Why no archive flag here

The archive flag is the next piece of work and does not exist yet. This company
is a duplicate import with no financial history and no user — there is nothing
to preserve access to. Archiving it would be building the mechanism and then
using it on the one case that does not need it. `guards n guides` is deleted;
SANDBOX TESTING ORG is what the flag is for.

**Stopping here for authorisation.**

---

## Step 2 — the rehearsal (2026-09-02, production, rolled back)

One transaction: `delete from public.companies where id = 'f706043b-…'`, measure,
then `raise exception 'REHEARSAL_ROLLBACK'`.

    outcome: REHEARSAL_ROLLBACK
    companies 4 -> 3 (deleted 1)
    journal_entries 427 -> 427, journal_lines 1304 -> 1304
    tables carrying company_id: 129 examined
    rows still bearing this company_id anywhere: 0
    tables whose drop did not equal this company holding: 0
    attendance_records 46515 -> 44075 (company held 2440)
    employees 1150 -> 623 (company held 527)

**The cascade-ordering question is answered, and the answer is yes.**
`attendance_records.branch_id` is NO ACTION against a `branches` row the delete
cascades away, and the delete completed anyway: 46,515 → 44,075, exactly the
2,440 rows this company held. The rows are removed by their own CASCADE from
`companies` within the same statement, so the branch constraint's end-of-statement
check finds nothing left to object to. That was a claim about Postgres's
ordering; it is now a measurement.

**No constraint refused.** Not the `journal_entries` RESTRICT, not any of the ten
NO ACTION tables, not the three SET NULL ones.

**Nothing outside the company moved.** 129 tables carrying a `company_id` were
compared before and after, and in every one the drop equalled exactly what this
company held — drift 0. Zero rows anywhere still bear the id. The ledger is
untouched at 427 entries / 1304 lines.

The 129 is stated for the same reason the 153 was: a comparison that reports no
drift is indistinguishable from a comparison that examined nothing.

### How the numbers survived a rollback

The measurements are built into a plpgsql `text` variable *inside* the
subtransaction and written to a temp table only *after* the exception handler
has caught the deliberate raise. plpgsql variables are memory, not database
state, so they survive the unwind. Nothing was written to a real table at any
point, and no compensating write was used to undo anything (0321).

### Confirmed after the rollback

Companies **4**, employees **1150**, attendance **46,515**, clients **94**,
journal **427 / 1304**, `guards n guides` still present with its 527 employees.
Production is exactly as it was.

### Verdict

The real delete is a single statement with no special handling: no ordered
teardown, no constraint to defer, no cleanup pass. It needs the second
authorisation, and the export finished.

## Step 1 — the export (2026-09-02, complete and verified)

`exports/guards-n-guides-2026-09-02/` — **18 tables, 5,051 rows, 6.8 MB.**
Complete rows as `to_jsonb(row)` produced them: nothing omitted, nothing
reshaped, `jsonb` columns intact.

Verified two ways. `verify.mjs` re-hashes and re-parses every file and reports
the count of files and rows it compared, not just a verdict. Separately, the row
count per table was read back off production and compared: 18 tables, 5,051 rows
on both sides, no mismatch.

**It is a JSON export, not a `pg_dump`, and the difference is worth stating.**
It is complete for this company — the table list came from looping over all 129
tables carrying a `company_id`, not from listing the ones that looked likely —
but it is not a whole-database backup and must not be described as one.

Why not a `pg_dump`: `pg_dump` 16.14 (the only one on this machine) refuses a
17.6 server outright, and `supabase db dump` needs a running Docker daemon,
which there was not. `psql` has no such version restriction, so the export went
through psql over the session pooler.

Two connection facts worth keeping: `db.<ref>.supabase.co` does not resolve at
all — direct connections are IPv6-only, and the pooler is the IPv4 path. And the
pooler host is `aws-**1**-ap-southeast-1`, not `aws-0-`, which answers
`tenant/user not found`.

**The export contains real personal data** — 527 CNICs, home addresses, phone
numbers, next-of-kin details, salary history. `exports/` was added to
`.gitignore` in the same change. It must never be committed.

### Both steps are now done

Export complete and verified; rehearsal run and rolled back with production
confirmed unchanged. What remains is the second authorisation for the real
delete, which is one statement.

## The safety net (recorded 2026-09-02)

`C:\Users\Abuzar\Desktop\supabase_backup.dump` — 61,667,543 bytes, taken
2026-09-02 13:37 by Shayan from a direct connection.

Verified by reading the file, not by trusting its name:

- Plain SQL, `pg_dump 17.11` against server 17.6 — no version mismatch.
  (The `.dump` extension notwithstanding: restore with `psql`, not
  `pg_restore`. It opens with a `\restrict` meta-command that needs **psql 17**.)
- 353 tables, 363 functions, 138 `COPY` data blocks, 280 RLS policies,
  291 triggers. Whole database, not one schema.
- 5,063 references to `guards n guides`'s company id, so the company being
  deleted is inside it.

**It postdates 0326**, established from the contents rather than the timestamp:
`run_auto_invoices` carries the `0326: the service month is STATED` body,
`revenue_outside_service_month` (0324) and `ensure_unearned_revenue_account`
(0323) both exist, and the migration ledger inside the dump records 0323, 0324,
0325 and 0326.

This is the restore path. `exports/guards-n-guides-2026-09-02/` stays as a
readable copy of the one company — 18 tables, 5,051 rows — but it has no schema
and cannot restore anything, and must not be described as a backup.

**It holds every employee record and every RLS policy in the system.** It is on
the Desktop, which no ignore file covers. Move it somewhere deliberate.

### Step 4 — the real delete — is now unblocked on everything except authorisation.

## Step 4 — the delete, done (2026-09-02)

`delete from public.companies where id = 'f706043b-…'` on `crm-design`
(`mmkfpnshxjcyijhuydgr`), authorised by name, this company only.

| | before | after | change |
|---|---:|---:|---:|
| companies | 4 | **3** | −1 |
| employees | 1150 | **623** | −527 |
| attendance_records | 46,515 | **44,075** | −2,440 |
| clients | 94 | **51** | −43 |
| journal_entries | 428 | **428** | 0 |
| journal_lines | 1306 | **1306** | 0 |

Every drop equals exactly what the company held. `tenant_guard_gaps()` **0**,
`uninvoked_controls()` **11**, no rows anywhere still bearing the id, and the
three remaining companies each answer **30 rows (29 checks + canary), canary
green**. Their reds are the pre-existing set, unchanged.

### The first attempt refused, and the guard was right

The post-conditions were written as `journal = 427 / 1304`, the numbers measured
at the rehearsal. Between the rehearsal and the delete a third party recorded an
expense ("Licenses") against SANDBOX TESTING ORG, so the count read 428 / 1306
and the migration aborted before the delete. Nothing was removed.

**The literal was a proxy.** The property is *the delete does not move the
journal* — before equals after — not *the journal equals 427*. A guard written
against a snapshot fails when the world moves rather than when the property
breaks, which is the same shape as `max(schema_migrations.version) > '0'` and
the canary that reported its own input.

Rewritten to read the totals before the delete and compare them after, with the
condition that actually makes the delete safe asserted first and separately:
**the company owns zero journal entries.** A company with a ledger is refused.

The other three companies were compared **company by company and table by
table**, never as a total — a total would let a drop in one and a rise in
another cancel (§9.15).

`guards n guides` is gone. The export and the verified dump both predate it.

---

# 2. The archive flag — design, before building

Measured against production, 2026-09-02. **Nothing built.**

## `companies.active` cannot be the flag

It exists — `boolean not null default true` — and the report that it is unused
by RLS is correct: **0 of 272 policies reference it**, and `current_company_id()`
does not consult it. But it is not unused:

- `RequireAuth.tsx:35` — `if (company.active === false || expired)` **blocks
  sign-in entirely**
- `Companies.tsx` (super-super-admin) toggles it, labelled **Active / Suspended**
- `enforce_subscription_expiry` and `add_subscription_payment` read it, and so do
  seven views

`active` is the **billing suspension** flag. Reusing it would conflate "unpaid"
with "archived", and worse, it would make an archived company's data
*unviewable* rather than read-only, because suspension stops login. Archiving
must keep the data readable — that is the whole point of archiving instead of
deleting.

**So: a new column, `companies.archived_at timestamptz null`.** Nullable rather
than boolean, because when a company was archived is the first thing anyone will
ask, and a boolean cannot answer it.

## The enforcement layer: triggers, NOT RLS

This is the decision the rest follows from, and it is measured:

| | |
|---|---:|
| tables carrying `company_id` | 129 |
| of those, RLS enabled | **129** |
| of those, `FORCE ROW LEVEL SECURITY` | **0** |
| table owner | `postgres` |
| SECURITY DEFINER functions in `public` | **282** |

A SECURITY DEFINER function runs as its owner, `postgres`, which owns the tables.
Without `FORCE ROW LEVEL SECURITY`, **RLS does not apply to the owner** — so an
archive flag written as an RLS policy would be enforced on direct PostgREST
table writes and **silently ignored by all 282 RPCs**, which is how this
application actually writes. `post_journal`, `record_invoice_payment`,
`post_payslip_disbursement` and every other writer would sail straight through.

A policy that the real write path bypasses is the vacuity this project keeps
finding, and it would be worse than usual here because it would *look* enforced.

**A `BEFORE INSERT OR UPDATE OR DELETE` row trigger fires regardless of caller** —
PostgREST, RPC, psql, cron, migration. That is the same mechanism
`enforce_period_lock` already uses across seven tables, so the pattern has
precedent and a known shape in this codebase.

## The shape

1. `alter table public.companies add column archived_at timestamptz`.
2. `enforce_company_not_archived()` — reads `new.company_id` (or `old` on
   delete), looks up `companies.archived_at`, raises if set. One PK lookup per
   modified row.
3. Attached to **all 129 company-scoped tables**, generated in a loop, never
   hand-listed — a hand-listed set is how a table gets missed.
4. **Not** attached to `companies` itself, or archiving could not be undone.
5. Reads: **completely untouched.** No RLS change, no change to
   `current_company_id()`, no change to `RequireAuth`. An archived company still
   opens, still shows its ledger, still exports.

## How it interacts with `current_company_id()` — deliberately, not at all

The tempting one-line version is to make `current_company_id()` return null for
an archived company: every one of the 128 policies that reference it would stop
matching, with no new triggers.

It is wrong, and the reason is worth writing down. It would make archived data
**invisible** rather than read-only, which is deletion with extra steps. It
would also break `assert_same_company` for that tenant, so every guarded
function would refuse rather than the writes specifically. Read and write are
different questions and the flag must only answer the second.

## Two things to decide before I build

1. **Exemptions.** Should any company-scoped table stay writable while archived?
   The candidates are `audit_log` (which would want to record the archiving
   itself) and `notification_deliveries`. My inclination is **no exemptions** —
   an archive that has exceptions is a policy, not a boundary — and to write the
   audit row before setting `archived_at`. Confirm.
2. **Archiving makes a company undeletable.** A `delete from companies` cascades
   to the child tables, and the trigger would refuse those cascaded deletes. So
   the order is always un-archive, then delete. That is arguably correct — it
   makes removal require two deliberate acts — but it should be a decision, not
   a surprise.

## The proof it will carry

- The same write **refused** against an archived company and **accepted**
  against a live one. Both halves: a trigger that refuses everything passes a
  test that only checks refusal (§9.11).
- The refusal fires **inside a SECURITY DEFINER function** — `post_journal`
  against an archived company must raise. This is the assertion the whole design
  exists for; without it the trigger is only proved on the path RLS already
  covered.
- Every one of the 129 tables carries the trigger, counted, not sampled.
- Un-archiving restores writes, so the flag is reversible.
- All of it rolled back through a deliberate raise.

**Stopping here for the two decisions.**

## 0329 — built and on dev (2026-09-02)

Recorded digest `3bdb39ae343f290d010606e87b8015bf`, equal to the file.
**Production does not have it; it needs naming.**

`companies.archived_at timestamptz` plus `enforce_company_not_archived()`,
attached by a generated loop to **129 of 129** company-scoped tables — counted
by asserting *zero without the trigger*, not by matching the number 129, so the
assertion cannot pass against a stale count after a table is added or dropped.

### The refusals, as an operator will read them

    INSERT  Sandboxx is archived (since 2026-08-30) and its records are
            read-only. Un-archive it before writing to it. [locations]

    DELETE  Sandboxx is archived (since 2026-08-30) and its records are
            read-only. Un-archive it before deleting — removal takes two
            deliberate acts by design. [locations]

    RPC     Sandboxx is archived (since 2026-09-02) and its records are
            read-only. Un-archive it before writing to it. [chart_of_accounts]

Each carries a `HINT` with the exact statement that lifts it.

**The third line is the one that matters.** That refusal came from inside
`ensure_unearned_revenue_account`, a SECURITY DEFINER function running as
`postgres` — the table owner. An RLS policy would not have stopped it, and
neither would it have stopped `post_journal` or `record_invoice_payment`. This
is the path the whole design was chosen for, and it is now measured rather than
argued.

### What the migration's own proof asserts

Coverage as a property; a write **accepted live and refused archived** (both
halves — a trigger that refuses everything passes a test that only checks
refusal); the refusal firing **inside a SECURITY DEFINER function**; DELETE
refused with the way out named in the message; and **un-archiving restoring
writes**, so the flag is not a one-way door. All inside a subtransaction that
unwinds — dev afterwards has 0 companies archived, 0 probe rows, journal
unchanged at 444, `tenant_guard_gaps()` still 0.

### Not yet done

Nothing archives a company yet. `archived_at` is set by hand
(`update public.companies set archived_at = now() where id = …`) and there is no
UI for it. That is deliberate for now — the boundary exists before anything
relies on it — but SANDBOX will need the audit row written *before* the flag is
set, per the no-exemptions rule.

## SANDBOX TESTING ORG is archived on production (2026-09-02 10:25 UTC)

Audit row first, then the flag, per the no-exemptions rule. The audit row records
the reason, what it held (428 journal entries, 69 employees), who authorised it,
and the exact statement that reverses it — written *before* `archived_at` was
set, because afterwards the trigger it documents would have refused it.

Verified immediately after:

    write to ARCHIVED SANDBOX  SANDBOX TESTING ORG is archived (since
                               2026-09-02) and its records are read-only.
                               Un-archive it before writing to it. [locations]
    write to a LIVE company    ACCEPTED

### The six reds did NOT become unreachable — and that is correct

The expectation was that SANDBOX's six failing checks would go away with the
fixtures. They did not, and they should not have: **archiving makes a company
read-only, not invisible.** `ledger_checks` still evaluates SANDBOX and still
reports the same six. Nothing changed for any of the three companies:

| company | rows | failing | canary |
|---|---:|---:|---:|
| GUARDS AND GUIDES | 30 | 3 | 29 |
| SANDBOX TESTING ORG (archived) | 30 | 6 | 29 |
| Sandboxx | 30 | 1 | 29 |

What changed is that they are now **frozen**: nothing can write to SANDBOX, so
they cannot get worse, and they cannot be repaired either without un-archiving.
Reads being untouched was the design, so this is the design working — but it is
the opposite of what was expected, and worth correcting rather than glossing.

### THE TEST SUITES: dev only, and now genuinely blocked on production

Five suites in `supabase/tests/` write against SANDBOX —
`attendance_status` (4 writes), `fixtures_period_split` (9),
`ledger_foundation` (12), `period_lock` (28), `repost_sets` (13) — plus
`scripts/fix-sandbox-fixture-divergence.sql`. All roll back through the
deliberate-exception idiom, but the trigger fires *before* the rollback matters.

They run against **dev**, where SANDBOX stays live, so they are unaffected. But
this is now a hard fact rather than a convention: **those five suites can no
longer be run against production.** Anyone who tries will be refused, by name,
with the un-archive statement in the hint.

## A CONSEQUENCE I DID NOT SURFACE IN THE DESIGN

The design report covered RLS versus triggers and read versus write. It did not
ask **what writes to every company on a schedule.** Five pg_cron jobs do:

| job | schedule | interaction |
|---|---|---|
| `enforce_subscription_expiry` | 01:00 daily | to check |
| `run_auto_invoices` | 02:00 on the 1st | **no risk** — 0 auto-invoice clients exist anywhere |
| `run_scheduled_ledger_checks` | 05:00 daily | **BREAKS for SANDBOX** |
| `invoke_send_compliance_alerts` | 06:00 daily | SANDBOX has 0 compliance cases |
| `generate_fixed_expense_instances` | 00:05 on the 1st | **BREAKS ENTIRELY** |

**`run_scheduled_ledger_checks`** loops `where c.active` — and SANDBOX's `active`
is still true, because archived and suspended are different flags. For each of
its six reds it calls `raise_alert`, which writes to `alerts` and is now refused.
Its per-company handler catches that, then tries to record the failure in
`notification_deliveries` — **also refused** — so it falls through to
`raise warning`. Measured, both refusals confirmed.

That is precisely the outcome that function's own comment says the design exists
to prevent: *"an exception that only reaches the postgres log is the silent
failure this whole design exists to prevent."* Contained to SANDBOX, but silent.

**`generate_fixed_expense_instances`** is worse in shape and smaller in blast
radius. It has **no exception handler at all**, and both of production's two
`fixed_expenses` rows belong to SANDBOX — so from 2026-10-01 the whole monthly
job aborts. Nothing else is affected today only because nothing else has a fixed
expense.

### Proposed 0330 — not built

Background work should skip an archived company. `and c.archived_at is null` on
the per-company loops, by surgery against the live definitions, starting with
those two and auditing the other three.

Archiving means "this company is finished, keep it readable". A nightly job
trying to write to it is not a failure to be logged; it is work that should not
be attempted.

---

# 3. Deleting SANDBOX TESTING ORG — plan, nothing applied

Shayan's ruling: delete, do not keep archived. Measured 2026-09-02.
**This is not the `guards n guides` shape.** Three of the four foreign-key
groups are non-empty this time, where all four were clear before.

## What is there: 48 tables, 10,238 rows

Against `guards n guides`'s 18 tables / 5,051 rows. Largest first:

| table | rows | | table | rows |
|---|---:|---|---|---:|
| `attendance_records` | 5836 | | `payslips` | 48 |
| `attendance_confirmations` | 1444 | | `invoice_lines` | 25 |
| `audit_log` | 1223 | | `contract_lines` | 20 |
| `employee_document_checklist` | 690 | | `cash_locations` | **14** |
| `journal_entries` | **428** | | `bank_accounts` / `invoices` / `sites` | 9 |
| `chart_of_accounts` | 71 | | `clients` / `contracts` / `invoice_payments` | 8 |
| `bank_transactions` / `employees` | 69 | | `profiles` | **1** |
| `employee_salary_history` | 68 | | `custody_transfers` | **1** |
| `deployments` | 61 | | *(and 30 more)* | |

Plus **1,306 `journal_lines`**, which carry no `company_id` and hang off the 428
entries.

## Nothing outside SANDBOX references it

The same 153-pair sweep: **153 examined, 57 non-zero, cross-company count 0.**

One reading correction, because the raw output invites the wrong conclusion:
`journal_lines` and `opening_balance_lines` appear with large counts in the
cross-company column. That is an artefact — those two tables have **no
`company_id`**, so the sweep counts *all* their children of SANDBOX parents.
Asked directly, the answer is clean: **0 journal lines belonging to another
company point at a SANDBOX account, branch, employee or client**, and 0 foreign
opening-balance lines. The 1,306 are SANDBOX's own.

## The four FK groups — and why this needs ordering

| group | `guards n guides` | SANDBOX |
|---|---|---|
| **RESTRICT** `journal_entries` | 0 | **428** — blocks the delete |
| **NO ACTION** (10 tables) | 0 across all ten | **`cash_locations` 14, `custody_transfers` 1** |
| **SET NULL** (3 tables) | 0 | **`profiles` 1** — will not fail; leaves an orphan |
| **CASCADE** (114) | carried everything | carries ~8,400 rows |

**The `cash_locations` knot is the real obstacle, and it is new.** All eleven FKs
pointing at `cash_locations` are NO ACTION — `payslips`, `expenses`, `advances`,
`cheques`, `invoice_payments`, `fixed_expenses`, `custody_transfers` and four
others. So:

- `cash_locations` is **not** removed by the cascade from `companies` (its own FK
  is NO ACTION), so `delete from companies` fails while its 14 rows exist;
- but `cash_locations` cannot be deleted first either, because 48 payslips and
  the rest still reference it, and those only go when the company is deleted.

That is not a deadlock, but it does mean the referring rows must be deleted
**explicitly and in order** rather than left to the cascade.

## The order of operations, and what refuses at each step

| # | step | what would refuse | what lifts it |
|---|---|---|---|
| 1 | `set local app.ledger_maintenance = 'on'` | — | `session_user` is `postgres`, `rolbypassrls = true` — measured, the gate opens |
| 2 | un-archive SANDBOX | 0329's trigger refuses every write/delete on all 129 tables while archived | `companies` carries no 0329 trigger, so this update is allowed. **The two-deliberate-acts rule, one message after it was built** |
| 3 | `delete from journal_entries where company_id = …` | `enforce_journal_immutable` on DELETE; the cascade to `journal_lines` fires its BEFORE DELETE trigger too | step 1's maintenance session |
| 4 | delete SANDBOX's `custody_transfers`, then the other `cash_locations` referrers (`payslips`, `expenses`, `advances`, `cheques`, `invoice_payments`, `fixed_expenses`, …) | NO ACTION on `cash_locations` | doing them before step 5, in dependency order |
| 5 | `delete from cash_locations where company_id = …` | NO ACTION from the eleven referrers | step 4 emptied them |
| 6 | `delete from companies where id = …` | RESTRICT on `journal_entries`; NO ACTION on `cash_locations`/`custody_transfers` | steps 3–5 satisfied all three |
| 7 | the `profiles` orphan | nothing — SET NULL succeeds **silently** | must be decided, not discovered |

**One statement is not possible.** The answer to the question the rehearsal was
meant to settle is already visible in the constraint graph: the ledger teardown
and the company delete are separate statements, and steps 4 and 5 are separate
again. They must all be **one transaction**, so the rehearsal's raise unwinds
every part of it.

## The `profiles` row is `sa@sandbox.test`, and it connects to the next task

`profiles → companies` is SET NULL. The delete will not fail on it — it will
leave that profile with `company_id = null`, a super_admin belonging to no
company. Deciding it as part of this teardown rather than meeting it afterwards
is the difference between a plan and a surprise.

## What the checks read afterwards

Two companies remain. **SANDBOX's six reds disappear entirely** this time,
because the company is gone rather than frozen — the fixtures leaving, not a
repair. Expected after:

| company | rows | failing |
|---|---:|---:|
| GUARDS AND GUIDES | 30 | 3 |
| Sandboxx | 30 | 1 |

And production's journal goes to **0 entries / 0 lines** — every entry on
production is SANDBOX's. GGS's first real entry will be the first entry in the
system.

## The backup covers it

`C:\Users\Abuzar\db-backups\crm-design-prod-2026-09-02T1337.sql` contains
**10,280 references** to SANDBOX's company id and 19 to it by name.

It predates today's work, verified from content rather than the file time: its
only two `archived_at` mentions are `storage.objects`, a Supabase built-in
column — **`companies.archived_at` is not in it**, so the dump was taken before
0329. SANDBOX is in it whole and unarchived.

**Stopping here. Nothing applied.**

## Rehearsal, 2026-09-02 — five runs, nothing committed

Every run was one transaction whose steps sat in a subtransaction ending in a
deliberate raise; each ended by re-reading production and confirming
`companies=3, SANDBOX archived_at=2026-09-02 10:25:13, journal_entries=428,
journal_lines=1306, sa banned_until=null`. Nothing landed.

### Two corrections to the plan above

1. **`profiles.company_id` is CASCADE, not SET NULL.** The SET NULL row in the
   plan is `profiles.view_as_company`; I attributed it to the wrong column.
   There is no orphan — deleting the company deletes the profile. `auth.users`
   survives, which is why the account is disabled first regardless.
2. **The teardown needs an identity.** `fill_company_id()` calls
   `current_company_id()`, which reads `profiles` by `auth.uid()`. An MCP/psql
   session has no JWT, so every row a delete-trigger generates gets
   `company_id = null` and fails its NOT NULL. Fixed by setting
   `request.jwt.claims` to `sa@sandbox.test` — the account is disabled but its
   row is kept until step 6 precisely so it can be the actor.

### Three obstacles the plan did not have

- **`opening_balance_batches.journal_entry_id` is NO ACTION.** The journal
  teardown itself needs ordering; the batch goes first.
- **The document deletes GENERATE journal entries.** 428 -> 442 after the
  thirteen document deletes. The journal must be swept *last*, not first. Sweep
  pass 1 removed 442, pass 2 removed 0.
- **`guard_super_admin_mutations`.** The cascade removes a `super_admin`
  profile, so only a Super Super Admin may run step 6. Actor switches to
  `techxserve@gmail.com`, whose own `company_id` is null.

### The blocker, and it has no gate

`enforce_finance_verify_lock` on `payroll_run_phases` refuses DELETE whenever
`finance_verified_at is not null`, and refuses the UPDATE that would clear it.
SANDBOX has **10 phases, 8 finance-verified**. It does not read
`is_maintenance_session()`, so no gate lifts it.

Full inventory of DELETE-blocking triggers, and which honour maintenance:

| honours maintenance | trigger function |
|---|---|
| yes | `enforce_journal_immutable`, `enforce_period_lock`, `enforce_period_lock_journal_lines`, `enforce_attendance_month_lock`, `enforce_confirmed_month_end_lock` |
| no | `enforce_finance_verify_lock`, `enforce_company_not_archived`, `guard_super_admin_mutations`, `guard_posted_opening_batch`, `sync_payslip_reward_totals`, `cheque_apply_balance` |

The attendance locks being in the first group is why 5,836 `attendance_records`
are not a problem. `enforce_finance_verify_lock` being in the second is the one
that stops the delete.

### Verified up to that point

Steps 0-5 complete cleanly: 0329 refuses a real delete on all six probe tables
while archived and **still refuses under maintenance** (no exemptions, as
designed); un-archive; 13 document tables cleared in one pass; journal swept to
0; 14 `cash_locations` gone. Step 6 aborts.

## 0330 on dev, 2026-09-02

`enforce_finance_verify_lock` now yields to a maintenance session. Restatement
behind a digest precondition (single author: 0194), per CLAUDE.md's second arm.

- recorded digest `9596ab24c53c137801e552cd046be77d` = file digest, one row
- dev body digest `80a756ed75a562fd71005181c82bde1d`
- proof ran STATIC AND BEHAVIOURAL; fixtures rolled back (10 phases, 8 verified,
  unchanged); `ledger_checks` 28 rows; `tenant_guard_gaps()` 0

Two things the first attempt got wrong, both caught by the migration refusing
rather than half-applying:

1. The fixture was planted with a null client AND a null category, violating
   `prp_scope_ck` (exactly one of the two must be set). It now sets a category.
   The fixture also has to avoid SANDBOX, which owns every `payroll_run_phases`
   row on both databases and is archived on production — 0329 would have refused
   the insert and the proof would have reported a failure of the wrong thing.
2. **The recorded SQL is the file WITHOUT its trailing newline.**
   `applied_migration_digests()` does not trim, and `check-migrations.mjs`
   strips `\n+$` from the file side only. Sending the file with its trailing
   newline records one extra byte and shows up as drift. The stale dev row was
   removed and the migration re-applied so exactly one row remains and it
   matches. Worth knowing before the next apply, on either database.

## 0330 on production, 2026-09-02

Recorded digest `9596ab24c53c137801e552cd046be77d` = file digest, one row.
Body digest `80a756ed75a562fd71005181c82bde1d` — **identical to dev**. Nothing
else moved: 3 companies, 428/1306 journal, `tenant_guard_gaps()` 0, checks
30/3, 30/6, 30/1.

### Open item, logged not built: the digest asymmetry

`applied_migration_digests()` computes `md5(array_to_string(statements, E'\n'))`
with no trimming. `check-migrations.mjs` strips `\r` and `\n+$` from the **file**
side only. So an apply that transmits the file's trailing newline records one
extra byte and reads as drift for ever after. Either the function trims or the
checker stops trimming — it does not matter which, only that they agree. This is
the same asymmetry behind the 26 false mismatches earlier in this session,
arriving on a fresh apply rather than in the backlog.

### Latent defect found by the rehearsal, logged not fixed

**Both halves of a bank transfer pair cannot be deleted in one statement, by
anyone.** `journal_on_bank_transaction` calls `sync_bank_transfer_journal`,
which calls `assert_same_company((select distinct company_id from
bank_transactions where transfer_pair_id = ...))`. AFTER-ROW triggers fire once
the statement's deletes are done, so that subselect finds no rows, returns NULL,
and `assert_same_company` refuses with its deliberately unhelpful `Row not
found`. It is not specific to a company delete — deleting a transfer through the
app hits the same path.

The trigger early-returns when `transfer_pair_id is null`, so the teardown
unlinks SANDBOX's 4 transfer rows (2 pairs) first. A real fix would make
`sync_bank_transfer_journal` return quietly when the pair no longer exists.

## The rehearsal completes — final sequence, 2026-09-02

Ran end to end inside one transaction ending in a deliberate raise. **Drift
across 129 company-scoped tables: NONE.** Post-unwind: `companies=3,
archived_at=2026-09-02 10:25:13, journal=428/1306, employees=69, SSA
view_as=null, sa banned_until=null`. Nothing committed.

The sequence, in order:

| # | act | rows |
|---|---|---|
| 0 | ban `sa@sandbox.test` (`banned_until=infinity`), revoke sessions and refresh tokens; **keep the row** | 1 user, 2 sessions |
| 0b | set `request.jwt.claims` to `sa@sandbox.test` — `current_company_id()` must equal SANDBOX | — |
| 0c | prove 0329 still refuses on 6 probe tables (by message) | 6/6, 0 through |
| 1 | `app.ledger_maintenance = on`; re-probe proves maintenance does **not** lift the archive flag | — |
| 2 | un-archive | 1 |
| 3a | `update bank_transactions set transfer_pair_id = null` | 4 |
| 3 | delete 13 document tables **by `company_id`**, order discovered by retry | 71 |
| 4 | sweep `journal_entries` until it stops regenerating | 535, then 0 |
| 5 | assert all 11 columns referencing `cash_locations` are empty, then delete | 14 |
| 6 | switch to the **unscoped SSA** and delete the company | 1 |

Notes that cost a round each:

- **Step 3 must delete by `company_id`, not by "references a SANDBOX cash
  location".** The third cheque has a null `custodian_location_id`; under the
  narrower predicate it survived to the cascade, where `cheque_apply_balance`
  generated a `bank_transactions` row under the SSA identity, which has no
  company, and `fill_company_id()` produced NULL. Deleting the company's
  documents as documents removes the whole class of problem.
- `expenses` needs a second pass — the retry loop is not decoration.
- 428 -> **535** journal entries after the document deletes, up from 442 when
  fewer documents were removed. The sweep must come last.
- A scoped SSA (`view_as_company = SANDBOX`) also works and was tried, but it
  writes two `audit_log` rows outside SANDBOX. The unscoped SSA leaves **zero**
  drift, so that is the version to run.

Afterwards: GUARDS AND GUIDES 30/3, Sandboxx 30/1, and the production journal is
**0 entries / 0 lines**.

## SANDBOX TESTING ORG is deleted from production, 2026-09-02

Authorised by name. One transaction, the seven-step sequence exactly as
rehearsed, with every post-condition asserted **inside** it so any violation
would have unwound the whole thing. All passed; verified afterwards from a
fresh read.

| step | result |
|---|---|
| 0 | `sa@sandbox.test` banned (`banned_until=infinity`), 2 sessions + all refresh tokens revoked, `auth.users` row kept |
| 0b | acted as `sa@sandbox.test` through steps 3-5 |
| 1 | maintenance session opened |
| 2 | un-archived |
| 3a | 4 bank-transfer links unlinked |
| 3 | **71 rows** across 13 document tables, `expenses` on pass 2 |
| 3b | journal 428 -> **535** from the reversals the deletes generated |
| 4 | swept 535, then 0 |
| 5 | 14 `cash_locations`, all 11 referring columns verified empty first |
| 6 | company deleted as the unscoped SSA |

Post-conditions, asserted then re-read independently:

- **DRIFT across 129 company-scoped tables: NONE**
- **journal 0 entries / 0 lines** (was 428 / 1306); opening balances 0 / 0
- leftovers: `payroll_run_phases` 0, `bank_transactions` 0, `cash_locations` 0,
  `cheques` 0, `payslips` 0
- GUARDS AND GUIDES 30 rows / 3 failing; Sandboxx 30 / 1
- `tenant_guard_gaps()` 0
- `sa@sandbox.test`: `auth.users` present and banned, **profile gone**, 0
  sessions — the JWT-inert-after-profile-deletion case
- the SSA is untouched: `view_as=null, company=null`

Production now carries two companies and an empty general ledger. GGS's first
real entry will be the first entry in the system.

## 0331 on dev, 2026-09-02 — the cron loops skip archived companies

Recorded digest `e4c353783112e4ba9d0111d1cf29d6b4` = file digest, one row.
All three functions read `archived_at` exactly once; no fixtures survived the
probe; no company left archived; `ledger_checks` 28.

Surgery on three of the five scheduled jobs:

| job | schedule | what broke |
|---|---|---|
| `run_scheduled_ledger_checks` | 05:00 daily | writes per company; for an archived one every write is refused **including the failure row its own handler writes**, so it ends at `raise warning` — the silent failure its comment says it exists to prevent |
| `generate_fixed_expense_instances` | 00:05 on the 1st | one INSERT...SELECT across all companies, **no exception handler** — one archived company aborts the monthly run for everybody |
| `run_auto_invoices` | 02:00 on the 1st | same shape, no handler — one archived company's auto-invoice client aborts the monthly invoice run |

Two left alone, deliberately:

- `enforce_subscription_expiry` writes only `public.companies`, which carries no
  0329 trigger, so it does not fail; deactivating a lapsed archived company is
  harmless.
- `invoke_send_compliance_alerts` posts to an edge function — the per-company
  work is in TypeScript, outside this database. **The filter belongs there and
  is outstanding.**

Surgery for all three rather than restatement: `run_auto_invoices` has eight
authors, `generate_fixed_expense_instances` two. `run_scheduled_ledger_checks`
has one (0301) and could have been restated behind a digest, but the change is a
one-line filter and surgery is the safer form of the same edit.

**The proof's first attempt failed on its own defect and that is the finding:**
it counted totals, not deltas, and reported "run_scheduled_ledger_checks wrote 1
delivery row for the archived company" about a row written days earlier. Every
count is now a delta against a baseline taken immediately before the jobs run.
The proof is two-directional — the archived company gets nothing, the
un-archived one gets something, and un-archiving brings the first back — because
"wrote nothing for the archived company" is also true of a job that did nothing
at all.

## 0331 on production, 2026-09-02

Recorded digest `e4c353783112e4ba9d0111d1cf29d6b4` = file, one row. All three
jobs read `archived_at` exactly once. No residue: 0 fixtures, 0 archived
companies, 2 companies, journal 0/0, invoices 0, fixed_expense_instances 0.
Checks unchanged: GGS 30/3, Sandboxx 30/1.

## The compliance-alerts edge function — WRITTEN, NOT DEPLOYED

`supabase/functions/send-compliance-alerts/index.ts`. The cron path loops
`notification_settings` and calls `sendForCompany`, whose failures are caught
per company — so unlike the SQL jobs it would not abort. It is worse than that
in one specific way: **the email is sent before the writes**, so an archived
company keeps receiving its daily digest and only the record of having sent it
fails. The fix reads the archived company ids once and skips them, pushing
`reason: "company_archived"` into the results so the response says what it did
not do rather than omitting it silently.

The test-send path (a super_admin pressing "Send test") is deliberately
untouched: it is an explicit human action, and its `recordDelivery` already
degrades without throwing.

**This needs a deploy to production, which is its own authorisation.**

## 0332 on dev — the digest asymmetry, fixed on the function side

Recorded digest `a356a8c6d1eb5eea538072f55ccfd7ef` = file, one row.

`applied_migration_digests()` now normalises exactly as `check-migrations.mjs`
does: `\r` removed, trailing newlines stripped. Measured before the change:
**production 38 of 353 recorded rows end in a newline (1 contains \r); dev 17 of
95.** Not hypothetical — those are false mismatches already sitting there.

The function is the side that changes because only that direction is safe.
Making the checker stop trimming the file would break every migration whose
recorded text lacks the trailing newline, which is nearly all of them. Trimming
the recorded side is **monotone**: it can only turn a mismatch into a match, and
it cannot hide real drift, because trailing whitespace is not a difference in
SQL. It rewrites no stored row — only the comparison changes.

Surgery, not restatement: three authors (0229, 0241, 0283).

## The bank transfer pair defect — reported, not built

Two defects, and they mask each other. That is the part worth reading twice.

**1. The tenant guard resolves the company from rows the statement is deleting.**
0287 injected into `sync_bank_transfer_journal`:

    perform public.assert_same_company(
      (select distinct bt.company_id from public.bank_transactions bt
        where bt.transfer_pair_id = p_pair_id));

AFTER-ROW triggers fire once the statement's deletes are done, so when both legs
of a pair go in one statement that subselect finds nothing, returns NULL, and
`assert_same_company` refuses with `Row not found`. Deleting a transfer in the
app hits this.

**2. Underneath it, the function would leave an orphan journal entry.** The body
already handles an empty pair — `if v_co is null then return 'no legs'; end if;`
— but it returns BEFORE the block that reverses the existing entry. So the
moment the guard is fixed, deleting a transfer succeeds and leaves its journal
entry standing. Neither defect is visible today because the first makes the
second unreachable.

**The fix, and both halves need the same input.** The trigger knows the company
(`coalesce(old.company_id, new.company_id)`); the function should not have to
re-derive it from a table being emptied.

- add `sync_bank_transfer_journal(p_pair_id uuid, p_company_id uuid)` carrying
  the logic, guarding against `p_company_id` and using it when no legs remain;
- make the `v_co is null` branch **reverse** rather than return, which is only
  possible once the company is passed in;
- keep the one-argument form as a delegator so nothing else changes;
- `journal_on_bank_transaction` calls the two-argument form.

Surgery, not restatement: 0272 wrote it and 0287 amended it, so it has two
authors and no canonical file. It is the only caller — nothing in `src/` or the
edge functions calls it directly.

## 0332 on production, and 0333 on dev — 2026-09-02

**0332** — recorded digest `5b6a1366b0eebf30b0d466ce26291aa1` on BOTH databases,
equal to the file, one row each. `applied_migration_digests()` now normalises
the way the checker does.

Its proof refused on production the first time, and it was right to. Production
carries one **duplicated migration name** — `fix_cheque_treasury_company_scope`,
recorded twice — and the proof joined the function's output on `name`, turning
those 2 rows into 4 pairs and comparing one row's old digest against the other's
new one. It reported two clean rows as having moved. The proof was wrong, not the
change; it now computes the property on `schema_migrations` directly and states
the function's agreement as set membership, which a duplicated name cannot
distort. `check-migrations.mjs` already declines to compare a duplicated key.
**The duplicate itself is untouched and worth its own look.**

**0333** on dev — recorded digest `f59a57f5f7ea7af4ca90be1485a40cce` = file, one
row. Both signatures present (`p_pair_id uuid` and `p_pair_id uuid, p_company_id
uuid`), `tenant_guard_gaps()` 0, `ledger_checks` 28, no probe residue.

Two things the proof caught before anything shipped:

1. **The first delegator silently dropped 0287's guard.** Written `language sql`,
   it passed a NULL company into the two-argument form, whose guard is
   conditional on a non-null company — so the check was skipped entirely for
   every caller holding only a pair id. The control assertion ("the one-argument
   form still refuses") failed, which is exactly what a positive control is for.
   The delegator now keeps 0287's guard VERBATIM and then delegates.
2. **A guard naming only `p_company_id` would have opened a tenant-guard gap.**
   `tenant_guard_gaps()` requires every uuid parameter of a security-definer
   function to be covered, and the new function has two. The guard is therefore
   null-safe rather than replaced:

       assert_same_company(coalesce(
         (select distinct bt.company_id from public.bank_transactions bt
           where bt.transfer_pair_id = p_pair_id),
         p_company_id))

   The pair's own rows still decide where they exist — a pair belonging to
   another company is still refused — and the passed company is the fallback
   where they do not. Each half alone is one of the two wrong answers: without
   the subselect the cross-tenant check is gone, without the fallback the defect
   remains. The migration captures `tenant_guard_gaps()` before the surgery and
   requires before = after.

## The edge function deploy is BLOCKED on a question

The live `send-compliance-alerts` is **version 15 and is behind the repo**. It
does not contain `recordDelivery` at all, which means commit `b0cf56f` — "0300:
prove the delivery, and make a failed send visible to something that is itself
checked" — was committed but **never deployed**. The compliance half of 0300's
delivery instrumentation has therefore never run in production.

Deploying now ships two changes, not one:

1. the archived-company filter, which is what was authorised;
2. all of `b0cf56f` — `notification_deliveries` rows written on every compliance
   send, including the test-send path.

(2) is the user's own committed work, but it is a live behaviour change nobody
reviewed in this session, and an authorisation for (1) is not an authorisation
for it. Not deployed. Asked instead.

## send-compliance-alerts deployed to production — v15 -> v16, 2026-09-02

Repo version, both changes, authorised by name. ACTIVE, `verify_jwt` on.

### What changes operationally

**`notification_deliveries` rows on every compliance send**, channel `email`,
from `b0cf56f` — committed for 0300 and never deployed until now:

| path | row written |
|---|---|
| digest sent | `status='sent'` with the Resend `provider_id` and `item_count` |
| Resend refused | `status='failed'` with the error, then rethrows |
| nothing due | `status='skipped'`, `item_count=0` |
| no recipient configured | **no row** — a company that never opted in is not a delivery problem |
| archived company (new) | **no row is possible** — see below |

The **test-send path also writes**, `status='sent'` with the provider id, on the
caller's company; its failure path writes `status='failed'`. A test send is a
real send, so it counts as evidence the transport works.

### What it means for `alert_delivery_is_healthy`

GUARDS AND GUIDES is red today with **`no_delivery_has_ever_succeeded`** — a
recipient is configured (`guardsguides@hotmail.com`) and there are **0 rows of
channel `email`**, only 1 `in_app` row. The email arm has had nothing to read
since 0300 because the code that writes it was never deployed.

It now has something to read, but **the deploy alone does not turn it green**:

- `alert_delivery_gaps()` requires a row with `status='sent'`. A `skipped` row
  deliberately does not satisfy it — 0300's point was that a permanently broken
  sender must not look healthy on a quiet day.
- So it goes green the first morning GGS actually has an alert due AND Resend
  accepts the message.
- If `RESEND_API_KEY` is unset or the sender domain is unverified, tomorrow's
  06:00 run writes `status='failed'` with the provider's own error and the check
  stays red — but **red for a stated reason instead of a blank one**, which is
  the improvement that matters.
- If GGS never has an alert due, it stays red on
  `no_delivery_has_ever_succeeded`. That is the design working as written, and
  it is worth deciding whether "configured, opted in, nothing ever due" should
  read as a fault.

### Logged, not built: archiving a company will red its delivery check

`alert_delivery_gaps()` has no archived filter, and `ledger_checks()` still
evaluates an archived company (0329 made it read-only, not invisible). So an
archived company with a recipient configured will report `no_recent_delivery`
two days after it is archived and stay red for ever — because the edge function
now correctly skips it, and 0329 would refuse the `notification_deliveries` row
anyway. **The skip cannot be recorded in the table; the only evidence is
`reason: "company_archived"` in the response.** A fix belongs in
`alert_delivery_gaps()` (return nothing for an archived company) or in
`ledger_checks()` (skip archived companies entirely). Not built.

## 0333 on production, 2026-09-02

Recorded digest `f59a57f5f7ea7af4ca90be1485a40cce` — equal to the file and
identical to dev. One row. Both signatures present.
`tenant_guard_gaps()` **0**. Journal still **0 entries / 0 lines** — the probe
posted an entry, reversed it and unwound. Checks unchanged.

## Logged, not chased: a duplicated migration name on production

`fix_cheque_treasury_company_scope` is recorded **twice** in
`supabase_migrations.schema_migrations` on crm-design. `check-migrations.mjs`
declines to compare a duplicated key (`if (rs.length !== 1) continue`), so it is
currently invisible to the very thing that would report it — the ledger has a row
whose SQL nothing checks. Found because 0332's first proof joined on `name` and
was distorted by it.

## GGS's two remaining reds, resolved before financials — 2026-09-02

### `no_gate_mode_in_attendance_status` = 24 — RESIDUE, and the write path is closed

All 24 rows are one employee: **Aamir Shabbir, GGS-00408**, attendance
**2026-07-01 to 2026-07-24**, with a **join date of 2026-08-01**.

That is a stronger reading than "seed data". The rows are not merely odd — they
are *impossible*: a month of attendance for a guard who had not joined. They
cannot be real operational data, whatever else they are. Shayan's ruling stands
and now has a reason attached.

**No financial consequence:** the employee has **0 payslips**. Nothing was ever
paid against these rows, so they are not in the posting path and cannot enter it
retroactively — payroll reads confirmed attendance for a period, and this
employee has no payslip in any period.

**The write path is closed.** `trg_reject_gate_mode_as_status` is on
`attendance_records` for **INSERT and UPDATE** and refuses `status = 'blocked'`
on insert, and on any update that changes status to blocked. Only a maintenance
session bypasses it. It deliberately permits updating a row that is ALREADY
blocked without changing its status, so the existing 24 remain editable — but
the count cannot grow. **24 is a ceiling, not a running total.**

### `every_control_is_invoked` = 11 — one real finding, one false positive, nine dead reports

`ledger_checks` is NOT on the list: 0301's cron cleared it, as expected.

**The one that matters — a control nobody calls:**

- `bonus_accrual_missing(p_company_id uuid, p_period date)` — a *detector*, the
  only function on the list. Nothing calls it: not a view, policy, constraint,
  index, default, trigger or cron. A missing-accrual control that never runs is
  precisely the defect this check was written to name. It sits with
  `bonus_reserve_balances` and `payslip_reward_breakdown`, both also unread —
  **the whole bonus subsystem is wired to nothing.**

**The false positive — and it is one we created:**

- `journal_lines_regional` is read by the application:
  `JournalView.tsx` lines 193 and 275 do `.from("journal_lines_regional")`.
  `uninvoked_controls()` cannot see `src/`, so it relies on a hand-maintained
  `view_exempt` map whose header says it was "established by grep over src/ and
  supabase/functions/ on **2026-09-01**". The map has 17 entries and does not
  include this view. **The check is wrong about this one**, and it is the ledger
  drill-down screen, so it is the last view that should read as dead.

**The nine genuinely unread reporting views:** `bonus_reserve_balances`,
`compliance_weekly_review`, `contract_amendment_history`,
`employee_service_history`, `interregion_balances`, `kpi_department_dashboard`
(RegionalScorecard.tsx's own comment says it is "no longer" used),
`low_stock_items`, `payroll_run_totals`, `payslip_reward_breakdown`.

`low_stock_items` looked like a reader — `supabase/functions/ai-chat/index.ts`
has a tool named `get_low_stock_items` — but the handler queries
`inventory_items` directly. A naming coincidence, checked rather than assumed.

**Verdict for Shayan: neither red is in the posting path, and neither blocks
entering financials.** One is impossible data behind a closed door; the other is
a stale map entry plus a genuinely unwired bonus subsystem and nine unread
reports.

## The other sandbox: STOP — `Sandboxx` does not look like fixture data

Measured before touching anything. It is trivially deletable — **18 tables, 154
rows**, 0 journal entries, 0 cash_locations, 0 bank_transactions, 0 payroll
phases, 0 documents of any kind. None of what made SANDBOX hard is present; this
is the `guards n guides` shape and a single statement would do it.

That is not the problem. The problem is what it contains:

- **`muzammil@techxserve.com`, a live `super_admin`** — created 2026-08-08,
  email confirmed, signed in the same day, not banned. `profiles.company_id` is
  CASCADE, so deleting the company **deletes that person's profile**, leaving
  their `auth.users` row inert. It is the only profile on production that is not
  GGS's or the SSA's.
- **A real signup and real billing:** 1 `signup_intents` row, 1
  `subscription_payments` row, 3 `billing_events`. `billing_events` and
  `signup_intents` are SET NULL on companies, so those rows would **survive with
  a null company** — orphaned billing records pointing at nothing.
- Created 2026-08-08, `active = true`, never archived.

That reads as a genuine self-service tenant signup by a TechXserve colleague, not
as fixture data. The name resembles SANDBOX TESTING ORG; the contents do not.

**Not deleted. Not archived. Nothing touched.** If it is genuinely disposable the
delete is quick, but it removes a colleague's account and orphans a payment
record, and that is not a call to make from the name alone.

## Sandboxx deleted from production, 2026-09-02

The concern above was raised and the decision reaffirmed, so it was carried out.
Exported first to `exports/sandboxx-2026-09-02/` (18 tables, 154 rows, plus the
auth.users row with password and token columns stripped) because the delete
destroys a real payment record.

Rehearsed inside a transaction ending in a raise, then done, with post-conditions
asserted inside the same transaction as the delete.

**One statement, no ordered teardown** — 0 journal entries, 0 cash_locations, 0
bank_transactions, 0 payroll phases, 0 documents. The `guards n guides` shape.

| | |
|---|---|
| companies | **GUARDS AND GUIDES (PVT) LTD**, alone |
| `muzammil@techxserve.com` | profile CASCADE-deleted; **auth.users present, NOT banned** — access is restorable by creating a profile against a company |
| `subscription_payments` | **0 database-wide** — Sandboxx's 1 row was CASCADE-deleted. Only in the export and the 13:37 backup |
| `billing_events` | 3 orphaned (SET NULL), joining 3 already orphaned |
| `signup_intents` | 1 orphaned, joining 1 already orphaned |
| drift | none beyond the SET NULL orphaning, which was asserted as the ONLY permitted movement |
| journal | 0 / 0 · `tenant_guard_gaps()` 0 · GGS 30 rows, 3 failing |

### A note the rehearsal turned up: `is_ssa_unscoped()` was false

The first rehearsal refused at its own actor check. The SSA's
`view_as_company` is set to GUARDS AND GUIDES — someone is using the view-as
feature — so `is_ssa_unscoped()` returns false, and the SANDBOX playbook's
"switch to the unscoped SSA" step does not transfer. **Live user state, not
something to clear.** The delete ran with **no identity at all** instead:
`assert_same_company` returns early for a caller with no JWT, and
`guard_super_admin_mutations` allows when `current_role()` is null. Nothing in
Sandboxx generated rows, so there was nothing for `fill_company_id` to get wrong.

### Logged: every company delete leaves its billing trail orphaned

`billing_events` and `signup_intents` are SET NULL on companies, so both of
today's deletes left their rows behind with a null company: **6 billing_events
and 2 signup_intents now point at nothing**, and no company owns them. Nothing
reads them today and nothing is wrong, but it accumulates one set per deleted
company and there is no check that would ever mention it.

## 0334 on dev — the map knows the journal drill-down reads a view

Digest `cdb5c9f5669e4b8bd44dc3d4f3cb50fa` = file, one row.
`uninvoked_controls()` **11 -> 10** (view arm 10 -> 9, function arm 1);
`journal_lines_regional` off the list; the header warning is present.

Surgery on a four-author function (0288, 0288b, 0294, 0307). Two anchors, each
asserted once. It follows 0307's precedent with one correction: **0307 asserted
the resulting count against the literal 11.** Dev and production do not hold the
same number, so this reads the count before the edit and requires exactly one
row fewer. It also asserts the view arm did not merely stop looking — "it
stopped complaining" and "it stopped looking" are the same observation without
that control.

The map header now says out loud that it is hand-maintained, that it goes stale
on every new consumer, and that a green view arm means "nothing new since the
last grep" rather than "nothing is unread".

## Proposed, not built: a lint that catches a stale map

**The failure to catch:** a view is read in `src/` and is absent from the map, so
the check calls it dead. That is what happened here, within a day.

**The cheap form — do not rebuild the map, test the check's output against
`src/`:**

    for each row of uninvoked_controls() where kind = 'view':
      if any file under src/ or supabase/functions/ contains  .from("<name>")
        FAIL: 'uninvoked_controls() calls <name> dead, but <file>:<line> reads it'

About thirty lines beside `check-migrations.mjs`. Properties that make it worth
having:

- **It cannot cry wolf.** A `.from("x")` IS a read. Every failure is real, which
  is the property `migration-aliases.txt`'s warning is about.
- **It is bounded by the failure, not the schema.** It greps only the handful of
  names the check currently reports — today 9 — not all 60-odd views.
- **It needs no second copy of the map.** The map stays where 0294 put it; the
  lint checks the *consequence*, so the two cannot drift apart.

**The caveat, and it is the same one that limits `check-migrations.mjs`:** the
lint has to call `uninvoked_controls()`, and there is no read-only production
credential. `.env.local` carries anon keys, and 0241 revoked anon EXECUTE. So it
runs today only against a database an operator can reach interactively, not in
CI, until a read-only service credential exists — the item already logged in
CLAUDE.md under Credentials.

**The direction it cannot check:** a view that stops being read but stays in the
map is not reported by the check and would not be reported by this lint either.
That is a false silence rather than a false alarm, and catching it needs the map
itself — `select prosrc from pg_proc where proname = 'uninvoked_controls'` and
parse the tuples. Doable, more fragile, and it fails in the safe direction, so
it is the optional second half rather than the first.

## Logged as ONE decision, not three: the bonus subsystem is wired to nothing

`bonus_accrual_missing(p_company_id, p_period)` is a detector nothing calls.
`bonus_reserve_balances` and `payslip_reward_breakdown` are views nothing reads.
Those are not three separate dead objects — they are one subsystem that was
built and never connected: the control that finds missing accruals, the balance
it would report against, and the breakdown that would show it.

**This is Shayan's call, and it is a policy question, not a cleanup one:** does
this system enforce bonus accrual? If yes, the detector wants wiring into
`ledger_checks()` or a cron and the two views want a screen. If no, all three
should go, and `every_control_is_invoked` drops by three at once.

Either answer is defensible. What is not defensible is leaving a *detector* in
place that never runs, because that is precisely the shape
`every_control_is_invoked` exists to name — a control reporting nothing while
doing nothing.

## 0334 on production, and the lint — 2026-09-02

**0334** digest `cdb5c9f5669e4b8bd44dc3d4f3cb50fa` — equal to the file and
identical to dev. One row. `journal_lines_regional` off the list;
`uninvoked_controls()` **10 total (9 views, 1 function)** on both databases.

**`scripts/check-view-readers.mjs`** — the inversion, built. For every view
`uninvoked_controls()` calls dead, it fails if any file under `src/` or
`supabase/functions/` does `.from("<name>")`. It holds no copy of the map, so
the two cannot drift; it greps only the names the check reports, not the whole
schema; and every failure it can produce is real, because a `.from("x")` IS a
read.

Its header states, in a box, that it is **interactive-only and that CI is not
covering it**, with the reason: `uninvoked_controls()` is SECURITY DEFINER, 0241
revoked EXECUTE from anon, and there is no read-only production credential —
the same limitation as `check-migrations.mjs`, already in CLAUDE.md.

It also carries `--self-test`, which needs no database: it runs the real source
scan against a fixture pair — one name `src/` demonstrably reads
(`journal_lines_regional`) and one that cannot exist — and requires exactly one
hit. Without it the script could only ever be exercised by someone holding a
service key, and a checker nobody can run is a checker that quietly stops
working. Verified: **215 files scanned, found at JournalView.tsx:193 and :275,
control name correctly absent.**

The second direction — a view that stops being read but stays in the map — is
deliberately not checked. False silence, fails safe, and parsing the map out of
`prosrc` to catch it is more fragile than the thing it protects.

## DECISION FOR SHAYAN — the bonus subsystem, one call with both options costed

Not in the posting path. Does not block financials. **Do not act either way
without his answer.**

Three objects, one subsystem, built and never connected:

| object | what it is |
|---|---|
| `bonus_accrual_missing(p_company_id, p_period)` | a detector — finds periods with no accrual |
| `bonus_reserve_balances` | the balance it would report against |
| `payslip_reward_breakdown` | the breakdown that would show it |

**Option A — wire it up.** The detector goes into `ledger_checks()` (or a cron
beside `run_scheduled_ledger_checks`), and the two views get a screen or are
read by whatever surfaces the accrual. Cost: a migration to add the check, a
decision about what the check's threshold is, and UI work for the views.
Benefit: bonus accrual becomes an enforced invariant like every other posting
rule, and `every_control_is_invoked` drops by three.

**Option B — remove all three.** One migration dropping the function and the two
views. Cost: whatever intent they encoded is lost, and if bonus accrual matters
later it is rebuilt from nothing. Benefit: the same three rows leave the report,
and no dead control remains to mislead a reader.

**What is NOT an option is leaving it as it is.** A detector that never runs is
exactly the shape `every_control_is_invoked` was written to name — a control
reporting nothing while doing nothing. Equally, deleting a control someone
intended is not a cleanup decision to take on someone else's behalf. Hence: his
call, both costs stated, no action taken.

---

# 4. Referral commission — DEFERRED, and the three tables stay

**Status: specced, not built, not dead. Do not purge these as orphans.**

| object | rows on prod | reads it | writes it |
|---|---:|---|---|
| `referral_arrangements` | 0 | `ProfitDistribution.tsx` | `ProfitDistribution.tsx` |
| `profit_distribution_rules` | 0 | `ProfitDistribution.tsx` | `ProfitDistribution.tsx` |
| `profit_distribution_rule_lines` | 0 | `ProfitDistribution.tsx` | `ProfitDistribution.tsx` |

All three are from `0078b_missing_base_tables.sql`. Nothing in the posting path
touches any of them: no allocation function, no check, no trigger. The only
caller is a screen with no nav link.

Shayan confirms referral commission is a **real arrangement at GGS**. It is
therefore not a feature nobody wanted — it is a feature nobody has yet decided
the accounting for, and it should not hold up his start.

## The question that has to be answered before anything is built

> Safi refers a client in Lahore. Shafqat runs Lahore and takes his percentage
> on it. **Where does Safi's cut come from?**
>
> - **Off the top** (`OFF_THE_TOP`) — taken before any share is calculated. The
>   company bears it, and every partner's share shrinks slightly.
> - **Partners only** (`PARTNERS_ONLY`) — taken out of the partner pool, so
>   Shafqat bears it and equity is unaffected.
> - **Custom split** (`CUSTOM_SPLIT`) — decided per arrangement, with the
>   split named on the arrangement itself.

Two more, which are the same size of question and are not answered anywhere:

- Is the rate a **percentage of that client's Net Cash**, or of something else?
  (Net Cash is what `partner_remuneration_basis` currently resolves to for GGS
  — see `LEDGER_PHASE1_POSTING_RULES.md` and A4.)
- Does it run **in perpetuity**, or for a **fixed term** from the referral?
  Perpetuity and "first 24 months" are different columns, not different values.

## Why the tables are the reason not to delete the tables

`referral_arrangements.funding_method` already carries exactly those three
values, constrained:

```sql
funding_method text not null default 'OFF_THE_TOP'
  check (funding_method in ('OFF_THE_TOP', 'PARTNERS_ONLY', 'CUSTOM_SPLIT')),
custom_split_lines jsonb,
```

along with `basis in ('CLIENT_PROFIT','BRANCH_PROFIT')`, a `percentage`, a
`client_id` and a `source_branch_id`. That schema **is** the written record of
the requirement — it is the only place the three funding methods are enumerated
anywhere in the repo. Dropping the tables would delete the specification along
with the storage, and the conversation would restart from nothing.

It also has no `term_months` and no `effective_from`, which is how we know the
perpetuity question was never answered rather than answered and forgotten.

## Consequence, stated so nobody has to re-derive it

The 0078b subsystem is **neither wired nor removed**. That is a deliberate
resting state, not an oversight:

- Leaving it wired to nothing costs three rows on `every_control_is_invoked`
  and nothing else — no posting behaviour depends on it, and all three tables
  are empty.
- Removing it costs the specification above.

Compare the bonus-subsystem decision in section 3: there, "leaving it as it is"
was explicitly *not* an option, because a detector that never runs actively
misleads a reader into thinking something is being checked. These three tables
check nothing and claim to check nothing. An empty table is not a false
assurance; a silent detector is. That is the whole difference, and it is why
this one is allowed to wait and that one is not.

**Revisit when:** the funding-method question above has an answer. Not before.
