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

---

# THE CLOSE GATE — PRODUCTION CANNOT CLOSE A MONTH, 2026-09-01

Found at the Block 3 gate. **Priority above Block 4.**

```
trg_bbb_first_close_needs_openings installed on prod ... YES (0260, 11:57)
accounting_periods rows ................................ 0
opening_balance_batches rows (any status, any company) . 0
journal entries from opening batches ................... 0
companies .............................................. 4
```

`accounting_periods` is empty, so **every company's next close is its FIRST
close**, and `0260`'s trigger refuses every one of them for want of a posted
batch that exists for no company.

**Production cannot close a month, for any of the four companies.** Nobody has
hit it because nothing has been closed all year; that is the only reason it is
not already a support call.

The gate is correct and is doing exactly what it was built to do. The fix is the
batch, not a change to `0260`. `0260`'s header says "nothing is grandfathered,
because there is nothing to grandfather" — true of every EXISTING close, and
silent about the fact that no FUTURE close can happen either. On dev this was
invisible because G1 had already posted SANDBOX's batch.

## The 7,510,101.00 is not a coincidence

`0260`'s header cites 7,510,101.00 as what SANDBOX carried in
`bank_accounts.opening_balance` with nothing in the general ledger. Production's
`bank_accounts.opening_balance` sums to **7,510,101.00 exactly, right now**.

The header was written about dev and describes production to the rupee **because
both were seeded the same way and neither was ever posted** — the same number for
the same reason, not a coincidence. It is also the size of the gap **Block 4 does
not close**.

## CORRECTION TO `0271`'s HEADER — the ~6.4M is not a routing defect

`0271`'s header predicts that bank sub-accounts hold "exactly the opening balance
and nothing else" because postings land on the undifferentiated control. **That
explanation does not fit production's numbers and should not be believed by the
next reader.**

```
Meezan Bank   operational 3,843,255.00   gl −500,000.00   diff −4,343,255.00
```

A sub-account at −500,000 against an operational 3.84M is not an opening balance
in the wrong place. It is an opening balance **that was never posted anywhere**,
which is a different defect with a different fix. Measured, not argued: prod has
zero opening batches.

Posting the openings moves the bank GL from −465,333.00 to 7,044,768.00 against
an expected 5,956,301.00 — closing about **5.33M of the 6.42M** and leaving about
**1,088,467.00**, which still contains United Bank Ltd's 800,000.00 (opening
recorded, operational zeroed by `apply_monthly_account_zeroing`; §6a keeps that
visible deliberately).

**Correcting `0271`'s own header means editing an applied migration and
re-applying it to production.** Not done here — logged in §12 alongside `0302`'s
header, for the same reason.

## SANDBOX TESTING ORG — the batch, line by line. PROPOSAL. NOT APPLIED.

Nine debit lines, one per bank account, each to that account's own GL
sub-account. Figures are `bank_accounts.opening_balance` as recorded on
production; none is derived or inferred.

| # | GL account | bank account | debit |
|---|---|---|---:|
| 1 | `1010.01` Meezan Bank | 0102-0100-1234-5601 | 5,000,000.00 |
| 2 | `1010.02` Habib Bank Ltd | 0234-7900-4455-0002 | 1,250,000.00 |
| 3 | `1010.03` United Bank Ltd | 0345-2200-8899-0003 | 800,000.00 |
| 4 | `1010.05` Askari Bank | 0567-4400-6677-0005 | 350,000.00 |
| 5 | `1010.09` aa | 0010112274540012 | 110,101.00 |
| 6 | `1010.04` Bank Alfalah | 0456-3300-1122-0004 | 0.00 |
| 7 | `1010.06` JS Bank | 0678-5500-3344-0006 | 0.00 |
| 8 | `1010.07` ss | 0067855003344333 | 0.00 |
| 9 | `1010.08` abl | 0010112274540012 | 0.00 |
| | | **total debit** | **7,510,101.00** |

Balanced by one credit of **7,510,101.00**. The schema already designates the
account: `3200 Opening Balance Equity`, `system_key = 'opening_balance_equity'`.

**The four custodian cash locations contribute nothing**, because all four carry
`opening_balance = 0.00`:

```
Bilal Ahmad 0.00   HAMNA 0.00   Kiran Shah 0.00   Safi 0.00
```

**That is exactly what `no_negative_custodian_balance` is red about.** HAMNA at
−3,477.00 and Safi at −1,999.87 are custodians who spent money the system never
recorded them receiving. If their true openings are non-zero, this batch is where
that is recorded and the check goes green for the right reason. **THE FIGURES
COME FROM SAFI, NOT FROM ARITHMETIC.** Nothing here invents them.

## The other three companies open at nothing

`GUARDS AND GUIDES (PVT) LTD`, `guards n guides` and `Sandboxx` hold **zero bank
accounts and zero cash locations** on production. Their batch is the single
`0.00 / 0.00` line `0260`'s header prescribes for a company that genuinely opens
at nothing — an explicit record rather than a silent exemption.

`GUARDS AND GUIDES (PVT) LTD` is real customer data (527 employees, zero bank
accounts). **Whether it truly has no opening balances is a question for Shayan,
not a derivation from an empty table.**

## Outstanding before the batch can be posted

1. **`as_of_date`** — accounting policy, not derivable. Shayan's.
2. **The credit account** — `3200 Opening Balance Equity` is the schema's own
   designation and the obvious candidate; confirming it is still his call.
3. **Custodian openings** — from Safi, if any.
4. **Whether GUARDS AND GUIDES has real openings.**

The batch is data on production and gets **its own named authorisation** once
those land.

---

# BLOCK 4, SPLIT — `0276`–`0279` APPLIED TO PRODUCTION, 2026-09-01

**Nothing from `0280` onward.** `0280` crosses the deployed-build boundary (§4)
and belongs to the frontend release. All four recorded digests equal their
files; none carries a trailing newline.

`0276` and `0279` were pre-flighted immediately before applying, per §11a's rule
— both correct existing rows.

## `0276` — and the pre-flight caught another dev-measured header

The header says "45 live entries, netting −728,456.00". **Production had 47
entries netting −455,333.00**, 46 routable and 1 without a named account. `0276`
carries no hard count assertion, so it did not abort — but it is the third
dev-measured figure in a header met on production. Recorded, not corrected in
the file (that needs a re-apply; §12).

Bank control account, on its own: **−455,333.00 → +150,000.00**.

`bank_control_equals_bank_accounts` did **not** move, and that is correct rather
than disappointing: it sums the whole subtree, so moving a line from the parent
to a child cancels inside its own aggregate. That is precisely the blindness
`0276`'s header describes and `0271` exists to see past.

## THE BANK GAP IS NOW FULLY DECOMPOSED

`bank_per_account_gl_equals_operational` went **5 → 4**, and every remaining gap
resolves exactly into an unposted opening balance plus a residual already named
in §6b:

| account | difference | opening_balance | residual |
|---|---:|---:|---:|
| `aa` | −110,101.00 | 110,101.00 | **0** — pure unposted opening |
| Askari Bank | −350,000.00 | 350,000.00 | **0** — pure unposted opening |
| Meezan Bank | −4,945,321.00 | 5,000,000.00 | **54,679.00** — §6b's Meezan figure, to the rupee |
| Habib Bank Ltd | −1,216,212.00 | 1,250,000.00 | **33,788.00** — §6b's Habib figure, to the rupee |
| `ss` | **0.00** | 0.00 | reconciled exactly |
| United Bank Ltd | 0.00 | 800,000.00 | GL and operational both 0; the 800,000 stays visible in `bank_accounts_equal_transaction_deltas` per §6a |

**`ss` reconciles to 0.00 exactly** — operational 990,000.00, GL 990,000.00 —
where it was −500,000.00 at the Block 3 gate. `0272` posted the transfer and
`0276` routed it to the named account; together they closed it completely.

This settles what the ~6.4M is. It is **the opening balances that were never
posted**, plus 54,679.00 and 33,788.00 that §6b already named and attributed.
Nothing unexplained remains on the bank side. The batch closes the rest, and no
migration in this deployment does.

## Gate: 13 of 17

Unchanged reds: `bank_accounts_equal_transaction_deltas` (−800,000.00),
`bank_control_equals_bank_accounts` (−6,421,634.00, subtree-blind as above),
`no_negative_custodian_balance` (2). `bank_per_account` improved 5 → 4.
Trial balance 29,718,023.61, balanced. Canary 16/16.

## `0277` confirmed the 88,467.00 on production

