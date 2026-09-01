# The ledger deployment

Written 2026-09-01, against `crm-design-dev` (`wlyhbvunvdsropqzlpwx`) and
read-only probes of `crm-design` (`mmkfpnshxjcyijhuydgr`). **Nothing in this
document has been applied to production.** It is a plan, and every number in it
was measured rather than recalled.

It extends `docs/PRE_GO_LIVE.md`'s manifest section rather than replacing it;
where the two disagree, the disagreement is stated here and the older text
corrected.

---

## 0. The count is 72, not 54

54 was right when it was written. The stream has since grown, shed one file to production, and been renumbered around a collision. **Counted rather than
recalled, 2026-09-01: 82 files in the `0224b` / `0233`–`0311` span, 10 of them
already recorded on production, so 72 still to apply.**

Measured by diffing repo filenames against `supabase_migrations.schema_migrations`
on prod, resolving `scripts/migration-aliases.txt`, and restricting to the
numbered series from `0224b` onward. Below that point the repo and prod disagree
about *names* rather than about *content*, which is a separate problem
(PRE_GO_LIVE §"Older unrecorded files") and not part of this deployment.

**The stream is 72 files.** `0308` went to production on 2026-09-01; `0309` on
production belongs to another branch (§14); this plan's last two are `0310` and
`0311`.

A number that grows while the deployment waits is itself information. Each of
the eighteen was a defect found by a control that the earlier migrations had
just wired — the stream is still producing findings, which argues for deploying
it, not for waiting until it stops. The last two, `0308` and `0309`, came out of
writing this plan: investigating one of the four accepted reds found that its
cause was not fixture data at all.

---

## 1. The manifest, in numeric order, with gates at numeric boundaries

**Supersedes the four-stage grouping, 2026-09-01.** That grouping reordered
migrations carrying hard-coded expected check counts, and the canary refused it.
The diagnosis stands: *inert / refusing / writing / irreversible* describes risk
well and schedules application badly, because numeric order interleaves all
four.

So: **apply in numeric order. Never skip. The risk label rides along as an
annotation.**

### The constraint that fixes where a gate may fall

`ledger_checks()` carries a `checks_evaluated` canary stating how many checks
the suite is meant to contain. Eleven migrations in this stream set it, and each
is a contract with every check-adding migration before it:

| sets canary to | migration | also asserts row count |
|---|---|---|
| — (tautology) | `0239` | — |
| 13 | `0266` | — |
| 14 | `0269` | 15 |
| 15 | `0271` | 16 |
| 16 | `0275` | 17 |
| 17 | `0282` | 18 |
| 18 | `0284` | 19 |
| 19 | `0286` | — |
| 20 | `0288` | 21 |
| 21 | `0300` | 22 |
| 21, collapsed to one place | `0302` | 22 |
| 25 | `0304` | 26 |

Two windows are **not** self-consistent, and no gate may fall inside either:

* **`0239` → `0266`.** `0239`, `0259` and `0262` each add a check arm and none
  bumps the canary — because until `0266` the canary is a tautology,
  `expected = actual, difference 0, passed true`. It cannot fail, so it is not
  yet an assertion. `0266` is the migration that makes it one, and its own
  header says why: `0262` added a check *outside* `real_checks`. A gate here
  would pause on a suite carrying checks its own canary does not count.
* **`0300` → `0302`.** The canary is **red** through this window, on every
  company — see the correction below. A gate here pauses on a suite reporting
  its own failure.

Everywhere else each migration bumps the canary in the same file that adds the
check, so **every other migration boundary is a legal gate.** The ones chosen
below are chosen for what they let you observe.

### A correction: `0300` broke the canary, not `0301`

`0302`'s header, §9.6 and my last three reports all say `0301` bumped the canary
with a single-occurrence `regexp_replace` and left `- 20` and `= 20` behind.
**That is wrong. `0301` does not touch the canary at all** — it contains no
`checks_evaluated`, no `::numeric` literal, nothing.

`0300` did it, at its own line 208:

```sql
if v_new !~ '\m20::numeric,' then
  raise exception '0300 FAILED: the checks_evaluated canary is not 20 — do not adjust it blindly';
end if;
v_new := regexp_replace(v_new, '\m20::numeric,', '21::numeric,');
```

and `0300`'s verification — under a heading reading **"THE SUITE GREW BY EXACTLY
ONE, AND THE CANARY AGREES WITH IT"** — asserts the row count is 22 and that
`expected` and `actual` are both 21, and **never asserts `passed`.** The exact
omission, in the exact place, one migration earlier than recorded.

I attributed it to `0301` because `0301` was the migration in front of me when I
read the red row. That is this document's own subject applied to itself:
reasoning from what I was doing rather than reading which file contained the
code. Found by grepping all seventy for the audit in §11.

What changes: the defect **survived a migration boundary** — introduced by
`0300`, invisible through `0301`, caught only by reading `ledger_checks()`
output two migrations later. What does not change: `0301` scheduled the job that
would have broadcast it every morning, and `0302` is the right fix.

**`0302`'s header therefore states something false about `0301`.** Correcting it
means editing an applied migration and realigning the recorded SQL on dev, which
is a write; this turn applies nothing. Listed in §12.

### The order, and what each gate is for

**G0 — production today.** `ledger_checks()` returns **8 rows**, canary
tautological, four cron jobs, `bank_accounts` at 20 columns. `0308` applied.

---

**Block 1 — `0224b`, `0233`–`0238`.** Nothing here touches the check suite.
`0233` purges attendance after separation *(refuses)*, `0234` and `0237` add the
period-lock carve-outs *(refuses)*, `0238` is a no-op against production by
design.

> **GATE 1 — after `0238`.** Suite still 8 and untouched. **`0238` must have
> changed nothing** — verify it, because a no-op that turns out not to be one is
> the most surprising kind. No column dropped; deployed frontend unaffected.

---

**Block 2 — `0239`–`0266`.** The largest un-gateable run in the deployment, for
the reason above: `0239`, `0259` and `0262` add checks the canary does not yet
count, and `0266` is what makes it count them.

It also contains the sharpest behavioural change in the stream — **`0245`, after
which a line cannot be appended to a posted journal entry** — plus `0247`,
`0249` and `0250` *(reposts)*, `0263`–`0265` *(the custodian correction, fused)*
and `0267` *(the first column drop)*.

> **GATE 2 — after `0266`.** Suite **13**, and the canary is a real assertion
> for the first time in this system's history. Everything red here should be red
> for a reason you can name.
>
> **The period-close exercise (PRE_GO_LIVE §1) belongs immediately BEFORE this
> block, not after it** — `0237` and `0245` are inside it, and that exercise is
> how you find out whether their refusals reach a user as something actionable.
>
> **Its database half was run on dev 2026-09-01 and passes**: a month closes,
> all nine writes that should be refused are refused with legible `P0001`
> messages naming the month and the screen, four of five carve-outs work (the
> fifth was blocked by an unrelated cheque-linkage rule on a fixture with
> nothing attached), and reopening restores writes. **The application half is
> still untested** and is the gate.
>
> It also found that **the period lock was fail-open**: no tenant identity meant
> the trigger returned early, so service_role, `pg_cron`, `psql`, migrations and
> the Edge Functions could all write into a closed month. Demonstrated, rolled
> back — and **fixed by `0310`**, which refuses instead, allows only a
> maintenance session, and adds the check that observes it. §13.
>
> The cheque carve-out, which the first run left unproven, was **re-tested with
> a properly linked cheque and passes**. Five of five.
>
> Frontend: `0267` has dropped `cash_location_id` from `expenses`,
> `invoice_payments` and `advances`. Whether that breaks the deployed build is
> the open question of this plan — §4.

