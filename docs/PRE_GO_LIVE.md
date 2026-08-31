# Required before live finance

Blocking items. Each one is here because something is unverified, not because
it is known broken — which is the point: an unexercised mechanism in a system
about to carry real money is a defect until it has been run.

---

## 0. Tenant isolation — closed on dev, NOT on production

**Status: fixed and proved on `crm-design-dev`. Production still carries the
whole hole except the two items already approved and applied there (0240, 0241).
Applying 0242 / 0242b / 0242c / 0243 to production needs a named approval and is
the single largest remaining go-live blocker.**

Multi-tenant isolation is enforced almost entirely by RLS policies, and **a
SECURITY DEFINER function has no caller RLS** — that is what the mode means. The
audit found the problem was three times larger than first reported:

|  | count |
|---|---:|
| SECURITY DEFINER functions in `public` taking a uuid | 140 |
| …that checked the caller's tenant | **2** |
| …with no authorisation check of any kind | **134** |
| of those, writes | **77** |

The first pass said 46. That filter asked whether a body *mentions* `company_id`
and read a mention as a check. `post_journal` mentions it eleven times and never
compares it to the caller's. **59 functions took `p_company_id` as a parameter** —
the caller simply names the tenant it wants to act on, no id-guessing required.

### What is done, on dev only

* **0240** — RLS enabled and all grants revoked on
  `deployments_overlap_backup_0183` and `org_copy_map_0186`. **Also applied to
  production** by named approval.
* **0241** — `EXECUTE` revoked from `anon` and from `PUBLIC` on every function in
  `public`, plus default privileges for future ones. **Also applied to
  production** by named approval. The grant-back list is empty; verified
  externally against both databases with the real shipping anon key.
* **0242 / 0242b** — `assert_same_company` added to 135 functions, in two
  distinct and separately labelled patterns (`[resolved]` for an object id,
  `[claimed]` for a `p_company_id` parameter).
* **0242c** — fixes the fact that 0242's guard **never fired**. It exempted
  trusted backends with `current_user`, and SECURITY DEFINER *sets*
  `current_user` to the function owner, so the test matched for every caller.
  Detection now uses `auth.uid()` and the JWT role claim, which survive
  SECURITY DEFINER, and fails closed on unparseable claims.
* **0243** — `tenant_guard_gaps()`, a standing check that returns any SECURITY
  DEFINER function reachable by `authenticated` that takes a tenant-scoped uuid
  and is not correctly guarded. It tests the property directly rather than
  inferring from name, volatility or return type, because that heuristic
  misclassified four functions in a single pass.
* **`supabase/tests/tenant_guard.sql`** — proves it. 135 of 135 refused a
  foreign company; none refused its own; zero gaps. Verified able to fail by
  removing a guard and confirming red.

### Residuals, deliberately left open

1. **`is_action_approved` is exempt and does leak a boolean.** It takes a
   polymorphic `(p_ref_table, p_ref_id)` pair, so there is no single table to
   resolve against and the mechanical pattern cannot apply. It discloses
   *whether an action was approved* for another company's ref_id — no amounts,
   no names. Closing it needs a per-`ref_table` resolver, which is its own
   change.
2. **`FORCE ROW LEVEL SECURITY`: pre-check done, and the answer is that it
   would change nothing.** Not a blocker. Details below in item 8 — the earlier
   framing of this line was wrong about the cause.
3. **The two backup tables still exist and need retention dates.** Neither is
   droppable yet: three SECURITY DEFINER functions still write
   `deployments_overlap_backup_0183`, and `org_copy_map_0186` is the audit trail
   of the guards-n-guides org clone. Give both a dated comment the way 0111 got
   one. **Review date: 2027-02-28.** Dropping beats securing.
4. **Nine of the 59 `p_company_id` functions should not take that parameter at
   all** — see `docs/TENANT_GUARD_REPORT.md`. A signature change is its own
   migration and is not urgent now that the guard checks the claim.


## 1. Period Close has never been exercised. Anywhere.

