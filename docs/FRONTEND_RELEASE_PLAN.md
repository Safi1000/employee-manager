# The frontend release

Written 2026-09-01 against `crm-design` (`mmkfpnshxjcyijhuydgr`) for production
state, `crm-design-dev` (`wlyhbvunvdsropqzlpwx`) for the binding test, and the
repo working tree. **Nothing in this plan has been applied to production.**
Every figure below names the database it was measured on, per
`TENANT_GUARD_REPORT.md` §9.16.

This is the one window in the ledger deployment where the deployed build and
the new schema cannot both be right. Blocks 1–3 and the `0276`–`0279` split
were ordinary afternoons; this is not. It is the step where a regional office
could hit a broken build.

---

## 0. Scope: what this deployment is now for

Shayan has ruled that **production's financial data is disposable**. Bank
accounts, receivables, invoices, payments, journal entries and opening balances
are all re-entered when GGS's financials go live.

**Not disposable, and untouched by this release:** employees, clients,
contracts, attendance records, guard documents and clearances.

Three consequences that change how this plan reads:

1. **The SANDBOX financial work was proof that the rules work, not data
   repair.** `0265`'s seven reposts, `0269`, `0274`, `0276`'s forty-six and the
   opening batch corrected rows that will be deleted. The rows are disposable;
   the proofs are not. `0265` proved a state-keyed correction against live
   traffic, `0269` confirmed G3's diagnosis on production, and `0276` plus the
   batch decomposed a 6.4M discrepancy into named components — which is how
   United Bank Ltd's cancelling pair was found (§9.15). None of that was
   available from an empty database, which is also why the branch rehearsal
   would not have produced it.

2. **The four remaining reds are fixture artefacts, not blockers.** The two
   negative custodians (HAMNA −3,477.00, Safi −1,999.87), the United Bank
   800,000, the 54,679 and the 33,788 all sit on data that is being replaced.
   They do not gate go-live. **Safi's custodian opening figures are not needed
   and should not be chased** — they would be openings for a fixture company.

3. **Nothing here relaxes the correctness of the rules.** A repost that proves
   a posting rule works still has to be right. The value is the proof.

### Rules versus fixture repair, across everything remaining

Every unapplied migration — `0280` through `0312` — **installs rules. Not one
exists to correct fixture financial data.** So there is no work-for-its-own-sake
ahead to cancel.

Thirteen of them contain DML against real tables (`0291`–`0293`, `0295`–`0298`,
`0300`, `0301`, `0303`, `0304`, `0308`, `0310`). **All thirteen wrap it in the
deliberate-exception idiom** — `raise exception 'TESTS_OK'` inside a
subtransaction, caught outside — so every write is rolled back. They are
proofs, not data.

`0282` was the one to check, because it is the only remaining file mentioning
`post_journal`. It is not data work: that call sits **inside the
`run_profit_allocation` function body it defines**, and its own verification
uses `ROLLBACK_PROOF`. It posts nothing.

> **Carried forward to Block 6, not to this release.** `0291`, `0292`, `0293`,
> `0297` and `0298` run their probes against `employees`, `clients` and
> `contracts` — three of the four protected categories — and `0291` and `0292`
> *update existing rows* rather than rows they created. They roll back. But
> "protected" now means something specific, and a rolled-back write to
> `employees` is a claim worth verifying rather than trusting. **Before Block 6:
> snapshot the affected rows on dev, run the migration, compare.** Approved
> 2026-09-01.

---

## 1. The finding that shrinks the release

**`0280` and `0311` do not belong in it.**

`LEDGER_DEPLOYMENT_PLAN.md` §4 identifies the risky window as `0280` → `0306`
and suggests moving both drops to the end, adding: *"safe here only because
neither drop is read by any later migration, which is checkable and should be
checked."*

**Checked, 2026-09-01, against the repo:**

```
migrations 0281–0312 referencing cash_opening_balance / cash_opening_locked ... NONE
migrations 0281–0312 referencing auto_zero_monthly / last_zeroed_month ....... 0308 only
                                                              (already applied to prod)
```

Moving them removes the window §4 rightly called worse than an error — the
Accounting page rendering a **confident zero** for the treasury opening
balance. This is the plan shrinking for a verified reason rather than an
optimistic one.

**And the repo build is already the new build.** It no longer names the dropped
columns (`supabase.ts:1845`, `Accounting.tsx:663` carry the removal comments)
and it already passes the custodian:

```ts
// src/app/pages/super-admin/Invoices.tsx:762
supabase.rpc("record_invoice_payment", { …, p_withholding, p_custodian_location_id })
```

