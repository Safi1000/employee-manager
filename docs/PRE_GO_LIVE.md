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
2. **`FORCE ROW LEVEL SECURITY` is still off on every table**, both
   environments. Not a live leak for app users, who are not table owners, but it
   is why every owner-role session — including every test and migration —
   silently ignores every policy. Pre-check first: report whether enabling it
   breaks any legitimate owner-role path.
3. **The two backup tables still exist and need retention dates.** Neither is
   droppable yet: three SECURITY DEFINER functions still write
   `deployments_overlap_backup_0183`, and `org_copy_map_0186` is the audit trail
   of the guards-n-guides org clone. Give both a dated comment the way 0111 got
   one. **Review date: 2027-02-28.** Dropping beats securing.
4. **Nine of the 59 `p_company_id` functions should not take that parameter at
   all** — see `docs/TENANT_GUARD_REPORT.md`. A signature change is its own
   migration and is not urgent now that the guard checks the claim.


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