---

**Block 3 — `0267`–`0275`.** Cheque lifecycle keyed to state, bank-per-account
reconciliation, the second column drop (`0270`, `payslips.cash_location_id`).

> **GATE 3 — after `0275`.** Suite **16**. `no_negative_custodian_balance` goes
> live and is red at **2** on the sandbox — HAMNA −3,477.00, Safi −1,999.87, the
> figures accepted in §6b. Anything else red is new.

---

**Block 4 — `0276`–`0284`.** Bank postings to named accounts, payroll lock
symmetry, the profit-allocation run record, payroll drift. `0278` and `0280`
drop columns.

> **GATE 4 — after `0284`.** Suite **18**. `0274` has moved Ironclad Munitions —
> sandbox data that **exists on production** — so confirm it moved the number of
> lines it expected rather than assuming a no-op. `0282` and `0284` both plant
> fixture rows and reverse them; confirm nothing survived.

---

**Block 5 — `0286`–`0299`.** The detector suite proper: the tenant guard wired
into `ledger_checks`, `uninvoked_controls` and its view arm, the three duplicate
collapses, the compliance-view consolidation.

> **GATE 5 — after `0299`.** Suite **20**. `every_control_is_invoked` is red and
> its list is the point — it should name objects, and they should match
> `UNINVOKED_CONTROLS_VERDICTS.md` for whatever has landed.
>
> Frontend: `compliance_upcoming` has been rebuilt with fifteen arms and extra
> columns, and **the deployed build still works, because `0291` keeps all six
> original columns** (`company_id, branch_id, kind, ref_id, label, due_date`).

---

**Block 6 — `0300`–`0302`. ATOMIC.** The canary is red from `0300` until `0302`
fixes it. **No legal gate inside.**

> **GATE 6 — after `0302`.** Suite **21**, canary **green**. `0301` has scheduled
> `ledger-checks-daily` at 05:00, an hour ahead of the existing 06:00 digest —
> five cron jobs on prod.
>
> `alert_delivery_is_healthy` is red until the first run, and **this is the gate
> to actually wait at**. It is the only check that tells you whether anything
> would tell you. Still red on day two means the job is not running.

---

**Block 7 — `0303`–`0307`.** `profit_allocation_review` made callable and wired,
the two reconciliations and the forecast wired, the tenant-guard detector taught
one indirection, `vetting_dashboard` given its progress counters and a reader.

> **GATE 7 — after `0307`.** Suite **25**, 26 rows, canary green on every
> company. `uninvoked_controls()` reports **11**. `tenant_guard_gaps()` is
> **0** — `0305` is what keeps it there, which is why `0303` and `0305` are
> fused.
>
> **The new frontend build requires everything up to here, and can run without
> anything after it.** See §4.

---

**Block 8 — `0310`.** The period lock stops failing open, and gains the check
that observes it. See §13.

> **GATE 8 — after `0310`.** Suite **26**, 27 rows, canary green.
> `no_posting_into_a_closed_period` is green on every company and will stay
> green until a month is actually closed — `accounting_periods` is empty on
> both databases today.

---

**Block 9 — `0280`, then `0311`. THE TWO DROPS, MOVED HERE.**

The one deliberate exception to numeric order in this plan, and the reason it is
safe is checkable rather than argued:

> **Verified 2026-09-01: no migration between them and `0306` references
> `treasury.cash_opening_balance`, `cash_opening_locked` or
> `bank_accounts.auto_zero_monthly` in any form** — body, verification block or
> assertion. Grepped across `0281`–`0307`: **zero hits.** In the whole
> repository only five files mention any of them: `0011` and `0058`, which
> created them; `0280` and `0309`, which drop them; and `0308`, which asserts
> the flag is inert and is already on production.
>
> (The column is `cash_opening_locked`, not `cash_opening_balance_locked`. Both
> spellings were searched.)
>
> `0280` asserts nothing about the check suite — no counts, no `ledger_checks`
> call — so moving it changes nothing it depends on. `0311` asserts only that
> the canary is green, which holds at 25 and at 26.

**With this move the risky window disappears.** `0280` is the first migration
that breaks the deployed build (§4); putting it after the frontend has shipped
means no point in the deployment has a build that cannot run.

> **GATE 9 — done.** `treasury` and `bank_accounts` at their final shapes, every
> row byte-identical across both drops, canary green, suite 26.

## 2. What must be fused, re-derived

Numeric order dissolves most of the earlier fusion list, because the only thing
that could have separated those pairs was the stage lettering. Three remain, and
they are fused against **pausing**, not against reordering:

| fuse | why no gate may fall inside |
|---|---|
| `0263` + `0264` + `0265` | `0263` recovers the custodian location onto `payslips`, `0264` repoints the readers at it, `0265` reposts the six lines the old readers got wrong. Pausing after `0263` leaves a populated column nothing reads; after `0264`, readers pointing at rows that have not been corrected. |
| `0300` + `0301` + `0302` | the canary is red throughout. |
| `0303` + `0305` | `0303` guards three SECURITY DEFINER functions through a helper the detector cannot see; `0305` teaches it. Between them `tenant_guard_covers_every_parameter` is red at 3 for something that is not a real gap. |

`0265` needs a **pre-flight count that can only be taken between `0263` and
`0265`**, not before the deployment. Its selection reads `custodian_location_id`
on `expenses`, `invoice_payments` and `payslips` — the column `0263` populates —
so before `0263` the query returns zero on any database. It then refuses:

```
Expected exactly 6 misposted entries to correct, processed % —
stop and re-read the G2 categories before forcing this.
```

**That refusal is correct behaviour, not a defect**: a repair migration
declining to run against a population it was not written for. If production
yields a different number, re-read the G2 categories; do not change the six.

## 3. Replay safety, and the verification-writes question

### Not replay-safe

Recorded in PRE_GO_LIVE §"The migration set cannot be replayed" and unchanged:

* **`0242`** re-runs a code generator over the live catalogue and would rewrite
  functions written after it.
* **`0250`, `0258`** repost.
* **`0247`** backfills under a maintenance session.

To which this deployment adds:

* **`0265`, `0274`, `0281`, `0287`** — one-shot data work. Re-running `0265`
  reverses and reposts an already-corrected set.
* **`0303`** guards its own replay (it checks each function's pre-0303 signature
  and skips), and **`0304`, `0306`, `0307`** each begin with an "already done?"
  test. `0302` likewise. Those four are replay-safe as whole files, which is the
  CLAUDE.md standard, and they are the only ones in the stream that meet it
  deliberately.