Pre-flight measured **29 violating payslips, excess 88,467.00 exactly**, one
company — matching the header to the rupee. `not valid`, so they stay visible.
The over-payment probe was refused and `amount_paid` is now inside
`enforce_payroll_run_lock`.

---

# THE SANDBOX OPENING BATCH — POSTED TO PRODUCTION, 2026-09-01

Authorised by Shayan, this data change only. `as_of_date` **2026-08-31** —
September is the first real financial month.

```
batch status  posted     lines 10     debits 7,510,101.00     credits 7,510,101.00
journal entry created, debits 7,510,101.00
```

Nine bank lines at each account's own `bank_accounts.opening_balance`, to that
account's own GL sub-account, balanced by one credit to **`3200` Opening Balance
Equity** — a suspense account by design, holding the balancing figure until the
openings are verified, then netting to zero against retained earnings.

**No custodian lines.** Custodian openings come from Safi and are not available.
HAMNA (−3,477.00) and Safi (−1,999.87) stay red until those figures arrive.
Nothing was derived.

## The predicted effects, all confirmed

| account | before | after | predicted |
|---|---:|---:|---|
| `aa` | −110,101.00 | **0.00** | green outright ✓ |
| Askari Bank | −350,000.00 | **0.00** | green outright ✓ |
| Meezan Bank | −4,945,321.00 | **54,679.00** | falls to 54,679.00 ✓ |
| Habib Bank Ltd | −1,216,212.00 | **33,788.00** | falls to 33,788.00 ✓ |
| United Bank Ltd | 0.00 | **800,000.00** | — see below |

`bank_per_account_gl_equals_operational`: **4 → 3**.

**United Bank Ltd is not a new problem.** Its GL and operational were both zero,
so it netted to zero for the wrong reason — the opening was never posted AND the
operational balance had been destroyed by `apply_monthly_account_zeroing`.
Posting the opening puts 800,000.00 into the GL where it belongs and leaves
operational at zero, so §6a's standing evidence is now visible in a second check
rather than cancelling itself out. That is the check improving, not the data
worsening.

## `bank_control_equals_bank_accounts` moved, and it decomposes exactly

```
before   expected 5,956,301.00   actual −465,333.00   difference −6,421,634.00
after    expected 5,956,301.00   actual  7,044,768.00  difference  1,088,467.00
```

It moved because the batch **adds** to the subtree rather than moving within it —
the first change all deployment that this check could see.

The residual is fully accounted for, to the rupee:

```
   800,000.00   United Bank Ltd — opening posted, operational zeroed (§6a)
    54,679.00   Meezan Bank     — §6b's figure
    33,788.00   Habib Bank Ltd  — §6b's figure
   150,000.00   the bank CONTROL account's own remaining balance
    50,000.00   Habib's outstanding cheque — netted by the per-account check,
                not by this one (§6b says exactly this)
  ────────────
 1,088,467.00
```

**Nothing on the bank side is unexplained any more.** Trial balance
37,228,124.61, balanced. Canary 16/16. Gate 13 of 17.

---

# CORRECTION: "PRODUCTION CANNOT CLOSE A MONTH" WAS THE WRONG FRAMING

The earlier section said production cannot close a month for any of four
companies. **That reads as a defect and it is not one.**

No company can close a month it has no financial data for, and that is `0260`'s
gate working exactly as designed. Confirmed across nine tables rather than by
counting two:

| company | bank a/cs | cash locs | journal entries | invoices | expenses | payslips | employees |
|---|---:|---:|---:|---:|---:|---:|---:|
| SANDBOX TESTING ORG | 9 | 13 | 423 | 9 | 6 | 48 | 69 |
| GUARDS AND GUIDES (PVT) LTD | 0 | 0 | 0 | 0 | 0 | 0 | 553 |
| guards n guides | 0 | 0 | 0 | 0 | 0 | 0 | 527 |
| Sandboxx | 0 | 0 | 0 | 0 | 0 | 0 | 1 |

**SANDBOX is the only company with financial data**, and it can now close.

## No zero batch for the other three — and why that is not the same as zero

`0260`'s header prescribes a `0.00 / 0.00` line for a company that "genuinely
opens at nothing". **None of these three does.** Shayan's ruling on GUARDS AND
GUIDES states the distinction and it applies identically to all three:

> It has real bank accounts that have not been entered. It does not open at
> nothing — it has nothing to open with yet.

A zero batch would assert "this company started with nothing", which is false and
would then be locked in as the cutover position. **Post no batch for any of the
three.** Their first close being refused is correct.

## GUARDS AND GUIDES financial go-live — three ordered steps

1. Enter the real bank accounts and cash locations.
2. Post the opening batch from those figures.
3. The first close becomes possible.

Its financials are **not live**. Shayan does step 1 after the ledger work
completes. The same three steps apply to `guards n guides` and `Sandboxx` if
either is ever brought live.

---

# BLOCK 5 IN PROGRESS — `0286`, `0316b`, `0287`, `0288` APPLIED TO PRODUCTION, 2026-09-02

| file | digest | result |
|---|---|---|
| `0268` | `72383b350104eab7dabdc48d362ab268` | four CHECKs, all VALIDATED |
| `0286` | `c88fd602841df3026a9e200c611b298c` | tenant guard wired; reported **20**, not 19 |
| `0316b` | `fb9ac361b53fb563eb45f7951d85dcf8` | closed the twentieth; gaps **19** |
| `0287` | `a98b639187219f56f6d001ea4c90247b` | gaps **0**, 20 rows |
| `0288` | `3b2faacab260a6829c5b7ed987c75d7e` | `uninvoked_controls()` = **6** |

## THE TWENTIETH GAP WAS MINE

`0286` wired `tenant_guard_gaps()` into `ledger_checks` and it immediately
reported **twenty**. `0287`'s map is nineteen, and its PART 2b refuses unless
the map and the live list agree exactly in both directions. The extra:

```
withholding_written_after_cutover   p_company_id   claimed
```

added by `0316`, three migrations earlier, **in this same session** — inside
the interval where the detector that would have caught it was not yet wired to
anything that runs. That is `0312`'s rule arriving on its own author:

> A DETECTOR ADDED AFTER A DEFECT DOES NOT SEE THE INTERVAL IN WHICH THE
> DEFECT WAS INTRODUCED.

`0316b` closes it rather than adding a line to `0287`'s map, because a map that
absorbs whatever it finds is no longer a statement about the schema.

## OPEN, AND TRACKED HERE BECAUSE NOTHING ELSE CAN SEE IT

`0286` and `0288` each **replace** `ledger_checks` with their own list, written
before `0313` and `0316` existed. Two checks are therefore NOT in the suite
right now:

| check | detector | still correct? |
|---|---|---|
| `total_due_not_read_as_a_balance` | `total_due_read_as_a_balance()` | yes — returns 0 |
| `no_invoice_time_withholding` | `withholding_written_after_cutover()` | yes — returns 0 |

Only the WIRING is gone; both functions exist and both still answer 0.

**`uninvoked_controls()` cannot report this.** Its candidate predicate is
name-shaped — `gap|check|drift|residue|...` — and neither
`total_due_read_as_a_balance` nor `withholding_written_after_cutover` matches
it. So the suite lost two controls and the control that counts uncalled
controls is blind to both. That is a second-order instance of the same defect
`0288` exists to report, and it is why this note is written down rather than
carried in anyone's head.

### The restore lands AFTER `0302`, and that is not a preference

Restoring them now would set the canary constant to 22. `0301` bumps the canary
with

```sql
regexp_replace(v_new, '\m20::numeric,', '21::numeric,')
```

guarded by requiring `20::numeric,` to be present. With 22 in place that guard
fails and **`0301` aborts.** `0302` then collapses the constant to one number,
after which adding a check is a single edit that cannot be half-applied — which
is exactly the shape the restore needs.

**Sequence: `0288b`–`0299`, `0300`–`0302`, then the restore, then Block 7.**

---

# THE ROLLBACK PROOF — RUN ON DEV, 2026-09-02, BEFORE THE FIVE REACH PRODUCTION

`0291`, `0292`, `0293`, `0297` and `0298` probe **employees, clients and
contracts** — three protected categories — and they do it by MUTATING REAL
ROWS: setting eight date columns on a live employee, flipping `lifecycle_state`
through active → on_leave → left, blacklisting a guard, inserting a client, a
contract, two deployments, six employees and two `important_dates`.