A build that never names a column works whether or not the column exists. **The
new build is therefore compatible with the schema both before and after
`0280`/`0311`**, which is what lets them move to the end of the deployment,
after `0306`.

---

## 2. The binding test — measured on dev, not assumed

The previous draft of this plan rested on one unverified assumption: that
PostgREST binds a call supplying 6 or 7 named arguments to the 8-argument
function via its defaults. If it did not, the window would be **every receipt
in both modes**, and this would be a maintenance window rather than a rolling
deploy. Everything else was contingent on the answer.

**Measured on `crm-design-dev` (`wlyhbvunvdsropqzlpwx`), 2026-09-01.** Dev
already carries the post-`0281` state — the 8-argument function exists and the
7-argument one is gone — so no migration was applied to run this. A test user
was created in SANDBOX TESTING ORG with role `accounting` (a scoped role, not
SSA, so `assert_same_company` was genuinely enforced), signed in over
`/auth/v1/token`, and used to call the RPC over the real PostgREST endpoint.
**The user was deleted in the same session**, per the V1 rule; the profile
cascaded. Verified afterwards: `profiles` 0 rows, `auth.users` 0 rows.

| # | call | result |
|---|---|---|
| **A** | 6 named args, `Cash` | **HTTP 400** `23514` — *"Select the custodian who received the cash"* |
| **B** | 7 named args (`p_withholding`), `Cash` | **HTTP 400** `23514` — same message |
| **C** | 7 named args, `Bank` | **HTTP 200** `{"total_applied":1.00,"invoices_touched":1,"withholding_applied":0.00}` |
| **D** | control: 7 valid names + one bogus name | **HTTP 404** `PGRST202` — *"Could not find the function … in the schema cache"* |

**The assumption holds.** A and B reached `0281`'s own custodian guard, which
lives inside the function body — so binding succeeded. C proves the old build's
bank path still works end to end after `0281`.

**D is the part that makes the test non-vacuous.** Per §9.6, a green is worth
nothing until you have shown what red looks like. `PGRST202` is exactly the
failure this test was looking for, the instrument produced it on demand, and
A/B did not produce it. Without D, A and B would have been two passes that
could not distinguish "binds correctly" from "the test never exercised
resolution at all".

**The shape of the release is therefore unchanged: a rolling deploy, with cash
receipts as the only casualty.**

*Dev side effect, recorded rather than hidden:* case C posted a real ₨1.00 bank
receipt to SANDBOX invoice `851ce591…` on dev. It is balanced and legitimate;
posted lines are immutable, so it was left in place rather than reversed. Dev's
bank figures are 1.00 higher than before this test. Anyone diffing dev against
production should subtract it.

---

## 3. The dependency that is real, and the only one

The new build **requires `0281`** and cannot ship before it. `0281` line 52
drops the 7-argument signature:

```sql
drop function if exists public.record_invoice_payment(uuid, numeric, date, text, uuid, text, numeric);
create or replace function public.record_invoice_payment(
  …, p_withholding numeric default null, p_custodian_location_id uuid default null)
```

| combination | Invoices → Record Payment |
|---|---|
| old build + no `0281` | works (today) |
| **new build + no `0281`** | **every receipt fails** — sends an argument no function accepts (`PGRST202`, shape D above) |
| **old build + `0281`** | **Cash refused**, Bank works (measured, A/B/C above) |
| new build + `0281` | works |

What each dependency actually turns on:

| dependency | turns on | provided by |
|---|---|---|
| custodian picker → RPC | `record_invoice_payment.p_custodian_location_id` — a **parameter**, not a column | `0281` |
| the picker's dropdown | `cash_locations` rows | already present (13 on SANDBOX) |
| receipt row storage | `invoice_payments.custodian_location_id` | already present, pre-`0263` |
| `0268`'s constraint | the picker actually passing a value | **the build** |
| treasury opening display | **nothing** — derived from the `bank_transactions` opening row | build-internal |

**Only `0281` is a hard ordering constraint.** Everything else is already in the
schema or is build-internal. The build can ship immediately after `0281` and
needs nothing from `0268`, `0282`, `0283` or `0284`.

---

## 4. The order

```
  1.  0281   record_invoice_payment: custodian + WHT      ← cash receipts break here
  2.  BUILD  deploy the frontend                          ← cash receipts restored
  3.  0268   cash movement must name a location
  4.  0282   profit allocation run and posting
  5.  0283   recorded migration SQL
  6.  0284   payroll_attendance_drift
  ── moved out of this release, to after 0306 ──
      0280   drop treasury cash opening columns
      0311   drop auto-zero columns
```