None of this blocks the deployment — it runs each migration exactly once — but
it does mean **the deployment cannot be re-run from the top if it fails
half-way.** §7 is about what happens instead.

### Verification blocks that write rows that persist: none

PRE_GO_LIVE §"cannot be replayed" states that **`0245`'s verification inserts an
`accounting_periods` row and posts a test journal entry, and its own raise is
caught rather than propagated, so both persist.** That is wrong, and it is
corrected here rather than left standing.

`0245`'s verification is the standard shape: an inner `begin … exception`
subtransaction whose last statement is `raise exception 'TESTS_OK'`. The raise
propagates to the handler, the handler is outside the subtransaction, and every
write the block made is rolled back with it. The file says so in a comment
written for exactly this question.

Checked rather than reasoned. On dev, after the whole stream has run:

| probe | rows |
|---|---|
| journal entries described `%0245%` or `%self-test%` | **0** |
| `accounting_periods` rows, any company | **0** |
| clients named `ZZ 0…PROBE…` (`0303`, `0304`) | **0** |
| expenses described `0303 probe` / `0304 probe` | **0** |
| invoices numbered `ZZ-0…PROBE…` | **0** |
| functions named `zz_0…` (`0305`) | **0** |

And structurally: **there are no sequences in the `public` schema.** Every
generated code — client, employee, invoice — comes from `next_counter()`, which
is an `UPDATE` on a table and rolls back with everything else. A probe insert
therefore does not even consume a number. That is the usual leak from this
pattern and it does not exist here.

The four journal entries on dev matching `probe|test` are sandbox fixture rows
created 2026-08-28, each with its reversal. They are application data, not
migration residue.

---

## 4. The frontend, re-derived

The old §4 pinned the frontend to stage letters that no longer exist. Re-derived
from the columns themselves, by taking every column and table this stream drops
and grepping `src/` and `supabase/functions/` for each.

### Everything this stream removes, and who reads it

| migration | drops | read anywhere in the repo? |
|---|---|---|
| `0267` | `cash_location_id` on `expenses`, `invoice_payments`, `advances` | **no** |
| `0270` | `payslips.cash_location_id` | **no** |
| `0278` | `employees.cash_payment_approved_by`, `employees.final_pay` | **no** |
| `0280` | `treasury.cash_opening_balance`, `treasury.cash_opening_locked` | **no** — comments only, in `supabase.ts` and `Accounting.tsx`, both saying `0280` removed them |
| `0311` | `bank_accounts.auto_zero_monthly`, `last_zeroed_month` | **no** — comments only, as of this session |

`cash_location_id` looks like a hit at first — four files reference it — but on
four *different* tables: `partner_account_entries` (`custodian.ts`,
`PartnerDetailModal.tsx`), `investor_ledger_entries` (`ProjectFinancing.tsx`),
and the `cash_location_balances` view (`Treasury.tsx`). All four survive the
whole stream; confirmed against dev after every migration has run.

**So no migration in this deployment breaks the build in this repo.** That is a
stronger statement than the old §4 made and it was checked column by column
rather than inferred from stage membership.

### What the new build requires

| needs | from |
|---|---|
| `compliance_upcoming.notice_days`, `.days_remaining` | `0291` |
| `compliance_upcoming.sublabel` | `0292` |
| the `client_contract_end` arm | `0293` |
| `alerts.seen_count`, `alerts.last_seen_at` | `0295` |
| `vetting_dashboard.police_cleared` and six more | `0306` |
| `expenses.custodian_location_id` | `0263` — **already on production** |
| `notification_deliveries` | `0300` — *not required*: `recordDelivery()` is written never to throw, so on a database without the table the digest still sends and the failure is silent by design |

**The first migration the new build requires is `0291`. The last is `0306`.**

So, stated as the two facts asked for:

> **The first migration that breaks the build in this repo: none.**
>
> **The last migration the new build can run without: `0307`.** It needs
> everything through `0306`; `0307`, `0308`, `0310` and `0311` are all things it can be
> ahead of or behind.

That makes the frontend cutover **a free choice anywhere after GATE 7**, not a
coordinated release — which is the opposite of what the four-stage version
concluded, and it is the correct answer for *this* build.

### ANSWERED, 2026-09-01: the deployed commit reads two of the five

Everything above is about the build **in this repo**. The build serving
production is a different commit. It is not recorded anywhere in the
repository, but it is identifiable from it:

* `origin/HEAD -> origin/main`, so `main` is the production branch;
* `.vercel/project.json` in this checkout names **`txs-crm-dev`**, implying a
  sibling `txs-crm` project tracking `main`;
* `origin/main` is **`0ab2669`, 2026-08-31** — "Bring main onto the lowercase
  attendance vocabulary". `dev` is 57 commits ahead of it; `main` carries 3 that
  `dev` does not.

**This is an inference from repository convention, not a fact read off the
deployment.** Shayan confirms it in one glance at the Vercel dashboard. But the
inference is safe in one direction, which is the direction that matters:
**`origin/main` is the newest possible deployed commit, so any older one reads
at least as many of the dropped columns, never fewer.** What follows is a lower
bound on breakage.

Grepping the `origin/main` tree for the five:

| column | on `origin/main` | verdict |
|---|---|---|
| `cash_location_id` | present — but on `partner_account_entries`, `investor_ledger_entries` and the `cash_location_balances` view, **the same four safe tables as the current build** | `0267`, `0270` **safe** |
| `cash_payment_approved_by`, `final_pay` | absent | `0278` **safe** |
| `treasury.cash_opening_balance` / `cash_opening_locked` | **live code** — typed non-optional at `supabase.ts:1843-1844`, read at `Accounting.tsx:659-660`, **written at 854 and 866** | **`0280` BREAKS IT** |
| `bank_accounts.auto_zero_monthly` | **live code** — the checkbox at `Accounting.tsx:3473` and the insert at `798` | **`0311` BREAKS IT** |

### What breaks, precisely

Neither is a white screen, and the difference matters for scheduling:

* **`0280`** — the reads are `?? 0` and `?? false`, so after the drop the
  Accounting page still loads and **displays a treasury cash opening balance of
  zero**. That is worse than an error: a wrong number rendered confidently. The
  *write* — setting the opening balance — fails outright.
* **`0311`** — `auto_zero_monthly` is in the bank-account INSERT, so **creating
  a bank account fails** on the deployed build. Reads are unaffected.

### The answer to the two questions

> **First migration that breaks the deployed build: `0280`**, in Block 4. Not
> `0267`, which is what the pessimistic case assumed, and not "none", which is
> what the current repo alone would have suggested.
>
> **Last migration the new build can run without: `0307`.** It requires
> everything through `0306`.

So the risky window is **`0280` → `0306`** — Block 4 through Block 7 — not
Blocks 2–7 and not nothing. Blocks 1, 2 and 3 can be applied on ordinary
afternoons with the deployed build untouched. **The frontend must ship inside
the `0280`–`0306` window**, and between `0280` and the new build the treasury
opening balance reads zero.