Every one is inside a `begin … exception` subtransaction unwound by
`raise exception 'TESTS_OK'`. That is the *claim*. Reading it is not proof.

## Order

Run on dev **before** the five are applied to production, not between Block 5
and Block 6. A proof of unwinding that runs after the writes it is meant to
justify is a postmortem.

## Method

A snapshot function over every column any of the five touches — not merely the
tables. A digest that omitted `weapon_licence_expiry` would have been unchanged
whatever `0291` did to it, which is the vacuity this project keeps finding.

```
employees        id, full_name, lifecycle_state, status, client_id,
                 display_number, blacklisted, weapon_licence_expiry,
                 guard_service_licence_expiry, medical_fitness_expiry,
                 probation_end_date, cnic_expiry, weapons_cert_expiry,
                 refresher_due_date
clients          id, name, client_code, employee_id_prefix, contract_end
contracts        id, contract_code, status, end_date
deployments      id, guard_id, start_date
important_dates  id, title
```

## Result — identical after every one of the five

| table | rows | digest, baseline and after all five |
|---|---:|---|
| employees | 1147 | `6332637591472b6b8dbc1ec4229fbd19` |
| clients | 94 | `46abaa9e95e364c8c2965657eb9d9994` |
| contracts | 68 | `028f1e4d9ae403cb99dfbbfb72d0eebb` |
| deployments | 1451 | `44e48c380150472197d9ae4824a75324` |
| important_dates | 4 | `64a5fa440b15e131f89a6ff46d935fba` |

Compared after **each** migration, not once at the end: a single before/after
would have told us that the five together leave nothing behind, but not which
one to look at if they did.

Named-residue sweep afterwards — `ZZ 0298%`, `ZZ-0293`, `ZZ-CON-0293`,
`probe review`, `employee_id_prefix = 'ZZTEST'` — **0 rows.**

## Scope, stated rather than implied

The **verification blocks** were run, not the whole files. The DDL in these
five creates views and functions and touches no protected row, so the residue
question is fully covered. One deviation: `0293`'s steps 1–2 compare against a
temp table `_cu_before` built earlier in its file; that table was recreated as
a plain snapshot of the view. The mutating step 5 ran verbatim.

`0298`'s step 0 also passed on dev, which is a finding in its own right: **no
separated employee exists with no exit date, no last working day, no
termination date and no reason.** Nothing was fabricated by the old else-arm.

**Verdict: the subtransaction idiom holds for all five. Cleared for production.**

## Block 5, continued — `0291`–`0294` applied to production, 2026-09-02

| file | digest | result |
|---|---|---|
| `0288b` | `5b17b05b62e07ddd6469e3130edab6fc` | `ledger_checks` now reports itself |
| `0289` | `b22ed1c088c5d665a1928ccd0e7df352` | gate residue collapsed, figure unmoved |
| `0290` | `56f2bcb644d1cde1db7ce55bb839aff7` | gaps still **0** — no guard was credited to a comment |
| `0291` | `c2f45e9215c7c07fc622c3d97c135939` | view rebuilt, **169** rows |
| `0292` | `ab6b9e286ac6c149ea0d63dded4c49d4` | **169** rows — additive, nothing moved |
| `0293` | `6abd14df92de126fb449e6a02ea36336` | **171** rows: exactly +2 anomalies |
| `0294` | `04053d6a3dacaf825837b4760f49a405` | 6 functions + 14 views = **20** |

### The rollback proof holds on production too

After each of `0291`, `0292`, `0293`: zero probe residue. No `ZZ %` employee,
no `ZZTEST` client prefix, no `probe review` important_date, no `ZZ-0293`
client. The subtransaction idiom behaves on production exactly as measured on
dev.

### `0293` predicted the two, and production produced the two

The header names Palm Grove Resorts and Nova Textiles Mills as the clients
carrying `contract_end` with no active contract row. The view now reports
exactly those two, by name, and the row count moved from 169 to 171 — the
arithmetic closes with nothing else disturbed.

**Palm Grove Resorts still has four guards deployed against a contract that
expired 2026-07-31.** That is now visible on a screen for the first time.

### `0294` pre-flighted before applying, because it asserts two numbers

`0294` refuses unless the function arm is exactly 6 and the view arm exactly
14. Both were computed against production first, using the migration's own
predicate: **6 and 14**, and the fourteen were the same fourteen the header
names. The exempt map had **0 stale entries**.

Asserting a count without checking it first is how a migration aborts halfway
through a block for a reason that has nothing to do with the change.

`trial_balance` is among the fourteen: the ledger's central report, read by
nothing, while `ledger_checks_base` recomputes debits-equal-credits inline.
`0299` collapses that.

## Block 5, part 3 — `0295`–`0299` on production

| file | digest | result |
|---|---|---|
| `0295_raise_alert_dedupes` | `a18484318c3c24e02179829a48aa5529` | dedupe index + upsert; alerts still 0 |
| `0296_wire_disbursement_warning` | `f3a0269770ecfd442c18cd7d4595b468` | `check_disbursement` wired to `expenses` |
| `0297_deploy_guard_failures_not_gaps` | `4ebd1173386e1168c32427583cb7a6ca` | `check_deploy_guard` wired to failures only |
| `0298_reverse_map_refuses_rather_than_guesses` | `8353af943b7ab1ac50a36f9ea41a6ef6` | ambiguous employee insert raises 22023 |
| `0299_collapse_trial_balance_duplicate` | `1c7016990af36efe8a3721a870aeeefe` | `ledger_checks_base` reads `trial_balance` |

Every digest equals the repo file.

### Pre-flights that were run because the file asserts something

- **`0295`** — `alerts` held **0** rows and **0** would-be duplicate open keys,
  so the new partial unique index could not fail on existing data. Postgres
  **17.6**, so `NULLS NOT DISTINCT` is available; without it the ref-less
  alerts, the most repetitive kind, would never have collided.
- **`0296`** — the verify inserts an expense using
  `expense_categories … limit 1` for the first company, and that company has
  **no expense categories at all** (22 exist, all on other companies), so
  `category_id` would be NULL. Dry-run in a rolled-back subtransaction:
  the insert **succeeds** — `category_id` is nullable and the FK permits NULL.
  The same fixture's `bank_accounts … limit 1` picks a bank belonging to a
  **different company**, and the journal trigger accepted that too. Both
  observations are about the fixture, not the control; recorded because the
  next person to reuse this fixture should know it is company-blind.
- **`0297`** — the file's step 1 asserts that **no** active or on-leave
  employee currently carries a vetting failure. Computed on production with
  the migration's own predicate before applying: **0 of 756**. So the wiring
  lands quiet, which is the entire argument of the split.
- **`0299`** — `ledger_checks()` already returned **21** rows and the uninvoked
  view arm was exactly **14**, both of which the file asserts; and the regexp
  that rewrites the inline `tb` CTE was confirmed to match production's
  `ledger_checks_base` before the surgery ran.

### `0298`'s step 0, repeated on production

The question is whether the old `else 'left'` arm ever fabricated a
resignation. On production:

```
separated employees (left, fired, terminated, absconded)      388
… with no exit date, no last working day,
  no termination date and no separation reason                  0
```

**None.** 388 separated rows, every one carrying separation evidence. The
defect never fired on the database where a fabricated separation would matter,
and it is now closed while that is still true.

### One number that looked like residue and was not

After `0297`, `employees where blacklisted` reads **1**. It is EMP-0065,
`lifecycle_state = 'fired'`, created and last updated **2026-08-25** — a
pre-existing seed, not the probe. The probe's blacklisted employee is
`active`, and step 1 would have refused had an active blacklisted row existed.
Checked rather than assumed, because a residue check that reports a number
without identifying the row is a check that reports its own input.

### Ledger suite on production after `0299`

21 checks, **5 failing**, all pre-existing:

| check | expected | actual |
|---|---|---|
| `bank_accounts_equal_transaction_deltas` | -753,800.00 | -1,553,800.00 |
| `bank_control_equals_bank_accounts` | 5,956,301.00 | 7,044,768.00 |
| `bank_per_account_gl_equals_operational` | 0 | 3 |
| `every_control_is_invoked` | 0 | 17 |
| `no_negative_custodian_balance` | 0 | 2 |

`trial_balance_debits_equal_credits` **passes**, and now passes by reading the
view rather than by recomputing it.

## Block 6 — `0300`–`0302`, atomic, plus the restore (`0318`)

