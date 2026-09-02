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