**A cheaper option is available and worth considering:** `0280` and `0311` are
both column drops of things nothing needs any more. Moving both to the *end* —
after `0306` and after the frontend has shipped — removes the window entirely
and turns the whole deployment into ordinary afternoons. That reorders two
migrations, which this plan otherwise forbids; it is safe here only because
**neither drop is read by any later migration**, which is checkable and should
be checked before anyone does it.


## 5. `no_gate_mode_in_attendance_status` — 24 rows of real production data

Not fixture data. On production, right now:

```
Aamir Shabbir   GGS-00408   24 rows   2026-07-01 → 2026-07-24   join_date 2026-08-01
```

Exactly 24 rows, exactly one employee, on `GUARDS AND GUIDES (PVT) LTD`. Their
`attendance_records.status` is `'blocked'`.

**`'blocked'` is a gate mode, not an attendance outcome.** `attendance_gate()`
returns one of `allowed / allowed_unposted / override_required / blocked`, and
`blocked` means *this day must not be marked at all*. Something wrote the gate's
refusal into the column that records what happened. The dates are the tell: all
24 fall before his join date, which is exactly when the gate would have been
refusing.

### What happens to them at deployment: nothing, and that is correct

Three things were checked, not assumed:

1. **No money moves either way.** Payroll counts
   `('present', 'double_duty', 'relief_cover')` in `payroll_cost_by_client` and
   `payroll_cash_by_client`; `payroll_attendance_drift` counts `'present'`.
   `'blocked'` appears in none of them. The employee has **zero payslips**. The
   24 rows have never been paid and cannot be.
2. **The trigger already allows the cleanup and refuses a recurrence.**
   `reject_gate_mode_as_status` (`0228`, already on production) refuses an
   `INSERT` or `UPDATE` that *sets* status to `'blocked'`, and deliberately
   permits an update that moves a legacy row **away** from it. The comment in
   the function says so. So no migration in this stream needs to touch them, and
   nothing in this stream can create more.
3. **The `CHECK` constraint still permits `'blocked'`** on both databases. The
   trigger, not the constraint, is what closed the door. Tightening the
   constraint would fail on these 24 rows, which is presumably why it was not.

So: the check stays red on the live company after deployment, at 24, and it
should. It is a data-quality item with a known owner and a known fix — restate
the 24 rows as `absent`, or delete them as never having happened — and that is
an operational decision about one guard's July, not a deployment decision.

### Do not tidy this away

**The 24 rows are the only thing standing between "this check has never been
red" and "this check has never been tested against real data."**

Every other check in the suite is currently green on the live company. A suite
that is green everywhere tells you nothing about whether it can go red — that is
`9.6`'s whole subject, and `0301` shipped a canary that was permanently red
while both its own numbers agreed. These 24 rows are the one place where a check
in this suite is presently reporting a true fact about real production data.

So: **do not clear this red by widening the check, by adding an exemption for
this employee, or by deleting the rows to make the number go to zero.** If the
rows are restated — `absent`, or removed as never having happened — that is an
operational decision about one guard's July, taken deliberately, by someone who
knows they are also removing the suite's only live demonstration. It is not
deployment tidying, and it is not a prerequisite for anything in this plan.

The check goes green when the data is right. Not before, and not by any other
route.

---

## 6. The four accounting reds on SANDBOX, one verdict each

The question asked was the right one: is any of these a defect in a *rule*
rather than in *fixture data*? Taken one at a time.

### `bank_per_account_gl_equals_operational` — 3 accounts, and it is two different things

The rule: `GL balance − outstanding outgoing cheques = bank_accounts.balance`.
Correct as written.

| account | GL | operational | difference |
|---|---|---|---|
| United Bank Ltd | 800,000.00 | 0.00 | **800,000.00** |
| Meezan Bank | 3,897,934.00 | 3,843,255.00 | 54,679.00 |
| Habib Bank Ltd | 620,610.00 | 536,822.00 (less 50,000 pending) | 33,788.00 |

**United Bank Ltd is not fixture noise.** It has exactly one journal line — an
800,000 opening balance from `opening_balance_batches` dated 2026-05-31 — and
zero `bank_transactions`. It is also **the only account in either database with
`auto_zero_monthly = true`**. `apply_monthly_account_zeroing()` sets the
operational balance without writing a `bank_transactions` row and without a
journal entry, which is precisely the 800,000-shaped hole visible here.

So the honest verdict is: **the rule is right, the data is sandbox data, and the
cause is a live mechanism that is on production and would behave identically the
moment anyone ticks that box on a real account.** Calling it "fixture data" and
moving on would be the comfortable answer and the wrong one.

**This is no longer accepted — it is removed.** `0308` drops the function at the
head of Stage A and `0309` drops the columns in Stage D. §6a has what it
actually did, which is worse than the paragraph above, and how the removal was
proved before it was made.

**Meezan and Habib are fixture data.** Both have `auto_zero_monthly = false` and
both reconcile perfectly on the operational side: `balance − Σ account_delta`
equals the opening balance exactly (5,000,000 and 1,250,000). The gap is on the
GL side — 39 `payroll` bank transactions across the two accounts carry a **null
`reference_id`**, created during the 2026-08-25/28 fixture load, with no payslip
disbursement posting to match. Transactions written directly rather than through
the posting path. **The rule is right; the fixture wrote round the rule.**

### `bank_accounts_equal_transaction_deltas` — expected −876,923, actual −1,676,923

Difference: **exactly 800,000.** The same United Bank Ltd figure, counted a
second way. Not an independent finding and not an independent defect. **Rule
correct.**

### `bank_control_equals_bank_accounts` — expected 5,833,178, actual 6,771,645

Difference: **938,467 = 800,000 + 54,679 + 33,788 + 50,000.** The three
per-account differences plus the outstanding cheque that the per-account check
nets off and this one does not. It is the aggregate of the other two and
**cannot go green before they do**. **Rule correct.**

### `no_negative_custodian_balance` — 2 locations

```
HAMNA   −3,477.00      opening_balance 0.00
Safi    −1,999.87      opening_balance 0.00
```

Cash was disbursed from custodian floats that were never funded — no opening
balance, no transfer in. **Rule correct, and it is worth saying why rather than
just asserting it:** a physical cash float cannot hold a negative amount. A
custodian who spends money they were never given has created a payable, and the
correct model is a payable, not negative cash. A check that tolerated this would
be tolerating a category error, not a rounding one.

### Verdict on all four

**None of the four is a defect in a rule.** Three are fixture data. The fourth —
the 800,000 — is a real mechanism defect demonstrated on fixture data, and it is
**removed by `0308` at the head of Stage A** rather than accepted.

## 6a. `apply_monthly_account_zeroing` — REMOVED FROM PRODUCTION 2026-09-01

**Applied to `crm-design` (`mmkfpnshxjcyijhuydgr`) on 2026-09-01 under a named
authorisation for Stage A.** The function is gone, all nine bank accounts are
byte-identical to the pre-migration snapshot, no probe row survived, and the
recorded SQL digest equals the file. The flag survives on one row — the
sandbox's United Bank Ltd — and is inert until `0309`.