| file | digest | result |
|---|---|---|
| `0300_notification_deliveries` | `e3a90300a601669b99d6db93df526fd8` | delivery log + `alert_delivery_gaps()`, wired as check 21 |
| `0301_schedule_ledger_checks` | `3386a5c547ae78542d81dbce9130a71c` | `ledger-checks-daily` at 05:00, `in_app` channel |
| `0302_canary_has_one_number` | `9cbf45ff485efd139436e3a798ceb960` | the expected count collapses to one value |
| `0318_restore_the_two_unwired_checks` | `d8f59f9ed6c8e4df0abb31307c87c55b` | checks 22 and 23 restored; canary → 23 |

Every digest equals the repo file. Gaps **0** throughout.

### The block is atomic because `0300` breaks the canary and `0302` fixes it

Measured on production between the two, exactly as the files predict:
after `0300` the suite returned 22 rows with `checks_evaluated` **red** —
expected 21, actual 21, difference 1. The number lived in three places and the
bump moved one of them. After `0302` the canary is green on **all four
companies**, and the number is written once.

Stopping between `0300`/`0301` and `0302` would have left a scheduled 05:00 job
whose first act every morning was to raise a permanent alert about a check that
was fine.

### The schedule

```
ledger-checks-daily | 0 5 * * * | select public.run_scheduled_ledger_checks() | active
```

`ledger_checks` is no longer uninvoked — the deployment's largest single
finding, closed. The runner is kept out of `uninvoked_controls()` only by the
cron row, so deleting the schedule turns `every_control_is_invoked` red through
a path independent of the delivery-recency check.

### `alert_delivery_is_healthy` is red on all four companies, and should be

| company | gaps |
|---|---|
| GUARDS AND GUIDES (PVT) LTD | 2 — never delivered (email) **and** never run (in_app) |
| guards n guides | 1 — never run |
| SANDBOX TESTING ORG | 1 — never run |
| Sandboxx | 1 — never run |

The `in_app` arm clears at the first 05:00 run. The email arm stays red for
GUARDS AND GUIDES until a digest actually reaches Resend, which is the true
state of that path today.

### Why `uninvoked_controls()` missed the two restored checks

Its function arm matches names against eighteen substrings
(`gap|check|drift|residue|…`) or, for set-returning functions, a
`_rows|_balances|_held_|_review` suffix.

- `total_due_read_as_a_balance` — `a_balance`, not `_balances`. No match.
- `withholding_written_after_cutover` — no token at all. No match.

Both are named **after the condition they detect** rather than after the word
"check", which is better naming and precisely what a name-shaped predicate
cannot see. Third time a detector's own predicate has been the defect, after
`0288b` (comments counted as callers) and `0290` (guard names credited to
comments).

**Should the predicate be widened? Measured first, and the answer is no.**
Dropping the name test for set-returning functions with no caller would add
**20** entries on `crm-design`, and they are almost entirely application-facing
report RPCs — `partner_ledger`, `attendance_payroll`, `client_service_report`,
`payroll_cost_by_client`, `regional_pl` and thirteen more — none of which this
check can see being called from `src/`. That is an eighteen-entry exempt map of
non-problems, which is §9.11 and the reason `0296` declined to wire
`check_deploy_guard`. Adding the two literal names is worse: it fixes these two
and teaches nothing, because the next detector will also be named after its own
condition.

What closes the class is process, not a better substring:

1. a migration that adds a detector wires it in the **same** migration, and
   since `0302` the canary's expected count is one number, so forgetting to
   bump it goes red immediately;
2. a migration that **restates** `ledger_checks` must be replayed against the
   current definition — which is why `0289`/`0299`/`0300`/`0302`/`0318` all do
   surgery instead.

`0318` asserts the finding rather than narrating it: if a later migration ever
widens the predicate to match either name, `0318` fails on replay and the
argument gets re-read.

### The restore is proved by stubbing, not by its zeros

Both checks read 0, which is the state they were in when they were lost — so
zero proves nothing on its own. Each detector was stubbed to report one row and
the suite required to go red, then restored and required green, with the
restore executed **before** the verdict so a failure cannot leave a stub
behind. `tenant_guard_gaps()` is asserted afterwards, because the stub of
`withholding_written_after_cutover` deliberately dropped `0316b`'s guard.

## Blocks 7, 8 and 9 — `0303`–`0307`, `0310`, `0280`, `0311`

| file | digest | result |
|---|---|---|
| `0303_profit_allocation_review_takes_a_company` | `63b2617a6ab5c6e7cdcc92a2ff309f0f` | the review is callable per company |
| `0304_wire_four_controls` | `fd036f5fb701b8dd5914b1930bfc8ead` | four arms wired, canary 23 → 27 |
| `0305_tenant_guard_sees_through_the_helper` | `5cc7d509367b2474ee6c916ff174c6c8` | gaps 3 → 0 |
| `0306_vetting_dashboard_measures_progress` | `dd3454474f05b3fdace63542d8116d87` | eight additive counters |
| `0307_vetting_dashboard_has_a_reader` | `5a1e54cab8dbde6dcdf27f5b53742b39` | uninvoked 12 → 11 |
| `0310_period_lock_refuses_and_is_observed` | `14a00d37cc5734acb8379630f80ea2b0` | lock stops failing open, canary 27 → 28 |
| `0280_drop_treasury_cash_opening_columns` | `4f76cdb74c911384941af116e61478fe` | two dead columns dropped |
| `0311_drop_auto_zero_columns` | `ca67553242e4cd053f107c41c3755b97` | two dead columns dropped |

Every digest equals the repo file. The suite is **29 rows = 28 checks + canary**,
canary green on all four companies, `tenant_guard_gaps()` **0**,
`uninvoked_controls()` **11**.

### `0304` and `0310` had to be edited, and the reason is `0318`

Both were written when the suite had 21 and 25 real checks, and both moved the
canary from a **literal** to a **literal**. `0318` landed between writing and
deployment, so on `crm-design` the number was 23 by the time `0304` ran. Each
guard would have aborted correctly and loudly — `the canary is not 21` — which
is the right failure, in the wrong place: mid-block, on production, on a fact
about a database that no longer existed.

Both now **read the current number and add their own delta**: `+4` for `0304`,
`+1` for `0310`. The delta is the migration's property; the base is a reading,
which is where a reading belongs (§9.14). Their row-count assertions changed
the same way — `v_rows = expected + 1` rather than a literal 26 or 27.

Editing an applied migration creates drift, so **both were re-applied to
`crm-design-dev`** (old row deleted, file re-applied) before going to
production. Dev and prod now hold one row each, digest-identical to the file:
`fd036f5f…` and `14a00d37…` on both databases.

### `0303`'s before-state, measured on production

`profit_allocation_review(company, 2026-08-01)` raised
`23502 No partner remuneration basis configured` on production before the
migration — the exact symptom the header describes. All four companies **do**
have a basis, which confirms the header's own correction: the NULL tenant was
the whole cause, not a missing configuration.

After: it runs for every company, on a connection with no JWT, exactly as
`pg_cron` will call it.

### `0304`'s four arms, pre-flighted against production

| arm | production reading |
|---|---|
| `cash_forecast_clears_the_floor` | breach on **SANDBOX TESTING ORG at 2026-09-07**, null on the other three |
| `cash_control_has_no_direct_postings` | 0 on all four |
| `cash_entitlements_equal_pool` | 0 on all four; only SANDBOX has entitlements (3) |
| `client_cost_has_an_invoice` | 0 on all four |

The forecast arm's "not uniformly green" assertion holds on production for the
same company it holds for on dev, on a different date — which is what an arm
that reads the world rather than a literal looks like.

### `0305` cleared a gap it did not create

`0303`'s three new `p_company_id` parameters are guarded through
`resolve_company_scope`, and `tenant_guard_covered()` matched only the two
`assert_*` spellings — so `tenant_guard_gaps()` read **3** between `0304` and
`0305`. Teaching the detector the one indirection, rather than adding three
exempt-list rows, is the difference between fixing a detector and silencing it.

### `0310` — what was dropped and what was measured

`accounting_periods` is **empty on production**, so no month is closed and the
fail-open branch had nothing to fail open on. The lock is now closed anyway,
and `closed_period_intrusions()` is check 28.

### The two drops

`treasury.cash_opening_balance` read **0.00** on both rows and
`cash_opening_locked` **false** — nothing was lost. `bank_accounts` came
through `0311` byte-identical in both directions.

### Ledger suite on production at the end of the deployment