> **Two defects found while auditing the lock's test coverage, both of which
> become live at the first close. See `docs/PERIOD_LOCK_COVERAGE.md`.**
>
> * **`journal_lines` is not guarded by the period lock at all.** The trigger is
>   on `journal_entries` only, so a *balanced* restatement of a closed month's
>   ledger commits with no refusal — verified, entry debits moved 48,533 ->
>   49,533 in a closed month. The deferred balance constraint is not a backstop;
>   it only catches an edit that unbalances.
> * **Four `invoices` columns ride along with a receipt into a closed month** —
>   `subtotal`, `total_due`, `tax_withheld_total`, `previous_balance`. The
>   carve-out pins five columns by name and says nothing about the rest.
>
> Magnitude of both is **zero rupees today** — `accounting_periods` is empty on
> both environments, so nothing has ever been protected — and unbounded from the
> first close onward. Neither is fixed; both are reported for a decision.

**Status: required, not started.**

`accounting_periods` is **empty on production and on dev**. Zero months have
ever been closed, in either environment, ever. The period lock — seven triggers
across `advances`, `cheques`, `expenses`, `invoice_payments`, `invoices`,
`journal_entries` and `payslips` — has therefore never fired against real usage,
and neither has reopening.

`supabase/tests/period_lock.sql` (added with 0237) covers the trigger logic and
passes 16/16 on dev. That is not the same thing. It closes a month
programmatically inside a rolled-back transaction; it does not exercise the
Period Close **screen**, the RPCs behind it, the permission checks, what the UI
does when a write is refused, or reopening through the product.

### The exercise

Run end to end on **dev**, against sandbox data:

1. Close a month through the application, not through SQL.
2. Attempt every write the lock should refuse — an expense, a cheque, an
   advance, a manual journal entry, an invoice edit, a backdated receipt, a
   payslip pay change — and confirm each is refused **and that the refusal
   reaches the user as something they can act on**. A P0001 surfacing as a raw
   Postgres string in a toast is a fail.
3. Attempt every write the lock should permit: a receipt dated in the open
   month against a closed-month invoice, and a payslip disbursement for a
   closed month. Both must succeed — these are 0237's two carve-outs and they
   are the ones a too-strict lock would break.
4. Reopen the month and confirm writes resume.
5. Report what breaks.

### Why step 3 matters as much as step 2

The failure that motivated 0237 was in this direction. Dev's lock was stricter
than production's, so a test asserting a refusal passed while production allowed
the thing. A lock that is too tight looks correct in every test that only checks
refusals, and shows up as an unexplainable outage at month end.

---

## 2. Dev's migration ledger records no SQL

**Status: script written, not run — needs a credential.**

All 257 dev rows have `statements` NULL and short hand-written versions. The
ledger asserts that migrations ran with no evidence that they did, and 0238
documents two effects of `0109b` that dev claims to have applied and did not
have.

Run `npm run backfill:migration-sql -- --env dev --apply`. It needs
`SUPABASE_DEV_URL` / `SUPABASE_DEV_SERVICE_ROLE_KEY`, and the helper function at
the foot of `scripts/backfill-migration-sql.mjs` created for the run and dropped
after.

Note what it buys: digests match by construction on day one, so it proves
nothing about the past. It makes drift detectable **from that point on**.

---

## 3. Migrations on production that exist nowhere else

**Status: identified, not recovered.**

27 migrations are recorded on production with no repo file. All 27 carry their
SQL, so recovery is mechanical. Three of them govern whether money can move in a
closed period and are the direct cause of item 1's divergence:

```
allow_disbursement_and_invoice_payment_in_closed_period   20260629153920
allow_invoice_receivable_update_in_closed_period          20260630133438
narrow_invoice_receivable_period_lock_exemption           20260630133606
```

0237 supersedes all three, but it is **not yet applied to production** — prod is
closed to changes without named approval. Until it is, prod and dev enforce
different period-close rules in the other direction now.

See `docs/PROD_DEV_DIVERGENCE.md` §2.2.

---

## 4. 0235 has never run on production

**Status: safe to apply, not applied.**

Production's `invoke_send_compliance_alerts()` still hardcodes the production
project URL. 0235 moves it to a vault secret with that same URL as the fallback,
so applying it changes nothing on prod. The reason to apply it is that any
non-production database rebuilt from these migrations currently fires its
nightly job at **production's** edge function. Dev already has it.

---

## 5. No control-account reconciliation for bank or custodian cash

**Status: gap identified in the fixture audit, not built.**

There is no check tying the `bank` control account to
`sum(bank_accounts.balance)` and the `bank_transactions` deltas, nor the
custodian control to the cash-location balances. The fixture audit found a
sandbox ledger claiming 150,000 of bank money the operational tables had no
record of, and `ledger_checks()` stayed green because the AR side reconciles and
the bank side has nothing to reconcile against.