The proof block ran **on production** and passed: an account seeded at 1,250,000
with no transaction history, one call, balance 0, nothing written to explain it.
That is the demonstration on the database it mattered on, not on a copy.

`0309` carried the identical defect — it required United Bank Ltd at GL 800,000
and `bank_accounts` at exactly 18 columns, both readings of dev — and was
corrected the same way before it can reach Stage D: every row compared
byte-identical in both directions, and the surviving column names compared as a
**set** against what was there before rather than as a count. Both files now
assert only what the change must preserve, and both recorded digests equal their
files on dev; `0308`'s also equals its file on prod.

### What it did, and the description above was too kind

Reading the function rather than the symptom changes the finding. It **does**
write a `bank_transactions` row for its month-end adjustment, and it writes no
journal entry for it. But that is not where the 800,000 went. The destructive
statement is the last one in its loop, and it is unconditional:

```sql
update public.bank_accounts b
   set balance = coalesce(
         (select sum(account_delta) from public.bank_transactions
           where bank_account_id = b.id), 0),
       last_zeroed_month = ...
 where b.id = acct.id;
```

**It recomputes the balance from `bank_transactions` alone, and every opening
balance in this system was seeded directly onto `bank_accounts.balance` with no
transaction row.**

| account | balance | Σ account_delta | difference |
|---|---|---|---|
| Habib Bank Ltd | 536,822 | −713,178 | **1,250,000** — its opening balance |
| Meezan Bank | 3,843,255 | −1,156,745 | **5,000,000** — its opening balance |
| United Bank Ltd | 0 | 0 | **0** — gone |

United Bank Ltd is the one account in either database with the flag set.
Nothing was "zeroed": an opening balance was overwritten by a recomputation
from a log that never contained it. **Tick the box on Habib Bank Ltd and the
next page load silently removes 1,250,000 the same way.**

**"Confirm nothing calls it first" — something does, and it is worse than a
button.** `Accounting.tsx` calls it at the top of `loadAll()`, so it ran on
**every load of the Accounting page**, inside a `try/catch` whose comment says
the error may be ignored. The catch never fired either way: `supabase.rpc()`
resolves with an error object rather than throwing, so any failure was
discarded silently for as long as the call existed.

That is also why the removal is not a coordinated release. Dropping the
function leaves the deployed build working, because it was already ignoring the
result. `0308` therefore drops the function alone; the frontend commit removes
the call, the checkbox, the insert and the type field; and `0309` drops the two
now-unreferenced columns in Stage D, refusing to run if anything still names
them and never using `CASCADE`.

`0308` **proves the mechanism before removing it**, in a rolled-back
subtransaction: seed an account at 1,250,000 with no transactions, call the
function once, require the balance to be 0 and no row to have been written to
explain it. A removal justified by a story is a removal nobody can check later.

**United Bank Ltd is not repaired.** The 800,000 stays visible in
`bank_per_account_gl_equals_operational` as the standing evidence that the
mechanism was real, and both `0308` and `0309` assert that number so a change
to it is a new finding rather than a quiet tidy-up.

## 6b. The three accepted reds, at their numbers

Accepted, and **the numbers are written here so a change is visible.** An
accepted red whose figure nobody recorded is an ignored red.

| check | accepted state | cause |
|---|---|---|
| `bank_per_account_gl_equals_operational` | **2 accounts** after `0308` — Meezan **54,679.00**, Habib **33,788.00** (plus United Bank Ltd at **800,000.00**, which is evidence, not an acceptance) | 39 `payroll` bank transactions with a null `reference_id`, written by the 2026-08-25/28 fixture load with no matching payslip disbursement posting. **Fixture data.** |
| `bank_accounts_equal_transaction_deltas` | expected **−876,923.00**, actual **−1,676,923.00**, difference **800,000.00** | The United Bank Ltd figure counted a second way. Not an independent finding. |
| `bank_control_equals_bank_accounts` | **CORRECTED 2026-09-01 — see below.** expected **5,833,178.00**, actual **−578,456.00**, difference **6,411,634.00** | Opening balances were seeded straight onto `bank_accounts.balance` with no transaction or journal row (Habib 1,250,000 + Meezan 5,000,000 = 6,250,000 of it). **Cannot go green before Block 4 moves bank postings to named accounts.** |

### CORRECTION, 2026-09-01 — the `actual` above was dev's number, not production's

The figure originally recorded here was **6,771,645.00**, giving a difference of
938,467.00. Production's gate returned **−455,333.00** after Block 2, and the
gap was not explained by the day's activity. It was not drift.

`journal_entries.created_at` makes the baseline recoverable retroactively,
without needing a measurement nobody took. Restricting the check's `actual` side
to lines whose entry was created before 2026-09-01 00:00 UTC — before this
deployment touched anything:

```
actual, before deployment   −578,456.00   (124 lines)
moved today                 +123,123.00   (1 line)
actual now                  −455,333.00   (125 lines)
```

**Production's bank control GL has always been negative.** 6,771,645.00 was
measured on dev and recorded here as though it were a property of the check.
That is §9.14 in the plan rather than in a migration: a number read off one
database and written down as a fact about the system.

The defect magnitude never moved:

```
                       expected        actual      difference
baseline (pre-deploy)  5,833,178.00   −578,456.00  6,411,634.00
after Block 2          5,956,301.00   −455,333.00  6,411,634.00
```

**Both sides rose by exactly 123,123.00 and the difference is identical to the
rupee.** Nothing this deployment did touched a bank account; `0265`'s fourteen
entries carry no `bank` line at all.

### Live activity moves the checks without moving the findings

The same 123,123.00 appears on both sides of
`bank_accounts_equal_transaction_deltas` — expected −753,800.00, actual
−1,553,800.00, difference still exactly **800,000.00**.

**A future reader must not treat these changed numbers as drift.** Production is
in live use while seventy migrations replay across it, and a user booked an
invoice payment on 2026-09-01 while Block 2 was running. Both bank checks
absorbed it on both sides. The check moved; the finding did not.

Gate figures in this document are therefore differences first and absolute
figures second. Compare the difference. If the difference moves, that is a
finding; if only the absolutes move, look for the transaction that explains
both sides before calling it anything.
| `no_negative_custodian_balance` | **2 locations** — HAMNA **−3,477.00**, Safi **−1,999.87**, both `opening_balance` 0.00 | Cash disbursed from custodian floats that were never funded. **Fixture data.** A physical float cannot hold a negative amount; a custodian who spends money they were never given has created a payable, and the correct model is a payable, not negative cash. |

All four figures are on `SANDBOX TESTING ORG`, which exists on production and is
not customer data. **Any of these numbers moving after deployment is a new
finding, not drift.**

---

## 7. The rollback position

There is no lever. The guard deployment had one — a flag that turned enforcement
off and left the schema intact. The ledger has no equivalent, and it is worth
being precise about why: the guard deployment changed *behaviour* on an
unchanged schema, so behaviour could be switched back. This deployment changes
the schema, reposts data, and drops columns. There is nothing to switch.

What exists instead, in the order it would actually be used:

1. **Stage ordering is the mitigation.** A, B, C are each independently
   abandonable — stop, and prod sits on a coherent earlier schema with the new
   frontend not yet shipped. The irreversible work is all in D, last, and D is
   short.
2. **Forward-only correction.** A defect found after Stage D is fixed by
   `0308`, not by undoing `0267`. This is already how the whole stream has
   worked: `0302` corrected `0301`, `0305` corrected `0303`, `0288b` corrected
   `0288`. The stream's own history is the evidence that forward correction
   works here.
3. **A snapshot taken immediately before the window**, and the specific thing to
   understand about it: **restoring it is a full-database restore, not a partial
   one.** Any customer write made after the snapshot and before the restore is
   lost. So it is a genuine last resort, and it argues for a window when nobody
   is working — which for a Pakistani guard company is a Sunday, not a
   weeknight.
4. **`ledger_checks()` is the detector, and it is scheduled.** After `0301` it
   runs at 05:00 daily and raises an alert per red check per company through
   both channels. The first morning after the deployment is therefore an
   automatic report, not a manual one. **This is the real safety property of the
   deployment**: not that it can be undone, but that a divergence introduced by
   it announces itself within 24 hours to a mechanism whose own silence is
   itself checked (`alert_delivery_is_healthy`).
5. **What is NOT available, said plainly:** the migration set cannot be replayed,
   so a mid-deployment failure cannot be recovered by re-running from the top
   against a restored snapshot *from the repo*. The restore has to be of the
   database, not a rebuild. That is the cost of the replay-safety debt in
   PRE_GO_LIVE, and this deployment is the first time it has a price attached.

---

## 8. The UI gates

Three, none of which is enforced by the database and all of which are therefore
somebody's responsibility on the day.

### Manual journal with a NULL branch

`post_manual_journal` validates both accounts against the company and refuses a
cross-tenant pair (`0242b`). What it does not do is require a **region**. A
manual journal posted with a NULL `branch_id` lands on Head Office by default,
and Head Office cost is apportioned to regions by revenue (A10). A
misattributed manual journal therefore does not sit in one place looking wrong —
it **spreads across every region in proportion to revenue**, which is the
hardest kind of error to see and the hardest to unwind.

**The gate: the manual-journal form must require a region before it will
submit, and the field must not default.** A default is what produces the silent
case. This is a UI change and it is not in this migration stream; it is listed
here because the stream is what makes manual journals reachable, and because
`0245` makes the resulting entry immutable once posted.

Not enforced in the database deliberately: a NOT NULL on `journal_entries.
region_id` would break every automatic posting that legitimately has no region.

### The two others

* **Period-close refusals must reach the user as sentences.** PRE_GO_LIVE §1
  step 2 already says a raw `P0001` in a toast is a fail. Stage B adds roughly a
  dozen new refusal paths, and each one is a message a user will meet.
* **The month-end auto-zero checkbox is gone and nothing replaces it.** An
  account that should be emptied needs a transfer that posts, not a flag that
  rewrites a number. If someone asks for the feature back, that is the answer,
  and §6a is why.
* ~~`PartnerFormModal.tsx` writes `partners.basis`.~~ **Discharged.** Checked
  today: the column does not exist on prod, `0232` is recorded there, and the
  form reads `finance_settings.partner_remuneration_basis` instead.

---

## 9. What must be true before it starts

Each of these is checkable, and several are already true.

| # | condition | state today |
|---|---|---|
| 1 | Every company on prod has `finance_settings.partner_remuneration_basis` | **true** — all four, `'cash'`. `0304` makes `ledger_checks` depend on it |
| 2 | Prod's recorded SQL equals the repo file for every migration already applied | to be re-run with `scripts/check-migrations.mjs` against prod's own key |
| 3 | A read-only prod service credential exists, or the check runs another way | **blocked** — CLAUDE.md records that no restricted prod credential exists |
| 4 | The period-close exercise has been run end to end on dev, through the app | **not done** — the Stage B gate |
| 5 | `0265`'s six lines and `0274`'s Ironclad rows counted on prod first | not done |
| 6 | `0263`/`0268`/`0273`/`0277` backfill coverage confirmed as a `count(*)` on prod | not done |
| 7 | The frontend build is cut, typechecked, and staged but not deployed | typecheck passes on the current tree |
| 8 | A snapshot immediately before the window, with its restore time known | not arranged |
| 9 | The four SANDBOX reds accepted in writing, with their numbers | **this document, §6** |
| 10 | ~~Shayan's sign-off on `0230`/`0231`/`0232`~~ | **moot — already applied to prod.** See the note below |
| 11 | **The commit behind the currently deployed frontend is identified**, and grepped for the five dropped column names in §4 | **not done — the largest unresolved variable in the plan** |
| 12 | The `0265` pre-flight count taken on production between `0263` and `0265` | cannot be taken earlier; see §2 |

**Correction to PRE_GO_LIVE on (10).** Its manifest lists the partner
remuneration basis series as absent from production, with `partners.basis` still
present there and `PartnerFormModal.tsx` still writing it. Both halves are now
false, checked today: `0230`, `0231`, `0231b` and `0232` all carry
`schema_migrations` rows on prod, **`partners.basis` does not exist there**, and
`PartnerFormModal.tsx` reads `finance_settings.partner_remuneration_basis`
instead, with a comment saying why. That precondition and that frontend gate are
both discharged. The stale text is a reminder that a manifest is a measurement
and goes off like any other.

(3) is the uncomfortable one. The digest rule — "the recorded SQL must equal the
file" — is the rule this project has broken and repaired more than any other, and
it cannot currently be checked on production at all, because the anon key cannot
read `supabase_migrations.schema_migrations` and there is no restricted service
credential. **The deployment can proceed without it. It should not.** Issuing a
read-only prod credential is a small task that removes the single largest blind
spot in this plan.

## And what must be true after

| # | condition |
|---|---|
| 1 | `ledger_checks()` returns **26 rows** per company on prod and the `checks_evaluated` canary **passes** — the verdict column, not the two operands |
| 2 | `uninvoked_controls()` reports **11**, and `every_control_is_invoked` is red at exactly 11 with the eleven named in `UNINVOKED_CONTROLS_VERDICTS.md` |
| 3 | `tenant_guard_covers_every_parameter` is **green** |
| 4 | `no_gate_mode_in_attendance_status` is red at **24** on `GUARDS AND GUIDES (PVT) LTD` and green everywhere else |
| 5 | The SANDBOX reds are red **at the numbers in §6b** — Meezan 54,679.00, Habib 33,788.00, United Bank Ltd 800,000.00, aggregate 938,467.00, two custodians at −3,477.00 and −1,999.87. A different number is a new finding, not drift |
| 6 | `alert_delivery_is_healthy` goes **green** after the first 05:00 run, and not before. If it is still red on day two, the cron job is not running and that is the first thing to check |
| 7 | `cron.job` has **five** active jobs on prod, with `ledger-checks-daily` at 05:00 ahead of `send-compliance-alerts-daily` at 06:00 |
| 8 | `0238` changed nothing |
| 9 | No `ZZ …PROBE…` client, expense, invoice or bank account, no `zz_…` function, no `accounting_periods` row that the deployment created |
| 11 | `apply_monthly_account_zeroing` does not exist, nothing in the database names it, and `bank_accounts` has 18 columns |
| 10 | Every migration in the stream has a `schema_migrations` row whose digest equals its file |