`0282`–`0284` are inert with respect to the build. They could equally go before
`0281`; they must not go **between** `0281` and the build.

`0268` goes after the build, never before — see §6.

---

## 5. What breaks, which screen, for how long

**One screen: the Invoices page, "Record Payment" modal. One operation: a
receipt in Cash mode.** Bank receipts, expenses, payroll, attendance, contracts
and every other screen are untouched.

The refusal is legible, names the fix, and — per the `modal-inline-errors` work
— surfaces **inside** the overlay rather than behind it:

```
Select the custodian who received the cash
HINT: A cash receipt must name a cash location so the ledger can attribute it.
```

**Duration: minutes.** `0281` and the build deploy are two adjacent actions with
nothing between them. Do not put a review, a gate or a report between them.

**Production keeps transacting underneath this release.** It has done so twice
today: a live expense landed mid-deployment and became `0265`'s seventh
correctable entry. Assume a receipt can be attempted during the window.

---

## 6. Pre-flights, and which sit on live write paths

Two must run **immediately before** their migration, not earlier in the session.

| migration | pre-flight | live write path? | measured 2026-09-01 (prod) |
|---|---|---|---|
| `0281` | an invoice with outstanding > 1 exists for its probe | **YES — receipts** | run at the time |
| `0268` | **not a data query** — see below | **YES — receipts** | data 0/0/0/0 ✓; writer only after the build |
| `0282` | canary row count | no | 17 now → 18 ✓ |
| `0283` | none | no | — |
| `0284` | drift = 0; a payslip in an open month **whose run is not approved**; canary | **YES — updates a live payslip** | see §9 |

### `0268`'s pre-flight is about the writer, not the data

Its data has always been clean — 0 violating rows on `expenses`,
`invoice_payments`, `advances` and `payslips`. A data-only pre-flight would
have passed it, and it would have broken **every cash receipt on production**,
because the deployed `record_invoice_payment` inserted no custodian. That is
`LEDGER_DEPLOYMENT_PLAN.md` §11a:

> **A PRE-FLIGHT MUST CHECK WHETHER THE DEPLOYED CODE CAN SATISFY THE NEW
> CONSTRAINT, NOT ONLY WHETHER THE EXISTING DATA DOES.**

So `0268`'s pre-flight is: **after the build is live, create a cash receipt
through the UI and confirm the stored row carries a `custodian_location_id`.**
Only then apply `0268`. It is the last migration in the release for this
reason, and it is also the one with a complete one-line undo.

---

## 7. Verified after — through the application, logged in

Not through a service-role connection. Every item below is a click.

> **The confirmation tested the other implementation.** Item 1 of the verification
> below was run and passed — a ₨50,000 cash receipt, recorded, custodian balance
> moved — and the window was declared closed on it. It went through
> `Accounting.tsx`'s **direct insert into `invoice_payments`**, not through
> `record_invoice_payment`. All eight payment rows on production carry
> `client_id` and most carry no invoice, which is that path's shape and not the
> RPC's; the RPC has never created a production payment row.
>
> The window was real and the release closed it. What the click proved is that
> the screen stores a custodian, which was already true before `0281`. Item 2
> (0315) removed that second implementation, so the same click now exercises the
> RPC — but the sequence is worth keeping: **a green verification step is only
> evidence about the code path it actually took**, and on a screen with two
> implementations of the same operation, that is not the one being released.

1. **Cash receipt with a custodian** → succeeds; the row carries
   `custodian_location_id`. This is `0268`'s precondition, so it happens before
   `0268` and again after.
2. **Bank receipt** → succeeds, unchanged.
3. **Cash receipt, no custodian selected** → refused with `0281`'s message,
   surfaced in the modal rather than behind it.
4. **Expense with no client** → succeeds. Shayan-confirmed form; this is the
   path `0242` broke on dev.
5. **Manual journal with a NULL branch** → succeeds. **Carried since the tenant
   guard deployment and still never exercised by a logged-in user.** `0248`
   made `assert_same_company` NULL-tolerant and `post_manual_journal` carries
   `0242b`'s conditional branch guard; both were proved in SQL only. A `P0001`
   in a toast is a failure even if every SQL check passed. **This is the oldest
   unverified item in the whole deployment — do not let it slip again.**
6. **Withholding** — leaving the field blank applies the client's
   `withholding_tax_rate`; the build passes an explicit value from a prefilled
   editable field. Confirm the figure shown is the figure posted.
7. `ledger_checks()` → **19 rows**, canary green, and the four accepted reds at
   their recorded numbers. Read the **differences**, not the absolutes:
   production transacts underneath, so both sides of a check move together and
   the difference is the finding.

---