---

## 6. Test fixtures create state the application cannot produce

**Status: audited, not remediated.**

5 of 7 fixture writes in the suite build rows no application path can create —
Bank-mode advances with no bank account and no cash movement, payslips marked
disbursed with `amount_paid = 0`, invoices with a NULL `contract_id` that sit
outside `uq_invoice_contract_month` entirely. Assertions against unreachable
state prove nothing. See `docs/LEDGER_PHASE1_FIXTURE_AUDIT.md`.

---

## 7. `deployments_overlap_backup_0183` is a live log wearing a backup's name

**A design decision, not a retention one. It is logged separately because
inside a retention entry it would be read as "wait for the date" and forgotten.**

The name says one-off snapshot. The behaviour says otherwise: `change_client`,
`change_guard_shift` and `record_separation` — all SECURITY DEFINER — still
INSERT into it, and its 43 rows span **2026-07-24 to 2026-08-25**, more than a
month after migration 0183 created it. It is an operational overlap log that
has been accumulating unnoticed.

That mismatch is why it was still anon-readable and truncatable until 0240.
Nobody secured it because everybody read the name and filed it as dead data.

**The question to answer:** model it as what it is — a real name, a real RLS
policy, a defined lifecycle — or stop the three functions writing to it so the
snapshot can age out and be dropped.

Until that is decided it carries a **review** date (2027-02-28), not a drop
date. A drop date on a table that is still filling is a date that gets silently
missed.

---

## 8. FORCE ROW LEVEL SECURITY — pre-check complete, NOT a blocker

**Result: enabling it breaks nothing, and protects nothing. Do not schedule it
as a security measure. This item can close.**

The earlier entry said zero tables have `FORCE ROW LEVEL SECURITY`, and that
this "is why every owner-role session silently ignores every policy". The first
half is true. The second half names the wrong cause.

Measured on dev:

| role | `rolbypassrls` | owns tables? |
|---|---|---|
| `postgres` | **true** | all 136 tables, all 259 SECURITY DEFINER functions |
| `service_role` | **true** | — |
| `authenticated` | false | — |
| `anon` | false | — |

`FORCE ROW LEVEL SECURITY` makes a table's **owner** subject to its policies. A
role holding **`BYPASSRLS` bypasses RLS regardless of FORCE** — the two are not
the same switch, and BYPASSRLS wins. Every table and every SECURITY DEFINER
function in this schema is owned by `postgres`, which holds BYPASSRLS. So:

* `postgres` — migrations, and every definer function's body — bypasses via
  BYPASSRLS, not via owner-bypass. FORCE does not touch it.
* `service_role` — Edge Functions, cron — same.
* `authenticated` and `anon` are not owners, so RLS already applies to them and
  FORCE is irrelevant.

**Demonstrated, not inferred.** With `FORCE ROW LEVEL SECURITY` enabled on
`deployments_overlap_backup_0183` — a table with RLS on and **zero policies**,
which should deny everything to a non-bypassing owner — `postgres` still read
all 44 rows and still inserted successfully.

A caution about how this was found, because the first attempt was wrong in the
usual way: the initial pre-check also tested `current_company_id()` and
`effective_salary` under FORCE **as `authenticated`**, and both passed. Those
two results proved nothing at all — `authenticated` is not the owner, so FORCE
is a no-op for it by definition. A green result from a test of the wrong
subject. The backup-table case was the only one of the three that touched an
owner path, and it is the one that settled the question.

### What this means

The real reason owner-role sessions ignore policies is **`BYPASSRLS` on
`postgres`**, and that is not removable in any sane way: `postgres` is the role
Supabase's own tooling and every migration runs as, and stripping it would put
all 259 definer functions under RLS at once.

So there was never an RLS-level fix available for the SECURITY DEFINER problem.
**Explicit guards inside the functions — 0242 — were the only option, not the
cheap option.** That is worth recording, because "just turn on FORCE RLS" is the
obvious-sounding suggestion and it would have produced a migration that changed
nothing while looking like a fix.

Enabling FORCE anyway is free and harmless, as belt-and-braces against some
future table owner that lacks BYPASSRLS. If it is ever done, the migration must
say plainly that it has no effect today, or the next reader will assume the
schema is protected by it.

---

## 9. Dev migration-SQL backfill — analysed, blocked on one credential

