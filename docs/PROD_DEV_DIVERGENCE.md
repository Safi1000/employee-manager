# Prod ↔ dev divergence, and the classification of the 19

Read-only survey of `crm-design` (`mmkfpnshxjcyijhuydgr`) against `crm-design-dev`
(`wlyhbvunvdsropqzlpwx`), plus the classification of the migration-ledger
discrepancies. One prod write was made, named and approved separately; it is
recorded at the foot of this file.

---

## Part 1 — Schema and function diff

Object counts, `public` schema:

| Class | Prod | Dev | Net |
|---|---:|---:|---:|
| Tables | 137 | 136 | prod +1 |
| Columns | 1819 | 1813 | prod +6 |
| Functions | 279 | 279 | — |
| Triggers | 275 | 274 | prod +1 |
| Constraints | 709 | 710 | dev +1 |
| Indexes | 420 | 421 | dev +1 |
| Views | 38 | 38 | — |
| Policies | 271 | 273 | dev +2 |
| Enum labels | 333 | 333 | — |

Every class except enums differs. Rolled up per table, **six tables** account for
all of the table-side difference.

### 1.1 Tables

**`employee_branch_realign_backup_20260618` — prod only.** The 0111 backup table,
with its RLS policy. It accounts for prod's +1 table, +6 columns, and its
`ssa_only` policy. Dev never had it. This is the table 0231 dates for drop on or
after 2026-12-31; nothing to do here.

**`attendance_confirmations`.** Dev still carries
`attendance_confirmations_site_id_shift_code_attendance_date_key` — `UNIQUE
(site_id, shift_code, attendance_date)` — and its backing index. Prod has dropped
it, keeping only the company/group_key unique index. This is
`attendance_confirmations_optional_scope` (repo 0234): prod has the effect,
**dev does not**. It accounts for dev's +1 constraint and +1 index.

The functional consequence is not cosmetic. On dev, a confirmation with a NULL
`site_id` collides with any other NULL-site confirmation for the same shift and
date under the old unique constraint, while on prod it does not. Non-client
attendance groups behave differently between the two databases.

**`partner_account_entries`.** The same foreign key under two names:
prod `fk_pae_cash_location`, dev
`partner_account_entries_cash_location_id_fkey`. Identical definition. Pure
naming drift from two different apply channels — one hand-written, one
auto-named.

### 1.2 Policies

Dev carries an extra `company_isolation` policy on **`cash_locations`**,
**`custody_transfers`** and **`partner_account_entries`**:

```sql
company_id = (select profiles.company_id from profiles where profiles.id = auth.uid())
```

Prod has dropped all three in favour of `company_members`
(`company_id = current_company_id()`), which is the current idiom everywhere
else. Dev's three are leftovers — `company_isolation` is created by
`0078b_missing_base_tables`, which is one of the files reverse-engineered *from*
prod and therefore describes an older prod than the one that exists now.

Harmless in effect (both policies are permissive and `ALL`, so they union), but
they are the only three tables in either database still resolving company scope
through a `profiles` subquery rather than `current_company_id()`.

### 1.3 Triggers

**`invoice_reminders` has `trg_aaa_invrem_fill_company` on prod and no trigger at
all on dev.** Prod's +1 trigger. A reminder inserted on dev without an explicit
`company_id` gets a NULL one; on prod the trigger fills it. Any test of reminder
scoping written against dev is testing a table that behaves differently in
production.

### 1.4 Views — `regional_scorecard`

The only view that differs, and it differs meaningfully:

| | |
|---|---|
| Prod | `interregion_net_position(company_id, id) AS inter_region_balance` |
| Dev | `NULL::numeric AS inter_region_balance` |

Dev's column is stubbed. The other 37 views are identical.

### 1.5 Functions — 12 differ, not 247

A first pass comparing whitespace-normalised bodies flagged 15 of 22 name
buckets. That was misleading. Two causes were inflating it:

1. **Dev stores function bodies with CRLF line endings**, prod with LF. Both
   normalise away, but they were part of why the raw digests differed everywhere.
2. **Comment-only differences.** Dev's `billable_guard_count` carries a two-line
   explanatory comment prod lacks; the SQL is identical.

Comparing comment-stripped, whitespace-normalised bodies leaves **12 of 279**
functions differing:

| Function | Prod | Dev | Reading |
|---|---:|---:|---|
| `enforce_period_lock()` | 2130 | 1447 | **prod +683 — see below** |
| `attendance_gate(uuid,date,integer)` | 2051 | 1575 | prod +476 |
| `partner_ledger(uuid,date,date)` | 5783 | 5161 | prod +622 |
| `invoke_send_compliance_alerts()` | 863 | 1038 | dev +175 — dev has 0235 |
| `fund_region(...)` | 978 | 1086 | dev +108 |
| `run_auto_invoices(date)` | 2089 | 2080 | prod +9 |
| `transition_payroll_run(...)` | 2090 | 2104 | dev +14 |
| `ai_credit_reset_period(uuid,numeric)` | 1024 | 1016 | prod +8 |
| `ai_credit_spend(...)` | 1306 | 1296 | prod +10 |
| `ai_credit_status(uuid)` | 417 | 418 | dev +1 |
| `billing_summary()` | 851 | 852 | dev +1 |
| `is_attendance_locked(uuid,date)` | 340 | 341 | dev +1 |