| check | companies | note |
|---|---|---|
| `alert_delivery_is_healthy` | all 4 | never run yet; clears at the first 05:00 job |
| `every_control_is_invoked` | all 4 | 11 remaining, down from 20 |
| `no_gate_mode_in_attendance_status` | GUARDS AND GUIDES | 24, pre-existing |
| `bank_accounts_equal_transaction_deltas` | SANDBOX | pre-existing |
| `bank_control_equals_bank_accounts` | SANDBOX | pre-existing |
| `bank_per_account_gl_equals_operational` | SANDBOX | 3, pre-existing |
| `cash_forecast_clears_the_floor` | SANDBOX | breach 2026-09-07, newly visible |
| `no_negative_custodian_balance` | SANDBOX | 2, pre-existing |

`0286` through `0318` are recorded on production with no gaps in the sequence.

---

## 0319 — the ledger views carry the period (dev applied, production pending)

### Why it exists

The three ledger screens have to show the period, filter by client and partner,
and say whether an entry has been reversed. `trial_balance` had no period
dimension and `journal_lines_regional` carried none of the counterparties. Every
one of those questions would otherwise have been answered in the browser, which
is the defect `0299` removed from the check suite.

### The reduction, proved rather than asserted

`ledger_checks_base` is the **only** reader of `trial_balance` —
`post_opening_balances` mentions the phrase in prose only, and `pg_depend`
reports no dependent view. It reads `sum(t.total_debit)` and
`sum(t.total_credit)` **by name**, filtered by company. Adding a column to a
`GROUP BY` splits groups and never changes a sum taken over all of them, so the
0299 collapse survives.

The migration does not stop at saying so. It writes the old view's figures to a
temp table at the old grain, replaces the view, re-aggregates the new view back
to that grain, and full-outer-joins the two, refusing to commit on any
difference in debit, credit or net. It also refuses to commit if the
before-image is **empty** — a proof over no rows proves nothing (§9.6).

### Preconditions read before applying

| reading | production | dev |
|---|---|---|
| `posting_period` null | 0 | 0 |
| disagreements with `date_trunc('month', entry_date)` | 0 | 0 |
| `trial_balance` = raw `journal_lines` sums | exact, all 4 companies | — |
| view definitions | identical md5 on both databases | identical |
| dependent views | none | none |

The null check is a **gate**; the `entry_date` agreement is recorded as a
`raise notice` and not a gate, because advance invoicing (§9.19) will
deliberately post revenue to a period other than the entry month, and the sums
are unchanged either way.

### Dev result

| | before | after |
|---|---|---|
| `trial_balance` rows | 61 | 111 (5 periods) |
| `journal_lines_regional` rows | 1302 | 1302 |
| `trial_balance_debits_equal_credits` | 37,930,889.48 = | 37,930,889.48 = |
| `checks_evaluated` | 26 | 26 |

Digest `2dc4fedcb2bebd57f20decb3d10208ed`, recorded row identical to the file.

### Production

**Not applied.** The instruction to build named 0319 and its reasons but did not
name the project or its ref, which is the bar `CLAUDE.md` sets for a prod write.
Awaiting that authorisation.

---

## The future-dated entry

Reported before building, because a source document that can be dated ahead is
not something the period lock can help with.

| | |
|---|---|
| entry | `81e38a78-bde2-4360-bd15-1d5d1a2b404c` |
| entry date | **2026-09-15** (13 days ahead of the reading on 2026-09-02) |
| posting period | 2026-09-01 |
| created | 2026-08-31 05:12 UTC |
| company | SANDBOX TESTING ORG |
| source | `invoice_payments` / `59bd7029-c6a0-4a95-ae60-4dd86fc92cdb` |
| what it posts | Dr 1010 Bank Accounts 150,000 / Cr 1100 Accounts Receivable 150,000, client Delta Port Authority, invoice STS-26-DPA-07 (service month July 2026) |

It is the **only** entry on production with `entry_date > current_date`, it is
on a sandbox company, and it was created two weeks before the date it claims —
so it is a fixture, not an operator error in the live company.

The general point survives being a fixture: `invoice_payments.payment_date` is
operator-supplied and unbounded above, and the journal takes `entry_date` from
it. The entry therefore lands in a period that has not been reached, let alone
opened or closed, and a period lock is powerless against it because the lock
tests whether a period is *closed*, not whether it is in the *future*. The two
open questions — whether a future payment date should be refused outright, and
whether posting into an unreached period should be — are policy, so they are
recorded here rather than answered.

## Flag, logged not chased

Dev's recorded digests differ from the repo for several files in the 0300–0312
range. The repo↔dev direction of `scripts/check-migrations.mjs` has findings
waiting.

---

## 0319 on production

Applied. Digest `2dc4fedcb2bebd57f20decb3d10208ed`, identical to the file and to
the dev row. `checks_evaluated` 28 on all four companies;
`trial_balance_debits_equal_credits` still exactly **37,678,124.61** on SANDBOX
TESTING ORG, matching the pre-flight baseline taken before the view was
touched.

## 0320 — the trial balance answers at every grain (dev applied, production pending)

`trial_balance_for(p_company_id, p_period, p_branch_id)`. Two nullable
parameters answer all four combinations the screen offers — a period or all
periods, a region or all regions — from one body that reads `trial_balance` and
sums its columns. The browser-side fold is gone from both the Trial Balance
screen and the Chart of Accounts.

**Deliberately SECURITY INVOKER.** The view is `security_invoker`, so the
caller's RLS is the tenant boundary. A DEFINER function would have to
re-implement that boundary and would appear in `tenant_guard_gaps()` as a uuid
parameter needing a guard that exists only because the function removed the one
RLS already gave it. The migration asserts `prosecdef = false` rather than
trusting nobody adds it later.

Proof: the four grains are each full-outer-joined against the view aggregated by
hand to the same grain, on debit, credit and net. Then two guards the
comparisons themselves cannot supply — the narrowest grain must return rows (four
empty sets agree perfectly, §9.6) and a null `p_company_id` must return **zero**
rows, because "`company_id = null` is null-safe by construction" is exactly the
kind of claim that stops being true when someone rewrites the predicate. The
fixture picks the company with the most ledger rows, not the first company —
that is the 0296 lesson.

Dev: digest `0a3706aba68741d6e802dc2c063ec15a`, `tenant_guard_gaps()` **0**,
`uninvoked_controls()` **11** — unchanged, so the new function did not introduce
a blind spot in either detector.

**Production: not applied.** The 0319 authorisation was "this migration only."

---

## Logged for after the screens: the two date rules

### Survey — every date-bearing source, upper bound

**No table in the finance path constrains any date column above.** Not one
`check (… <= current_date)` exists.

| column | future rows | total | max |
|---|---|---|---|
| `invoice_payments.payment_date` | **1** | 8 | 2026-09-15 |
| `invoices.invoice_date` | **2** | 9 | 2026-10-01 |
| `journal_entries.entry_date` | **1** | 427 | 2026-09-15 |
| `expenses.expense_date` | 0 | 6 | 2026-09-01 |
| `expenses.due_date` | 0 | 6 | — |
| `advances.advance_date` | 0 | 1 | 2026-07-28 |
| `cheques.cheque_date` | 0 | 3 | 2026-08-28 |
| `custody_transfers.date` | 0 | 1 | 2026-08-28 |
| `partner_account_entries.date` | 0 | 0 | — |
| `payslips.period_month` | 0 | 48 | 2026-07-01 |
| `payroll_runs.period_month` | 0 | 0 | — |
| `opening_balance_batches.as_of_date` | 0 | 1 | 2026-08-31 |

They are all unbounded above, so they are decided together rather than one at a
time — but two of them are **not** the same case as `payment_date`, and that
difference is the point:

- **`cheques.cheque_date` must stay unbounded.** A post-dated cheque is an
  ordinary instrument, and the date on it is genuinely in the future. `0269`
  already moved the clearing posting to `cleared_at` for exactly this reason, so
  a forward `cheque_date` no longer drags a journal entry with it.
- **`expenses.due_date` must stay unbounded.** A payable due next month is the
  normal case; it is a schedule, not a record of something that happened.
- **`payslips.period_month` / `payroll_runs.period_month`** are month labels, not
  event dates; the natural bound is the current month, not the current day.

So the rule is not "no future dates". It is: **a column that records something
that has happened is bounded; a column that records something scheduled is
not.** `payment_date`, `expense_date`, `advance_date`, `custody_transfers.date`
and `partner_account_entries.date` are the first kind.

### `invoices.invoice_date` — future, and correctly so