**Not done. The blocker is a credential, not engineering, and the analysis
below is complete so the run itself is one command.**

`scripts/backfill-migration-sql.mjs` is written and wired to
`npm run backfill:migration-sql`. It cannot run because it needs
`SUPABASE_DEV_URL` / `SUPABASE_DEV_SERVICE_ROLE_KEY`:
`supabase_migrations.schema_migrations` is outside the exposed schema, so an
anon key cannot reach it, and `.env.development.local` carries only an anon key.
There is no `psql` on this machine.

Transcribing 2.3 MB of migration SQL through the agent to work around a missing
key was ruled out, and that decision stands.

### What the run will do, computed against dev's live ledger

| | |
|---|---:|
| ledger rows | **268** |
| rows that already carry SQL | 11 |
| rows resolving to a repo file — **will be backfilled** | **259** |
| rows with no repo file — **correctly left NULL** | **8** |
| repo files with no ledger row | 1 (`RUN_0065_0070_combined`, a helper, not a migration) |

The 8 left NULL are one-off data operations that were never migrations, and
inventing SQL for them would be worse than leaving them empty:
`0125_phase5_bank_of_ajk_setup`, `0162_nova_islamabad_split_guards_by_location`,
`0163_miu_split_guards_by_location`, `0185_sgc_backdate_postings_to_join_date`,
`0186_clone_org_guards_n_guides`, `0187_prune_inactive_separated_from_new_org`,
`0188_correct_overrecorded_advances`,
`0196_revert_accidental_separation_hmc071`.

### Two pieces of drift fixed while measuring this

Both were mine, from this session, and both are exactly the failure the checker
exists to catch — *recorded rows describing something the repo does not*.

1. **Five rows recorded without their number prefixes.** `apply_migration` was
   called with `tenant_guard`, `tenant_guard_gaps` and so on rather than
   `0242_tenant_guard`. Renamed in place to match their filenames. Without this
   the checker would have reported five phantom missing migrations and five
   phantom unknown rows.
2. **One row with no repo file at all**:
   `0078b_guard_legacy_company_isolation`. Its SQL was real and applied, but it
   lived only in the tail of `0078b_missing_base_tables.sql`, so nothing in the
   repo described the row. Given its own file,
   `0078c_guard_legacy_company_isolation.sql`, written to match the recorded
   bytes exactly — verified: `md5 = 23561836ba41162688439073d7a98625`, equal to
   the recorded digest. Row renamed to match.

### To finish it

Put the dev service-role key in the environment and run:

```
SUPABASE_DEV_URL=... SUPABASE_DEV_SERVICE_ROLE_KEY=... npm run backfill:migration-sql
```

Dry run first — it writes nothing without `--apply`. `set_migration_statements`
must be created for the run and dropped after; the exact SQL is at the foot of
the script, and it is deliberately not a migration.

---

## 10. BLOCKER — a posted financial document cannot be edited. At all.

**Live today. Open month. Zero periods closed. All 11 source tables.**

Creating an invoice posts its journal entry and works. **Editing that invoice,
in the same open month, is refused:**

```
closed periods for this company           : 0
CTRL entries posted on invoice INSERT     : 1
TEST edit that invoice in the OPEN month  : REFUSED ("Posted journal rows are immutable")
```

Every edit routes through `reverse_journal_for_source`, which ends with
`update journal_entries set status = 'reversed'` on the original.
`enforce_journal_immutable` refuses every UPDATE outside a maintenance session,
in any period. So a posted entry cannot be marked reversed, therefore cannot be
reversed, therefore the document cannot be edited.

Affects `advances`, `cash_deposits`, `cheques`, `custody_transfers`, `expenses`,
`fixed_assets`, `interregion_transactions`, `invoice_payments`, `invoices`,
`partner_account_entries`, `payslips`.

**Magnitude: zero rupees, and a support incident on roughly day two.** This is
not a lock behaving strictly — it is the system being unable to correct a typo
in an invoice amount. It is invisible only because both live orgs have no
financial data; the only ledger anywhere is SANDBOX TESTING ORG.

**Fixed by C** (derive `reversed` from `reversal_of_entry_id` instead of writing
it back onto the original), which removes the UPDATE that fails. See
`docs/LEDGER_REVERSAL_STATUS_AUDIT.md` — the audit found the change is two call
sites, and that one of them is separately wrong by 2,582,280.

**Confirm on landing:** editing a posted invoice, payslip and expense must all
work end to end.