The three one-character rows are **formatting, not semantics**. Verified for
`is_attendance_locked`: the bodies are character-identical apart from a space
after `coalesce(`. My normaliser collapses runs of whitespace but does not remove
a single space before a parenthesis, so it under-reports similarity. Treat
`is_attendance_locked`, `billing_summary` and `ai_credit_status` as equal, and
the honest count as **nine functions with real differences, at most**.

#### `enforce_period_lock()` is the one that matters

Prod carries three carve-outs that dev has never had:

```sql
-- payslips UPDATE where period_month is unchanged  -> allowed
-- invoice_payments INSERT                          -> allowed
-- invoices UPDATE touching only amount_received    -> allowed
```

**Dev's period lock is strictly harsher than production's.** On prod a receipt
can be recorded against a closed month; on dev the same insert raises P0001. Any
test of period-close behaviour written and run against dev is testing a rule
production does not enforce — and the failure mode is the dangerous direction:
dev refuses, so a test asserting the refusal passes, while production quietly
allows it.

The cause is in Part 2: the three migrations that added those carve-outs exist on
prod and **have no repo file at all**, so dev — built from the repo — could never
have received them.

`partnership_allocation(date,date,text)` is byte-identical on both
(`a39424`), as is `run_ho_cost_allocation` and `ledger_checks`.

---

## Part 2 — Classifying the ledger discrepancies

After the 11 alias pairs: **19 in repo with no recorded row on prod**, **27
recorded on prod with no repo file**.

### 2.1 The 19 — every effect is present on prod but one

Probed each against prod's live schema.

| # | File | Effect on prod | Class |
|---|---|---|---|
| 1 | `RUN_0065_0070_combined.sql` | `contract_lines` present via 0065–0070 individually | **not a migration** — a combined runner |
| 2 | `0200_addendum_shift_code` | `contract_addendums.shift_code` present | (b) applied, unrecorded |
| 3 | `0234_attendance_confirmations_optional_scope` | `client_id`/`site_id` both nullable | **(d) documents prod** |
| 4 | `0014_attendance_sa_lock` | both SA-lock policies + `trg_attendance_stamp` present | (b) |
| 5 | `0058_auto_zero_monthly_accounts` | `apply_monthly_account_zeroing()` present | (b) |
| 6 | `0043_backfill_new_permissions` | data-only `UPDATE profiles` | (b) — data, not structurally probeable |
| 7 | `0009_clear_role_backfill_permissions` | data-only `UPDATE profiles` | (b) — as above |
| 8 | `0235_compliance_alerts_url_per_environment` | **ABSENT** — prod's function still hardcodes the URL, no `project_url` vault lookup | **(e) genuinely not applied** |
| 9 | `0060_deposit_cheques_and_cash_deposit` | `cheque_apply_balance()` present | (b) |
| 10 | `0109_fire_clearance_salary_and_attendance_window` | `employee_clearance_gates()` present, 19 clearance columns | (b) |
| 11 | `0053_fix_attendance_sa_lock_upsert` | policies present | (b) |
| 12 | `0012_invoice_withholding_tax` | `invoices.withholding_tax` present | (b) |
| 13 | `0078b_missing_base_tables` | `custody_transfers`, `expense_receipts` present | **(d) documents prod** |
| 14 | `0179b_missing_prod_columns` | `attendance_confirmations.group_key` present | **(d) documents prod** |
| 15 | `0079b_partners_missing_columns` | `partners_scope_check` present | **(d) documents prod** |
| 16 | `0108_payroll_exceptions_and_attendance_lock` | `payslip_adjustments` present | (b) |
| 17 | `0059_reattach_period_lock_triggers` | `enforce_period_lock()` present | (b) |
| 18 | `0042_sprint5_double_entry_journal` | `journal_entries` + `journal_lines` present | (b) |
| 19 | `0013_standalone_invoice_payments` | `invoice_payments.invoice_id` nullable, `client_id` present | (b) |

Summary of the 19: **1 is not a migration**, **4 document prod rather than
changing it**, **13 are genuine unrecorded applies**, and **1 (`0235`) has never
run on prod at all**.

`sprint5_double_entry_journal`, `standalone_invoice_payments`,
`invoice_withholding_tax` and `fire_clearance_salary_and_attendance_window` are
all category (b): they built the finance layer, they ran, and nothing recorded
them. They are not naming drift — the assessment in the brief was right.