## 8. Rollback — and there is no lever

The guard deployment had a real one: `supabase/rollback/EMERGENCY_LEVER.sql`
reverts `assert_same_company` and 135 guards go inert in a single statement.

**This release has no equivalent, because the build and the schema move
together and a build cannot be reverted by SQL.**

| failure | position |
|---|---|
| Build broken, schema fine | Redeploy the previous build **and** restore the 7-argument overload. Either alone leaves cash receipts broken. |
| `0281` wrong, build fine | Restore `record_invoice_payment` from the D0 capture **and** redeploy the old build — the new one sends an argument the restored function rejects. |
| `0268` refuses legitimate traffic | `alter table … drop constraint` — one line, complete. **This is why `0268` goes last.** |
| `0282` / `0284` | Nothing to unpost. `0282` posts only inside `ROLLBACK_PROOF`; `0284`'s probe update is inside `TESTS_OK`. Confirmed by reading both files, not assumed. |

**The half-lever exists and is written:**
`supabase/rollback/RESTORE_RECORD_INVOICE_PAYMENT_7ARG.sql`, extracted verbatim
from the D0 capture at line 7622 and **verified byte-identical to it by diff**,
the same discipline `EMERGENCY_LEVER.sql` was held to. Written before the
release, because composing a rollback during an incident is how the wrong thing
gets typed.

It is called a half-lever in its own header for a reason: **running it alone
does not restore service.** If the new build is live it sends
`p_custodian_location_id`, which the restored function rejects, and every
receipt fails in both modes — worse than the state it undoes. The order is
**redeploy the old build first, then run the file.**

One claim in that file is marked UNVERIFIED and should stay marked: that the
two overloads coexist without PostgREST answering `PGRST203` (ambiguous) for a
7-named-argument call. The expectation is that an exact name match beats a
defaulted one. It was not measured. The file carries the fallback.

The D0 capture itself: `supabase/rollback/prod_secdef_functions_20260901.sql`,
257 functions, md5 `28cbd4912d69b3cf96f5378bea585dd1`. **There is no other
rollback artefact.**

---

## 9. The dev-measured assertion audit — `0280`–`0284` (priority 2)

All 34 files in `0280`–`0312` were scanned for numeric literals inside
executable assertions. Four in this release's scope are data-dependent, and
**all four were measured against production, 2026-09-01:**

| migration | assertion | production |
|---|---|---|
| `0284` | `v_before <> 0` — drift zero before the probe | **0 ✓** |
| `0284` | a payslip in an open month with `per_day_salary > 0` | **48 candidates ✓** |
| `0284` | `v_rows <> 19` (18 checks + canary) | 17 now, +1 at `0282`, +1 at `0284` = **19 ✓** |
| `0282` | `v_n <> 18` (17 checks + canary) | 17 now, +1 at `0282` = **18 ✓** |

`0280`, `0281` and `0283` carry no data-dependent count.

### The risk a count-audit would have missed

`0284`'s probe does `update public.payslips set present_days = present_days + 3`.
Since `0277`, `present_days` is inside `enforce_payroll_run_lock`. If the chosen
payslip belongs to an **approved run**, the update raises for a different
reason and `0284` aborts with *"the synthetic change failed for the wrong
reason"*.

**The assertion is fine and the fixture is unreachable.** That is a distinct
failure class from §9.14's — there the literal is wrong; here the literal is
right and the migration still dies. **The pre-flight must select on run status,
not merely on open month.**

### Beyond this release

Data- or catalogue-dependent, and needing the same treatment before their own
blocks: `0291` (`v_kinds <> 7`, `v_after <> 30`), `0294` (`v_fn <> 6`,
`v_vw <> 14`), `0303` (`v_bad <> 3`), `0307` (`v_cols <> 9`, `v_total <> 11`),
`0308` (`v_before <> 1250000`). The rest — `0287`, `0288`, `0299`, `0300`,
`0301`, `0302`, `0304`, `0310` — carry canary counts, which are deterministic
given order.

**Priority 1 of the 23 headers** — figures a reader would take as a property of
production — is a separate pass, after this release. `0271` and `0260` are the
known cases; see §9.16.

---

## 10. What this release does not include

`0285`–`0312` beyond `0284`. `0280` and `0311`, now moved to the end.
Blocks 5–7. The SANDBOX opening batch (posted 2026-09-01). The GGS financial
go-live, which is three ordered steps: enter the bank accounts and cash
locations → post the opening batch → the first close becomes possible.

**`0260`'s gate refusing GGS's first close is correct and stays.** "Production
cannot close a month" was the wrong framing: no company can close a month it
has no financial data for, which is the gate working.