Condition 6 is the one worth waiting for. Every other check tells you about the
ledger; that one tells you whether anything would tell you.

---

## 10. What this deployment does not include

Stated so the absences are decisions:

* **The deployed-guards-at-a-client-with-no-active-contract check** — the one
  that would actually catch Palm Grove. `client_cost_has_an_invoice` (`0304`)
  reads `expenses.client_id`, and **not one of production's six expense rows
  carries one**. Logged, not built.
* **`employees.cnic_lifetime`** — proposed, awaiting Safi's data answer.
* **Weapon allotment and custody control** — deferred.
* **The three remaining uninvoked functions and views with a stated condition** —
  each waiting on data or a screen, per the verdicts document.
* **Making the migration set replayable** — real, bounded, and priced for the
  first time by §7.
* **Repairing United Bank Ltd's 800,000.** Deliberately not done. The mechanism
  is removed; the evidence stays, and both `0308` and `0309` assert the figure
  so that a later quiet repair is visible as a failed assertion rather than as a
  number that improved on its own.

## 11. The environment-assertion audit — all seventy files

The general form of §9.14: **a number measured in one database is not a property
of the migration.** `0308` shipped with one and would have aborted on
production. Rather than find the rest one abort at a time, all seventy were
scanned for four shapes — a hard-coded canary count, a tallied `if x <> N`, a
literal naming a row, and an amount inside a condition — and every hit read by
hand.

**The result is better than expected: three genuine cases, and one of them is
not a defect.**

### 1. The canary chain — deliberate, and the reason numeric order is mandatory

Eleven migrations hard-code the expected check count (table in §1). These are
**not** defects: the canary exists precisely to refuse a suite that is not the
suite it was told to expect, and hard-coding is how the expectation is stated.
`0302` improved the shape by collapsing the number to one place, not by removing
it.

What they *do* is remove all freedom of ordering. **They are why the four-stage
plan could not work**, and they are why the restaged plan gates rather than
groups.

### 2. `0265` — `if v_n <> 6` — correct, needs a pre-flight, cannot be taken early

Covered in §2. The refusal is right; the count must be measured on production
**after `0263` and before `0265`**, because the column it selects on does not
exist until `0263` populates it.

### 3. `0308` and `0309` — the two I wrote, both corrected

`0308` required United Bank Ltd at GL 800,000, true only on dev. `0309`
required the same, plus `bank_accounts` at exactly 18 columns. Both now assert
the invariant — every row byte-identical across the change, surviving column
names compared as a **set** — and print the environment figures as a `NOTICE`.
`0308` was corrected before it reached production; `0309` before it reached
Stage D.

### What the scan found that is NOT a problem

Worth recording, because a scanner that only lists hits teaches nothing about
what a safe version of the same shape looks like:

* **Nine migrations select `SANDBOX TESTING ORG` by name** — `0265`, `0268`,
  `0272`, `0274`, `0275`, `0276`, `0281`, `0282`, `0287`. Almost all guard it:
  `if v_co is null then return; end if`, or a `raise notice` saying the proof
  was skipped. `0275` is the model — it reports what it found, raises only if
  *every* location is negative ("the arithmetic is suspect, not the data"), and
  degrades to a notice when the company is absent. **That is the right pattern
  for a demonstration against fixture data**, and it is already the house style.
* **`0282`'s `-131120.00` and `-25224.00`** read like measured amounts and are
  not. They are **inserted** as a synthetic fixture row the migration then
  reverses, never compared against anything the database already held. A
  literal used as an input is not a literal used as an assertion.
* **`0284`'s `-3` days of drift** is likewise synthetic: it creates the
  divergence, then requires the check to find exactly that. The number is a
  property of the test, not of the data.
* **`0294`'s `if v_vw <> 14`** counts views the *migration itself* defines the
  exempt map for; it moves only when someone edits that map, which is the point.

### The rule the audit produces

> **Ask of every literal in a verification block: is this an INPUT the migration
> creates, or a READING of state it did not create?**
>
> Inputs are fine and often necessary — a probe amount, a synthetic three-day
> divergence, a fixture row. **Readings are landmines.** They pass everywhere
> they were written and abort in the first environment that differs, having
> given no warning, at the least convenient moment.
>
> When a reading is genuinely what you want to check, assert the *invariant* it
> is evidence for and print the reading as a `NOTICE`.

Three cases in seventy files is a low rate, and both of the avoidable ones were
mine, written this week. The stream's older migrations were already disciplined
about this; the pattern that failed is the one I introduced.

## 11a. `0268` — DEFERRED out of Block 3, 2026-09-01

**Not applied to production. Block 3 ran `0267`, then `0269`–`0275`.**

`0268` adds:

```sql
invoice_payments_cash_names_a_location
  check (payment_mode <> 'Cash' or custodian_location_id is not null)
```

The constraint is correct. **The deployed `record_invoice_payment()` cannot
satisfy it** — measured on production immediately before applying:

```
mentions of custodian_location_id in record_invoice_payment() ...... 0
signature .... (p_invoice_id, p_amount, p_payment_date, p_payment_mode,
                p_bank_account_id, p_notes, p_withholding)
```

It inserts its `invoice_payments` row without a custodian, so **every cash
receipt through the application would be refused from the moment `0268` lands**.
That is the regression `0281` documents, and putting it on production knowingly
is worse than shipping it by accident.

**`0281` does not restore the path on its own.** It replaces the opaque
`23514 ... violates check constraint` with `'Select the custodian who received
the cash'`, and raises whenever `p_custodian_location_id` is null. The deployed
frontend calls the seven-argument form and passes nothing. Better error, same
outage.

**Release, therefore, not a migration ordering problem.** `0268` + `0281` + the
frontend change that passes a custodian, together. Until all three ship, the
path is only restored by not applying `0268`.

Nothing in `0269`–`0275` depends on it: no reference to its constraints, none of
them insert into the four constrained tables, and it adds no `ledger_checks`
row, so `0271`'s `<> 16` and `0275`'s `<> 17` are unaffected. `0273` names
`0268` in prose only and constrains `cheques`.

### The rule this produced

> **A PRE-FLIGHT MUST CHECK WHETHER THE DEPLOYED CODE CAN SATISFY THE NEW
> CONSTRAINT, NOT ONLY WHETHER THE EXISTING DATA DOES.**

A data-only pre-flight **passes this migration**: zero violating rows across all
four tables, on production, at the moment of checking. The outage is in the
writer, not the data, and no query over the four tables would have found it.
Same family as §9.9 — a constraint proved only by what it refuses is half
proved — but one layer earlier: here the refusal had not happened yet and the
only way to see it was to read the code that would trip it.

Applies to every remaining CHECK or NOT NULL in this deployment. `0273` was
pre-flighted the same way for the same reason and came back clean: 2 outgoing
cash cheques, both carrying a custodian, and the deployed cheque path writes the
column.