**Category (d) needs marking in the files themselves.** `0078b`, `0079b`, `0179b`
and `0234` were reverse-engineered from production. They are documentation of a
state prod already had, not migrations that ran. Left unmarked, a fresh
environment applies them as if new — which is harmless for the additive ones but
misleading, and `0078b` is already actively wrong: it recreates the
`company_isolation` policy that prod has since dropped, which is exactly why dev
still has three of them. Each should carry a header saying it describes prod as
of a date, and `0078b` should be reconciled with prod's current policy set.

**`0235` is safe to apply but should be applied deliberately.** Its own fallback
resolves to the same URL prod already uses, so behaviour does not change; the
point of applying it is that a rebuilt non-prod environment stops firing its
nightly job at production's edge function. Dev already has it.

### 2.2 The 27 — all category (c), and all recoverable

Every one of the 27 has its SQL stored on prod (`statements` is populated for
all). None has a repo file, and fuzzy matching found only four near-misses, all
of which are distinct migrations rather than renames:

- `attendance_catchup_sync_v2` vs repo `0188_attendance_catchup_sync` — a
  successor, not the same file
- `change_category_enum_cast_v2` vs repo `0148`/`0184` — likewise
- `enforce_contract_line_headcount_revoke_execute` vs repo `0168` — a follow-up
  `REVOKE`
- `partner_ledger_fix_variable_conflict` vs repo `0209`/`0210` — a third distinct
  fix

The remaining 23 have no repo counterpart under any spelling.

**The three that explain §1.5:**

```
allow_disbursement_and_invoice_payment_in_closed_period   20260629153920
allow_invoice_receivable_update_in_closed_period          20260630133438
narrow_invoice_receivable_period_lock_exemption           20260630133606
```

Grepping the whole of `supabase/migrations` for the carve-out text finds nothing.
These three rules govern whether money can move in a closed period. They exist
only in production, and only as rows in `schema_migrations`.

`regional_pl_range` (20260807203007) is the same shape: the function that Phase 1
is retiring was *created* by a migration that has no repo file. The repo only
ever modifies it.

Because all 27 carry their SQL, recovering them is mechanical: read
`statements[1]`, write it to a numbered file, verify the digest. That is the
recommended next step and it is not destructive — but it is a repo change of some
size and it is not started here.

### 2.3 A detector gap this survey exposed

The checker compares migration **stems** as a set. Three stems are not unique in
the repo:

```
6  drop_partnership_allocation      (0179c 0182c 0203b 0205b 0224b 0231b)
2  change_category_enum_cast        (0148 0184)
2  fix_cheque_treasury_company_scope
```

Prod records `drop_partnership_allocation` **once**; dev records it **six times**.
Set comparison reports zero discrepancy for that stem in both directions, because
one match satisfies it. **Five missing migrations are invisible to the check.**

`scripts/check-migrations.mjs` must compare multisets — count per stem, not
presence per stem — or the number-plus-stem pair rather than the stem alone.
This is not fixed here.

### 2.4 Dev's ledger records no SQL

Every row in dev's `supabase_migrations.schema_migrations` has `statements` NULL.
Dev's ledger is names only.

This corrects something I reported earlier. I said dev's `0224b` held superseded
text; it holds no text. Nothing on dev can drift from a file, because dev records
nothing to drift — and equally, **the digest check can never verify dev**. Any
claim that dev's recorded SQL matches the repo is vacuous.

Re-applying `0224b` to dev was therefore dropped: dev already has a row for it,
and applying again would add a duplicate row carrying SQL in a format no other
dev row uses, making dev's ledger internally inconsistent to fix a problem it
does not have.

---

## Part 3 — The approved prod write

Scope: `0231b` on `crm-design` (`mmkfpnshxjcyijhuydgr`), that change only.

Prod's `0231b` row (version `20260831072730`) held the superseded
version-string guard. It now holds the current file, verified byte-exact:

```
recorded md5 = e94ff7d2965496c23cea7d1352021ea4 = md5(0231b file)
```

**Mechanism differs from the word "re-apply", deliberately.** `apply_migration`
would have inserted a *new* row under a new timestamp and left the stale row in
place — two rows with the same name, one of them still wrong, which is further
from "recorded SQL equals the file" than where we started. The row's
`statements` was updated in place instead. One row, one statement, digest
matches. Nothing else on prod was touched.

The digest was recorded against the **LF** form of the file. The working copy on
this Windows checkout is CRLF; git's stored object is LF, which is the canonical
form and the one a Linux runner would apply. Worth knowing before anyone
recomputes a digest on Windows and reports a false mismatch.

### One that is still drifted, and was not touched

Prod's recorded `0232` is 9175 characters; the file is 14804. Both substantive
fixes **are** in the recorded version — the `if exists` on the drop and the
section-2 fallback guard both verified present — so the recorded migration is
functionally the current one, and the ~5600-character gap is commentary added
after the apply.

It is still a digest mismatch and by the standard in `CLAUDE.md` it should be
corrected the same way. It was not, because the approval named `0231b` and
nothing else.