The two future invoices are fixtures (`FIX-SEP-COINCIDE` 2026-09-30,
`FIX-SEP-CROSS` 2026-10-01, both SANDBOX, both created 2026-08-31). Their
journal entries post at **2026-09-01** — the service month, not the invoice
date. **A4 already redirects them**, so an invoice dated ahead does not produce
an entry dated ahead. `run_auto_invoices` sets `invoice_date` to
`date_trunc('month', p_run_date) - interval '1 month'` — the previous month,
never forward.

### Does anything legitimately post forward? No.

`run_auto_invoices` dates backward. `post_payslip_accrual` and
`trueup_bonus_provision` are period-driven. Invoices post at `period_start`.
Cheques post at `cleared_at`. The **only** mechanism that currently puts a
future `entry_date` into the journal is `invoice_payments.payment_date` flowing
straight through — which is the single future entry on production.

So the second rule can be absolute: **no entry may post into a period later than
the current one**, added to `enforce_period_lock` alongside the closed-period
half, with the same `is_maintenance_session()` bypass and the same `P0001`
errcode. The lock's existing shape supports it directly — it already reads
`v_new_date` and `v_company` off the row and raises on
`is_period_closed(v_company, v_new_date)`; the future test sits beside that
call, not inside `is_period_closed`, because "closed" and "not yet reached" are
different facts and one predicate answering both is how a detector's own
predicate becomes the defect.

Both are **logged, not built** — they come after the screens.

---

## Branch change, 2026-09-02

`main` is the only branch. Local `main` was 84 commits behind and was
fast-forwarded to `origin/main`; local `dev` (tip `4c952dc`, identical to
`origin/main`) was deleted after confirming `origin/main..origin/dev` was
empty, so nothing was lost. `origin/dev` still exists on the remote and was
**not** deleted from here — a remote branch deletion is not a local decision.

Two things share the name and are not the same thing, so CLAUDE.md now says so
at the top: the git branch `dev` is gone; the Supabase project `crm-design-dev`
(`wlyhbvunvdsropqzlpwx`) is not, and the dev-first discipline is unchanged.

`scripts/check-migrations.mjs` needed **no change**. It has no git-branch logic
at all — its repo side reads `supabase/migrations/` off the working tree, and
every `dev` in that file names the database environment. Renaming them would
have broken the checker to satisfy a change that did not touch it.

## 0320 on production

Digest `0a3706aba68741d6e802dc2c063ec15a`, identical to the file and the dev
row. `prosecdef` false, `tenant_guard_gaps()` 0, `uninvoked_controls()` 11,
`trial_balance_for(SANDBOX)` returns 28 accounts, `trial_balance_for(null)`
returns 0.

## 0321 / 0322 — the two date rules (dev applied, production pending)

`0321` digest `f07086390d767ffb7b7c7ce73e9d4817`, `0322` digest
`2beb92401d9f742a3ac94808f48e9bad`. Dev journal unchanged at 439 entries /
1334 lines across both.

### What 0322 had to correct in the instruction

`enforce_period_lock` is attached to **seven** tables, including
`invoices(invoice_date)` and `cheques(cheque_date)`. An unscoped future test
inside it would have refused exactly the two columns 0321 established must stay
unbounded. The rule is about entries, so the test is scoped to
`tg_table_name = 'journal_entries'` and reads **`posting_period`** — the column
that means what the rule means — not `date_trunc` on `entry_date`, which is a
proxy for it and is allowed to diverge by policy under §9.19.

The two rules are complementary and neither substitutes for the other: the
entry that prompted this (2026-09-15, current period) is refused by **0321** at
source, not by 0322.

### A defect in the first 0321, and the rule it produced

The first draft's proof did the accepted-case probe for real and then
"restored" the old date. That is not a restore. Changing a source date makes
the app reverse and repost its journal entry, and changing it back reverses and
reposts again: it left **16 entries and 32 lines** of self-cancelling noise on
dev (439/1334, up from 423/1302). Net balances were unchanged and
debits-equal-credits still passed, which is precisely why nothing would have
flagged it.

Those 16 entries were **not deleted**. They are a faithful record of four date
edits and four undos; deleting audit rows to tidy up my own mistake is the
instinct this project distrusts. They are logged here instead, and they widen
the already-recorded dev↔prod divergence.

**The rule: a probe that writes must unwind through the transaction, not
through a compensating write. A compensating write is another event, and the
ledger records it.** Every probe in both migrations now ends in a deliberate
`raise` that rolls its subtransaction back.

### Also corrected before it shipped

- The refusal message read "A expense records…". Reworded to "It records…".
- A `check (d <= current_date)` constraint was **probed on dev, and Postgres
  accepted it** — I had predicted it would be refused as non-immutable and was
  wrong. The reasons for a trigger are different and still hold: ADD CONSTRAINT
  validates existing rows and one row on each database violates it; a CHECK
  cannot distinguish setting the date from editing an unrelated field; and a
  trigger honours `is_maintenance_session()`.

### Exemptions confirmed empirically on dev, after the triggers were live

`cheques.cheque_date + 45`, `invoices.invoice_date + 45` and
`payslips.period_month + 2 months` were each attempted and each **accepted**.
`expenses.expense_date + 5` was refused with the 0321 message.
A journal entry posting to December 2026 was refused with the 0322 message.

---

## 0321 and 0322 on production

| migration | digest | matches |
|---|---|---|
| `0321_a_record_of_the_past_is_not_dated_ahead` | `f07086390d767ffb7b7c7ce73e9d4817` | file and dev row |
| `0322_the_period_lock_sees_a_period_not_yet_reached` | `2beb92401d9f742a3ac94808f48e9bad` | file and dev row |

Production journal **unchanged at 427 entries / 1304 lines** across both
applies, and no `0322 probe` row exists. That is the direct evidence the proof
correction worked: the uncorrected 0321 moved dev from 423/1302 to 439/1334,
and the corrected one moved production not at all.

`tenant_guard_gaps()` 0. `checks_evaluated` 28 on all four companies. Five
`enforce_not_future_date` triggers attached. Every source max date unchanged,
including the exempt `invoices.invoice_date` at 2026-10-01.

### The two unattributed dev reds — isolated to dev's data

Re-checked on production with 0321 and 0322 applied, as instructed.

| check | production (all 4 companies) | dev (SANDBOX TESTING ORG) |
|---|---|---|
| `ar_control_equals_open_invoices` | **green** — SANDBOX 2,908,877.00 = 2,908,877.00 | **red** — 3,079,999.00 vs 3,081,999.00 |
| `employee_advances_control_not_in_client_ar` | **green** — 0.00 everywhere | **red** — 2,000.00, expected 0.00 |

Same code, same migrations, opposite results: **the cause is dev's data, not the
code.**

And the two reds are one fact, not two. The AR shortfall is **2,000.00** and the
misfiled employee-advance balance is **2,000.00** — the same amount seen from
two directions. One dev-only advance of 2,000.00 is sitting where a client
receivable is counted. Recorded here rather than chased; it does not exist on
production.

---

## Advance invoicing (§9.19) — three findings before building

### 1. It collides with 0322, which was ruled absolute one message earlier

The ruled shape posts `Dr Unearned Revenue / Cr Revenue` **at period_start**. For
an invoice raised in September for October service, that entry is dated
2026-10-01 — a period that has not been reached. **0322 refuses exactly that**,
and it was ruled absolute on the evidence then available: nothing legitimately
posted forward. Advance invoicing is the first thing that does.

Either the recognition entry is written when the month arrives (0322 stays
absolute), or 0322 gains an exemption. Recommended: **a recognition run**. At
`invoice_date` post only `Dr AR / Cr Unearned Revenue`; a scheduled job posts
`Dr Unearned Revenue / Cr Revenue` when the service month opens. That is how
deferred revenue normally works, it keeps 0322 absolute, and the ledger never
holds an entry for a month that has not happened.

### 2. "AR at invoice_date" would move every invoice that exists

Measured on production: **all 9 invoices are arrears** (`invoice_date >
period_start`), none are advance, none have a null `period_start`. Today
`post_invoice_journal` posts AR, revenue and sales tax together at
`coalesce(period_start, invoice_date)` — so AR already posts at period_start,
not invoice_date.

Applying "AR posts at invoice_date" generally would re-date the AR leg of every
existing invoice, and the interval account would carry a **debit** balance in a
liability — that is unbilled/accrued revenue, an asset, not unearned revenue,
and no such account was authorised.