## 12. Outstanding corrections, not applied

| # | what | why not done here |
|---|---|---|
| 1 | `0302`'s header attributes the canary defect to `0301`; it was `0300` | editing an applied migration means realigning dev's recorded SQL — a write, and this turn applies nothing |
| 2 | §9.6 of `TENANT_GUARD_REPORT.md` repeats the same attribution | doc-only, batched with (1) so the two never disagree |
| 3 | `PRE_GO_LIVE.md` still describes the four-stage grouping in its manifest section | superseded by §1 here; the older text should point at it |
| 4 | `0308` refers to the column drop as `0309`; it is now `0311` | `0308` is applied to **production** — correcting a comment would mean rewriting a production migration's recorded SQL. `0311`'s header carries the explanation instead. |

## 14. A second writer reached production during this deployment

**2026-09-01.** While Stage A was in progress, a migration was applied to
`crm-design` from another branch:

```
20260901081810  0308_remove_monthly_account_zeroing      (this plan, 08:18)
20260901091450  0309_confirm_backdate_override_bypass    (another branch, 09:14)
```

It replaces `enforce_attendance_backfill()` so that an explicit supervisor
override clears the attendance backdate lock. It is deliberate work by a second
developer and it stands; **production holds priority for that function**.

It was found by running the migration-digest check by hand while answering an
unrelated question about credentials. Nothing announced it. It had been on
production for roughly an hour.

### The three consequences, and what was done about each

| | consequence | resolution |
|---|---|---|
| 1 | **A recorded migration the repository does not describe** — CLAUDE.md's "second direction, and the serious one" | **File written from the recorded SQL**, byte-exact, digest `0f3c3f7a97d3b220d33f9b41d6a00c0e`. This session applied it to dev, so this session created the fileless row; leaving it for its author is how that state becomes permanent. If his push differs, the digest check flags it — visible and resolvable. A missing file is neither. |
| 2 | **A number collision.** This plan's `0309` was `0309_drop_auto_zero_columns` | **This plan's file moved, not the one already on production.** It is now `0311_drop_auto_zero_columns`; `0310` was taken. Dev's ledger row was renamed and its recorded SQL realigned; digest verified equal to the file. |
| 3 | **Production ahead of dev on a behavioural change** | The same SQL was applied to dev under the same migration name. **Both databases now record digest `0f3c3f7a97d3b220d33f9b41d6a00c0e` and hold an identical `enforce_attendance_backfill` (`526a76092e186091bc85bff2e00899ae`).** |

`0308`'s header and its column comment still say "the column is dropped by
`0309`". That reference is now stale. **`0308` is already applied to
production**, and rewriting the recorded SQL of a production migration to fix a
cross-reference is a larger risk than the stale reference — so it stands, and
`0311`'s header explains it. Listed in §12.

### What this changes about the plan

Not the order, and not the gates. It changes an assumption that was never
written down: **that this deployment is the only thing writing to production.**

Every gate in §1 states what should be true at that point. None of them says
*and nothing else has been applied since the last gate*. That is now a gate
condition, and it is cheap:

> **At every gate, re-read `supabase_migrations.schema_migrations` on production
> and confirm the only new rows are the ones this plan just applied.**

The deeper version, which is the reason the read-only credential matters more
than it did yesterday:

> **A DEPLOYMENT PLAN IS A CLAIM ABOUT A DATABASE THAT SOMEONE ELSE CAN ALSO
> WRITE TO. IT MUST BE RE-CHECKED AGAINST THE DATABASE, NOT AGAINST ITSELF —
> AND THE CHECK HAS TO BE CHEAP ENOUGH TO RUN AT EVERY STEP, OR IT WILL NOT BE
> RUN.**

Today that check needs an agent session with MCP access. That is why §9's
precondition 3 moved from "should" to "before Block 2": a check nobody can run
unattended is a check that runs once, by accident, an hour late.


---

# BLOCK 3 — APPLIED TO PRODUCTION, 2026-09-01

`0267`, `0269`–`0275` applied to `crm-design` (`mmkfpnshxjcyijhuydgr`).
**`0268` deferred — see §11a.** All eight recorded digests equal their files,
none carries a trailing newline, and `0268` has no row.

## The predicted clearance, confirmed

`cash_per_location_gl_equals_operational` went **GREEN**, and it cleared for
exactly the reason G3 gave:

```
#1234    cash  outgoing  cleared 2026-08-28  5,000.00  Bilal Ahmad  -> posted
#222333  cash  outgoing  cleared 2026-08-28  5,000.00  Kiran Shah   -> posted
```

Same two custodians, same amount, same date, same cause — a `pending -> cleared`
transition spent before `0221` existed, unreachable by a transition-keyed rule
and repaired by a state-keyed one. Cash control 444,879.13 -> 454,879.13,
+10,000.00 exactly. Trial balance moved by the same 10,000 and still balances.

**G3's diagnosis is confirmed against production**, not against dev.

## Gate: 13 of 17 pass

| red | figure | verdict |
|---|---|---|
| `bank_accounts_equal_transaction_deltas` | difference **−800,000.00** | Accepted red, unchanged. |
| `bank_control_equals_bank_accounts` | difference **−6,421,634.00** | Was −6,411,634.00 at the Block 2 gate. Moved by exactly **10,000.00** — the two cheque clearings `0269` posted, crediting bank. Explained; the accepted red is otherwise unchanged. |
| `bank_per_account_gl_equals_operational` | **5 accounts** | NEW, from `0271`. Expected red on arrival per `0259`'s rule. |
| `no_negative_custodian_balance` | **2 locations** | NEW, from `0275`. HAMNA and Safi, the two already recorded in §6b at these numbers. |

Newly green and staying green: `no_billing_clients_on_head_office` (`0274`),
`cash_per_location_gl_equals_operational` (`0269`), `every_source_row_posted`
(`0269`, extended by `0272`). Canary at 16/16.

## `bank_per_account_gl_equals_operational` — 5, and §6b says 2

§6b records **2 accounts** (Meezan 54,679.00, Habib 33,788.00, plus UBL
800,000.00). Production returns **5**, at different figures:

```
Meezan Bank      operational 3,843,255.00  gl   −500,000.00  diff −4,343,255.00
Habib Bank Ltd     "   536,822.00  outstanding 50,000.00  gl −5,000.00  diff −591,822.00
ss                 "   990,000.00  gl 490,000.00           diff   −500,000.00
Askari Bank        "   355,000.00  gl   5,000.00           diff   −350,000.00
aa                 "   231,224.00  gl       0.00           diff   −231,224.00
```

**This is the same class as the `bank_control` baseline corrected above.** §6b's
figures were measured on dev; this check reaches production for the first time
here, so it has no production baseline to have drifted from. The shape is
consistent with what `0271`'s own header predicts: every bank sub-account holds
its opening balance and little else, because bank postings have been landing on
the undifferentiated control. Block 4 is where that is fixed.

**Recorded as the production baseline for this check**, so a later change is
measurable against a figure that came from the database it describes. It is
not yet a finding; it is the first honest reading.
