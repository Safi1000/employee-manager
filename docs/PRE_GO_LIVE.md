# Required before live finance

Blocking items. Each one is here because something is unverified, not because
it is known broken — which is the point: an unexercised mechanism in a system
about to carry real money is a defect until it has been run.

---

## 0. Tenant isolation has never been verified, and three holes are open now

**Status: plan written (`docs/TENANT_ISOLATION_PLAN.md`), nothing built. Ranked
above everything else.**

Multi-tenant isolation is enforced almost entirely by RLS policies. Every test
in this project runs as `postgres`, which carries `rolbypassrls`, so **no test
has ever verified isolation, and any test that appeared to would report PASS
with the policies deleted.**

One security company seeing another's guards, clients, payroll or rates is not
a defect to schedule. It is the end of the product.

Looking for a way to test it found three things that need no test:

1. **`verify_employee_identity`, `release_final_dues` and `disburse_payroll_run`
   are SECURITY DEFINER, executable by `authenticated`, and mutate by id with no
   tenant check.** A SECURITY DEFINER function has no caller RLS — that is what
   the mode means — so any authenticated user of any tenant can mark another
   company's employee identity-verified, release their final dues, or flip their
   payroll run to disbursed, given only a UUID. These three were **sampled from
   46 of the same shape**; the other 43 are unreviewed.

2. **`deployments_overlap_backup_0183` and `org_copy_map_0186` have RLS switched
   off entirely** and grant SELECT/INSERT/UPDATE/DELETE/**TRUNCATE** to `anon`.
   The first carries `company_id` — every tenant's deployment rows, readable and
   truncatable with the anon key that ships in the client bundle. Both prod and
   dev.

3. **Zero tables have `FORCE ROW LEVEL SECURITY`**, on either environment. Not a
   live leak for app users — they are not table owners — but it is why every
   owner-role session, including every test and migration, silently ignores
   every policy.

Item 2 of that plan is the cheapest and most urgent: enabling RLS on two tables.

## 1. Period Close has never been exercised. Anywhere.

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