Read narrowly — the two-entry treatment applies only when `invoice_date <
period_start` — arrears is untouched and nothing existing moves. That is the
reading the worked example supports, and it is what will be built unless
corrected.

### 3. `run_auto_invoices` never sets `period_start`

It writes `invoice_date := v_period` and no `period_start` at all; the column is
nullable with no default and no trigger fills it. So for an advance client it
produces `invoice_date = the service month's first day` and `period_start =
null` — **not** `invoice_date < period_start`. The advance branch would never
fire for an auto-issued invoice, and any check keyed on `period_start` is inert
for exactly the invoices `advance_payment` governs.

`advance_payment` is **false for all 94 clients** on production, so nothing is
broken today, but the flag cannot produce the ruled shape as the function
stands.

---

## Production cleanup — census, read-only

### Companies

| company | employees | clients | invoices | payslips | entries | banks | profiles | contracts |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| GUARDS AND GUIDES (PVT) LTD | 553 | 43 | 0 | 0 | **0** | 0 | 4 | 30 |
| guards n guides | 527 | 43 | 0 | 0 | 0 | 0 | **0** | 30 |
| SANDBOX TESTING ORG | 69 | 8 | 9 | 48 | **427** | 9 | 1 | 8 |
| Sandboxx | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |

Every journal entry on production belongs to SANDBOX. `guards n guides` is a
527-employee duplicate of GGS with **no profile attached**, so nobody can log
into it.

### Users

| email | role | company | last sign-in |
|---|---|---|---|
| techxserve@gmail.com | super_super_admin | — | 2026-09-02 |
| guardsandguides.ops@outlook.com | hr | GGS | 2026-09-01 |
| info@guardsandguides.com | super_admin | GGS | 2026-09-01 |
| nosherwan29@gmail.com | hr | GGS | 2026-09-01 |
| tahaarshad004@gmail.com | hr | GGS | 2026-08-31 |
| sa@sandbox.test | super_admin | SANDBOX | 2026-08-31 |
| muzammil@techxserve.com | super_admin | Sandboxx | 2026-08-08 |

Seven accounts, all confirmed, none banned.

### Does anything depend on SANDBOX existing?

**No database object does** — no function or view references the company by name
or by its `5eed0000-…` id.

**Six test suites do**, and four abort loudly without it:

| suite | dependency |
|---|---|
| `fixtures_period_split.sql` | `raise exception 'SANDBOX TESTING ORG not found — this fixture is sandbox-only'` |
| `period_lock.sql` | needs the company **and a profile in it** to act as |
| `repost_sets.sql` | needs the company **and a profile in it** |
| `attendance_status.sql` | selects it by name — "the only company with a …" |
| `ledger_foundation.sql` | hardcodes `5eed0000-0000-4000-8000-000000000001` |
| `opening_gate_and_partner_audit.sql` | hardcodes the id, and assumes SANDBOX owns the only opening batch |

The dependency is on **a SANDBOX in whichever database the suite runs against**,
and dev has one. Removing it from production costs nothing *provided the suites
are never run against production* — which the write discipline already forbids.
Two of them additionally need `sa@sandbox.test`, so disabling that account and
removing the company are one decision, not two.

### The archive flag does not exist yet

`companies` has `active boolean not null default true` — but **0 of 272 RLS
policies reference it**, and `current_company_id()` reads
`coalesce(view_as_company, company_id)` without consulting it. Setting
`active = false` on `guards n guides` today hides it from nothing. An
RLS-enforced archive flag has to be built before it can be relied on.

---

## 0323 / 0324 — advance invoicing (dev applied, production pending)

| migration | digest | dev |
|---|---|---|
| `0323_advance_invoicing_defers_revenue` | `084bbe3c8c70159dc20c319f98d55c82` | applied |
| `0324_revenue_belongs_to_the_service_month` | `714a966bd787caa7cdd4cf2bc3d9ee42` | applied |

Dev after both: journal unchanged at **439 entries / 1334 lines** (every probe
unwound), `tenant_guard_gaps()` **0**, `uninvoked_controls()` **11**, canary
26 → **27**, one value across all four companies, `revenue_outside_service_month`
**0** rows.

### What 0323 does, and the two things it deliberately does not

`ensure_unearned_revenue_account` (2700, liability, credit), backfilled to all
four companies and created lazily thereafter. `post_invoice_journal` gains a
NARROW branch: only when `invoice_date < period_start` does it post
`Dr AR / Cr Unearned Revenue / Cr Sales Tax` at invoice_date. Arrears and
same-day are byte-identical to before, which the proof requires.

**It does not write the recognition entry at invoice time.** It cannot: 0322
refuses an entry posting into a period that has not been reached, and an October
entry written in September is exactly that. `recognise_advance_revenue(company,
period)` posts `Dr Unearned Revenue / Cr Revenue` when the month arrives,
refuses a future period by name, and is idempotent — the deferral carries no
revenue line, so a revenue line against the invoice IS the marker, with no flag
column anyone has to remember to set. The proof runs it twice and requires 1
then 0.

**It does not touch `run_auto_invoices`, and that is a finding.** The anchor
assertion refused rather than guessing, because dev and production do not have
the same function body:

```
production  99fc7c74281ed31d3fe7b8f5506cc516   2849 chars, uses v_period
dev         8662cf340ad824e8c501ade31f0434b5   2546 chars, no v_period
```

Dev is missing 0316's rewrite. A patch anchored on one cannot be rehearsed on
the other, and widening the anchor to accept both is teaching an assertion to
accept what it finds. The `period_start` change waits for the two databases to
agree — this is the logged repo↔dev divergence arriving as a concrete blocker
rather than a note.

Worth stating separately: **auto-invoicing does not produce advance-shaped
invoices anyway.** For an advance client the function bills the first day of the
service month, so `invoice_date = period_start`. A manual invoice with a future
`period_start` is what 0323 is for.

### 0324, and a defect of mine that its own subject caught

The detector nets `credit - debit` per period rather than counting entries with
revenue lines — an invoice edit reverses and reposts, so counting entries would
score the reversal as a second recognition. Netting makes the pair cancel,
because that is what it is. A null `period_start` with revenue posted is
reported, not defaulted to `invoice_date`: §9.18.

**The first draft wrote the tenant guard as a comment on a `language sql` body,
and `tenant_guard_gaps()` went from 0 to 1** — the same defect 0316 shipped,
caught by the same detector. Measured rather than assumed: all three sibling
detectors `ledger_checks` reads (`closed_period_intrusions`,
`alert_delivery_gaps`, `negative_custodian_balances`) are SECURITY DEFINER **and
call `assert_same_company`**. The function is now plpgsql with a real call, and
the proof asserts `tenant_guard_gaps() = 0` — nothing else in it would have
noticed, because the check was green and the detector worked while the boundary
was missing.

---

## 0323 / 0324 on production

| migration | digest | matches |
|---|---|---|
| `0323_advance_invoicing_defers_revenue` | `084bbe3c8c70159dc20c319f98d55c82` | file and dev row |
| `0324_revenue_belongs_to_the_service_month` | `714a966bd787caa7cdd4cf2bc3d9ee42` | file and dev row |

Journal unchanged at **427 entries / 1304 lines** — every probe unwound.
`tenant_guard_gaps()` **0**, `uninvoked_controls()` **11**, four
`unearned_revenue` accounts, `revenue_outside_service_month` **0** rows, canary
28 → **29**, green on all four companies. No probe residue.

---

## The repo↔dev backlog, measured (0230–0324)

100 repo files in range, 84 dev rows.

### Missing on dev — 16

`0230`, `0231`, `0231b`, `0232`, `0233`, `0234`, `0235`, `0236`, `0285`,
**`0313`, `0314`, `0315`, `0316`, `0316b`, `0317`, `0318`**.

The bolded seven are the block that explains everything observed so far: dev's
canary was 26 while production's was 28 because `0318` (which restored two
checks) never ran there, and dev's `run_auto_invoices` is the pre-`0316` body.

### Digest differs — 18

`0265`, `0292`–`0303`, `0305`–`0308`, `0311`. Recorded SQL on dev does not match
the repo file for any of these.

### On dev with no repo file — 0

The serious direction is clean: nothing has run against dev that the repo does
not describe.

---

## Re-applying 0316 to dev was approved and I did NOT do it

**0316 restates `ledger_checks` wholesale.** Its body rebuilds `real_checks`
from `ledger_checks_base` plus an explicit list of nine checks:

```
create or replace function public.ledger_checks(p_company_id uuid)
...
  with real_checks as (
    select ... from public.ledger_checks_base(p_company_id) b
     where b.check_name <> 'checks_evaluated'
    union all  -- nine checks listed by hand
```

Dev's `ledger_checks` currently returns **28 rows — 27 checks plus the canary**,
because `0304`, `0310`, `0312` and `0324` amended it after `0316` was written.
Applying `0316` to dev now would replace a 27-check function with a 9-check one
and silently drop everything added since — including
`revenue_recognised_in_service_month`, added minutes earlier.

That is precisely the defect `0286` and `0288` shipped and `0318` had to repair.
The approval was given before this was known; the literal action would cause the
exact failure the instruction elsewhere forbids, so it was not taken.

### The proposed substitute

`run_auto_invoices` is safe to restate where `ledger_checks` is not, and the
difference is the point: `ledger_checks` accumulates surgery from many
migrations, so no single file holds its true text, while `run_auto_invoices` has
exactly one author (`0316`) whose full text is in the repo.

**0325** would state the agreed `run_auto_invoices` body outright, guarded by a
precondition asserting the body it replaces is one of the two known digests —
`8662cf34…` (dev, pre-0316) or `99fc7c74…` (production, post-0316) — and
refusing anything else. On production that is a no-op it can prove; on dev it is
the reconciliation. **0326** then adds `period_start` by surgery against the
body both databases share.

Nothing applied. Awaiting confirmation of the substitute.

### The substitute was approved and is on dev (2026-09-02)

Both applied to `crm-design-dev` (`wlyhbvunvdsropqzlpwx`) only. Production has
neither; they need naming.

| File | Recorded digest = file | Effect |
|------|------------------------|--------|
| `0325_the_auto_invoice_generator_says_its_own_body` | `614fc82594f92d668a8f168ccc7a8304` | dev's `run_auto_invoices` replaced with the shared body |
| `0326_the_generator_states_the_month_it_bills_for` | `03a39552e07149cd853d1d79c7ac2029` | the generator writes `period_start` / `period_end` |

`run_auto_invoices` digests, measured at each step:

| | before 0325 | after 0325 | after 0326 |
|---|---|---|---|
| dev | `8662cf34…` (2546 b) | `99fc7c74…` | `13f91d69…` |
| production | `99fc7c74…` (2849 b) | *not applied* | *not applied* |

`99fc7c74…` is the digest production has held since `0316`, so `0325` on
production is a no-op that proves itself; `13f91d69…` is where both databases
land once `0326` follows.

**0325's proof runs the generator, it does not read it.** `0316`'s header
records why: the pre-`0316` body was *unrunnable* for any client with
auto-invoicing switched on, and every read of it looked fine. So a client is
planted with `auto_invoice_withholding = 999`, the generator is called, and the
invoice it raises is required to carry `withholding_tax = 0` — withholding
belongs to the receipt (A1). `next_invoice_number` computes `max+1` from the
invoices table rather than drawing on a sequence, so the whole probe unwinds
through the transaction and leaves nothing behind (`0321`).

**0326 is surgery, and that is not an inconsistency.** Before `0325`,
`run_auto_invoices` had one author and could be restated. After `0325` it has
two, so the rule that made `0325` safe is exactly the rule that makes `0326`
surgery. Its proof ends by asking `revenue_outside_service_month` whether it has
anything to say about an invoice the generator just raised: before `0326` it
would have reported "the invoice states no service month".

Dev after both: `ledger_checks` still **28 rows (27 checks + canary), canary
green on all four companies** — nothing dropped, which was the whole reason for
not re-applying `0316`. `tenant_guard_gaps()` **0**. Journal unchanged at **439
entries / 1334 lines**, invoices **9**, no probe residue.

The rule this produced is now in `CLAUDE.md` under *"A function edited by more
than one migration has no canonical file"* — the general form, because the next
function it applies to will not be `ledger_checks`.

### The repo↔dev backlog: read the shape, not the count

Range `0230`–`0326`. **102 repo files, 86 dev rows.**

**The direction that matters is clean: 0 rows on dev with no repo file.**
Nothing has ever run against dev that the repo does not describe. That is the
unrecoverable direction — a row with no file means SQL nobody can reproduce or
review — and it is empty.

The other 34 are all the same, recoverable thing: **dev is behind.**

**Missing on dev — 16.** Two blocks, not a scatter:

- `0230`, `0231`, `0231b`, `0232`–`0236` — the partner-remuneration block.
- `0285`
- `0313`, `0314`, `0315`, `0316`, `0316b`, `0317`, `0318`

The second block explains everything already observed. `0318` never ran on dev,
which is why dev's canary read 26 against production's 28. `0316` never ran,
which is why dev's `run_auto_invoices` was the pre-`0316` body — the blocker
`0325` has now cleared, without applying `0316`.

**Digest differs — 18.** `0265`, `0292`–`0303`, `0305`–`0308`, `0311`. Mostly
the 0300 block already logged: files edited after they were applied to dev, then
applied to production in their corrected form. Production's digests match the
files; dev's are the superseded text.

Not fixed, deliberately — one blocker cleared, the backlog measured, nothing
else touched.

### 0325 and 0326 on production (2026-09-02)

Applied to `crm-design` (`mmkfpnshxjcyijhuydgr`), named and approved, these two
only. Recorded digests equal the files and equal the dev rows:
`614fc82594f92d668a8f168ccc7a8304` and `03a39552e07149cd853d1d79c7ac2029`.

`0325` behaved on production exactly as designed: the precondition read
`99fc7c74…`, recognised it, and the restatement left the digest at `99fc7c74…`
— a no-op that proved itself rather than one asserted in a comment. `0326` then
moved both databases to the shared `13f91d69c78bc5e78dfdf63cedd5daee`.

Production after both: journal unchanged at **427 entries / 1304 lines**,
invoices **9**, no probe residue, `tenant_guard_gaps()` **0**,
`uninvoked_controls()` **11**, `ledger_checks` **30 rows (29 checks + canary),
canary green on all four companies**.

Reds are the pre-existing set, unchanged: `every_control_is_invoked` (11, the
`uninvoked_controls` backlog) on all four; `alert_delivery_is_healthy` and
`no_gate_mode_in_attendance_status` on GUARDS AND GUIDES; and SANDBOX TESTING
ORG's five, which are that company's own data.
`revenue_recognised_in_service_month` is green everywhere.

## Journal drill-down: the link was never the problem (2026-09-02)

The reported defect was "the link discards the id". It does not — the Journal
screen has always emitted `?focus=<source_id>`. **No destination read it.** Ten
links, zero readers.

Fixing that meant checking where each source document is actually rendered
rather than where it looked like it belonged, and **four of the ten routes were
pointing at screens that never had the record**:

| source_table | was | now | why |
|---|---|---|---|
| `cheques` | `/treasury` | `/accounting?tab=payables` | Treasury does not read `cheques` at all |
| `advances` | `/payroll` | `/expenses` | both load the table; Expenses is the one that lists them |
| `invoice_payments` | `/invoices` | *no link* | 18 of 22 receipts have no `invoice_id` |
| `bank_transfers` | `/treasury` | *no link* | nothing in `src/` reads the table |

Two sources were found that the map never had at all:

- **`payslips_disbursement` — 120 entries, the second largest source in the
  ledger — had no route.** Its `source_id` is the payslip's own id (verified on
  production, 120 of 120), so it now focuses the same payroll row as `payslips`.
- `ledger_correction_0219` (1 entry) is a migration correction with no document,
  and now says so.

`focusType` travels with the id because three destinations serve two source
tables each, and a bare uuid does not say which table it came from.

### Scrolling was never going to be enough

Every one of these screens filters by month, and most default to the current or
previous one. A link to a June expense from a September journal would have
scrolled to a row that was not rendered. Each destination now widens the filters
that could hide the row *first* — and where the period is not knowable from the
id (`payslips`, `partner_account_entries`), the record is read first to learn
its period, and the screen is moved to it.

### What genuinely cannot open a record, and why

`bank_transfers`, `ledger_correction_0219`, and `invoice_payments`. The third is
the one worth acting on: no screen lists receipts individually — Receivables
shows client totals, only the Excel export goes down to payments, and the one
place a payment row exists is the invoice edit dialog, which needs an
`invoice_id` that most receipts do not have. Closing it needs a receipts list,
which is a screen, not a link. Until then it says so instead of linking.

`src/app/lib/focus.ts` holds the shared mechanism so every screen marks a
focused row the same way.
