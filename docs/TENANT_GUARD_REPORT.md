# The tenant guard: what the audit actually found

Covers `0242`, `0242b`, `0242c`, `0243` and `supabase/tests/tenant_guard.sql`.
**Everything below is applied to `crm-design-dev` only.** Production still
carries the hole apart from `0240` and `0241`, which were applied there by named
approval.

---

## 1. The population was three times larger than first reported

The first pass filtered on *"the body never mentions `company_id`"* and read a
mention as evidence of a tenant check. It is not. `post_journal` mentions
`company_id` eleven times and never once compares it to the caller's.

Re-derived by what each function **checks**:

|  | count |
|---|---:|
| SECURITY DEFINER functions in `public` taking a uuid | 140 |
| …comparing it against `current_company_id()` / `is_ssa_unscoped()` | 2 |
| …checking some other authorisation (visibility, permission) | 4 |
| **…with no authorisation check of any kind** | **134** |

Split of the 138 unguarded:

| | takes an object id | takes `p_company_id` directly |
|---|---:|---:|
| **write** | 47 | **30** |
| read | 32 | 29 |

The right-hand column is the half that was missed and the more dangerous one.
**The caller names the tenant.** No id-guessing is required beyond one company
id: `post_journal`, `seed_chart_of_accounts`, `next_invoice_number`,
`fund_region`, `add_subscription_payment`, `run_ho_cost_allocation`.

The old list of 46 was also **over-inclusive by five**: `has_perm` and
`has_permission` take `text`, `regional_pl` takes a date, and `billing_summary`
takes nothing and is one of the two genuinely self-scoped functions.

---

## 2. Four functions the name/volatility/return-type heuristic misclassified

This is why `tenant_guard_gaps()` infers nothing and tests only whether the
function calls the guard.

| function | heuristic said | reading it says |
|---|---|---|
| `reassign_client_employee_codes` | read (VOLATILE, returns a count) | **write, and bulk.** Loops every `category = 'client'` employee of the client and calls `assign_employee_code`, which UPDATEs `employees.employee_code`, INSERTs `employee_code_history` and increments `company_counters`. **Not idempotent** — each call burns counter values and reissues codes. `employee_code` is the identifier on client-facing paperwork. |
| `check_deploy_guard` | read (named "check", returns `text[]`) | **write.** Calls `raise_alert`, which INSERTs into another company's alert feed. |
| `check_disbursement` | read (named "check", returns `text`) | **write.** Same `raise_alert` path on the `red` branch. |
| `assert_cheque_capacity` | write (VOLATILE, named "assert") | **read.** Only SELECTs and raises. Corrected *down*, and it is not harmless — see §3. |

The rule this establishes: **volatility and return type are both unreliable.**
What decides it is whether the body reaches a write, including indirectly
through `raise_alert`, `assign_employee_code` or `next_counter`.

---

## 3. Exception messages as an output channel

Nobody had audited error strings as a disclosure surface. Every `raise` in
`public` that interpolates a value was checked. Seven interpolate figures; three
are genuine cross-tenant leaks, and all three are now closed by the guard —
**because the guard is the first statement in the body**, before any select that
could raise.

| function | what the message disclosed |
|---|---|
| `assert_cheque_capacity` | `'Cheque capacity exceeded: linked items total PKR % > cheque amount PKR %'` — **two money figures** about another company's cheque, from a function that returns nothing. |
| `post_opening_balances` | `'opening trial balance does not balance: debits minus credits = %'` — another company's opening trial-balance difference. |
| `record_separation` | `'…this employee is marked present on %…'` — a date another company's employee worked. |

Not leaks, recorded so nobody re-derives them: `post_journal` and
`assert_journal_balanced` echo debit/credit totals the caller supplied;
`enforce_guard_limit` and `cheque_apply_balance` fire on the caller's own write.

**A separate existence oracle, found by reading rather than by pattern**:
`record_invoice_payment` distinguished `'Invoice not found'` from
`'Not authorised for this company'`. A caller walking uuids learned which
invoice ids were **real**. It never returns the invoice, which is why it reads
as safe. `0242b` puts `assert_same_company` first so both answer identically.

`0242b` also found that **`post_manual_journal` never checked `p_branch_id`**,
which it writes onto the journal entry and which the regional P&L reads back as
the region. Not a disclosure — a foreign key written across a tenant boundary
into the ledger. Guarded conditionally, since NULL is legitimate.

---

## 4. Which of the 59 `p_company_id` functions should not take it

The tenant is already known from the session for any authenticated caller, so
the parameter is a design smell. It is not always wrong, though, and the three
groups are different.

**Could derive it — 11 functions.** Called only from the frontend, always by an
authenticated user acting on their own company, and called from nowhere else in
the database:

`accrue_attendance_bonuses`, `accrue_bonus_reserve`, `accrue_eid_bonuses`,
`generate_bonus_pool`, `mirror_depreciation_to_reserve`, `request_approval`,
`run_appreciation`, `run_depreciation`, `run_ho_cost_allocation`,
`run_kpi_computation`, `sweep_ammo_discrepancy_alerts`.

**Must keep it — 5 functions, for two different reasons.**

* `add_subscription_payment` is called from `super-super-admin/Companies.tsx`.
  An SSA acting on **another** company is the intended use, and it is exactly
  the case the `is_ssa_unscoped()` escape in the guard exists for. Removing the
  parameter would break the feature.
* `ai_credit_reset_period`, `ai_credit_spend`, `ai_credit_status`,
  `ai_credit_topup` are called only from Edge Functions on `service_role`
  (`signup-complete`, `stripe-webhook`, `ai-chat`), which have no session and
  therefore no derivable company.

**Must keep it — 27 functions with internal callers.** They are helpers invoked
with a company already resolved by their caller: `head_office_region` (30
callers), `post_journal` (23), `reverse_journal_for_source` (15),
`cash_account_for` (9), `next_counter` (5), and 22 others.

**16 have no caller anywhere** — not in the frontend, not in an Edge Function,
not in another function: `attendance_gate_mode_residue`, `avg_deployed_guards`,
`billing_clients_on_head_office`, `bonus_accrual_missing`, `check_disbursement`,
`first_breach_week`, `fund_region`, `interregion_net_position`, `ledger_checks`,
`ledger_payroll_by_client`, `region_cash_entitlement`, `region_profit`,
`repost_payslip_accruals_for_month`, `reserve_target`, `sweep_receipt_to_reserve`,
`trueup_bonus_provision`. `fund_region` is the one worth a second look — it moves
money between regions and nothing calls it.

**No change made.** A parameter removal is a signature change, it belongs in its
own migration, and it is no longer urgent now that the guard checks the claim.

---

## 5. The bug that mattered more than any of the above

**0242 shipped a guard that never fired, and its own verification passed.**

The helper exempted trusted backend roles like this:

```sql
if current_user not in ('authenticated', 'anon') then return; end if;
```

**SECURITY DEFINER sets `current_user` to the function owner.** That is what the
mode does. All 135 guarded functions are SECURITY DEFINER owned by `postgres`,
so `current_user` was `postgres` on every call, the exemption always matched,
and the guard returned without checking anything. Measured, not reasoned:

```
as authenticated, outside a definer function : current_user = authenticated
inside a definer function                    : current_user = postgres
```

`session_user` is no better — PostgREST connects as one authenticator role and
switches with `SET LOCAL ROLE`, so it reads the same for `anon`, `authenticated`
and `service_role` alike.

**0242's verification passed throughout**, because it asserted that every
qualifying function *calls* `assert_same_company` — a property a no-op satisfies
perfectly. The suite caught it on its first run: **60 of 60 negative cases
returned normally.**

The replacement uses two signals that survive SECURITY DEFINER, because JWT
claims are a session GUC rather than a role attribute — and they are already
what `auth.uid()` and `current_company_id()` rest on, so this adds no new
dependency. Unparseable claims **enforce**, not exempt.

---

## 6. Proof

`supabase/tests/tenant_guard.sql`, run on dev:

```
population=135 seeded=10
NEG[exercised=135 pass=135 fail=0 noguard=0 nofixture=0]
POS[pass=129 fail=0 skip=6]
gaps=0
```

Every one of the 135, not a sample. `NEG` is a session for company A calling
each function with another company's row: all 135 raise exactly `Row not found`.
`POS` is the same call with the caller's own row: none is refused, so the guard
is not simply refusing everybody.

**Seeding, and why it is not cheating.** Ten tables are entirely empty on dev —
`alerts`, `bonus_pools`, `approval_requests`, `payroll_runs`, `fixed_assets`,
`contract_mobilisations`, `opening_balance_batches`, `bonus_pool_allocations`,
`posts`, `appraisals`. Without fixtures, 14 of the 135 report NO FIXTURE, which
is **not a pass**: the guard refuses a missing row and a foreign row with the
same message by design, so an absent row demonstrates only the
no-existence-oracle property. The suite seeds a minimal row owned by another
company, proves a genuine tenant refusal, and rolls it back.

**The guard can fail.** Removing it from `effective_salary`:

```
BREAK -> gaps=1 (effective_salary)
         NEG[exercised=135 pass=134 fail=1 noguard=1] gaps=1
```

Both detectors fire, and the population stays at 135 rather than shrinking to
match — see §7.

---

## 7. Three bugs in the harness itself, worth recording

Each one produced a *green-looking* result.

1. **The population was derived from the fix.** An earlier version counted
   `prosrc like '%assert_same_company%'`, so removing a guard shrank the
   expected count to match and the suite reported all-pass over a smaller set —
   the same vacuity that left `ledger_foundation.sql` dead from 0224 onward. It
   now enumerates the population independently and a member with no guard is a
   **failure**, not an absence.
2. **Fixtures were resolved after the role switch.** RLS then hid company B from
   the suite itself, turning all 76 resolved cases into NO FIXTURE and looking
   exactly like a data shortage.
3. **The guarded parameter is not always the first.** `post_manual_journal`
   takes a date first and the guarded account id third; a uuid in position 1
   produced a signature error that reads precisely like a guard failure.

And a fourth, subtler: other uuid arguments are now passed as **NULL, not
fabricated**. A fabricated uuid is foreign by construction, so a second guard
refuses first and the result says nothing about the guard under test. That is
what made `post_manual_journal` appear to refuse its own company.

---

## 8. What production needs

In order. Each needs a named approval.

1. `0242` — the guard and the 133 generated call sites.
2. `0242b` — the two hand-guarded functions, the invoice existence oracle, the
   `post_manual_journal` branch check.
3. `0242c` — **without this the other two are a no-op.** They must go together
   or not at all.
4. `0243` — the standing gap check.

Then run `supabase/tests/tenant_guard.sql` against production and confirm the
same numbers.

Also outstanding on production, from the earlier work: the recorded
`statements` for `0240` and `0241` are the trimmed bodies that were applied and
lack the files' headers. Syncing them is a separate named change.

---

## 9. Standing notes

Things this audit established that outlive it. Recorded here because each one
reads as obvious afterwards and was invisible in advance.

### 9.1 `current_user` and `session_user` are unusable as caller identity

Under PostgREST **plus** SECURITY DEFINER, neither one identifies the caller:

| signal | why it fails |
|---|---|
| `current_user` | SECURITY DEFINER **sets** it to the function owner. Inside every guarded function it reads `postgres`, for every caller — an authenticated user, `anon`, `service_role` and a migration alike. |
| `session_user` | PostgREST opens one connection as the authenticator role and switches with `SET LOCAL ROLE`. It reads the same for `anon`, `authenticated` and `service_role`. |

**`auth.uid()` and the JWT role claim (`request.jwt.claims ->> 'role'`) are the
only signals that survive**, because they are session GUCs rather than role
attributes, and SECURITY DEFINER does not touch them. They are also already what
`current_company_id()` rests on, so depending on them adds nothing new.

Any future authorisation code in this schema must use those two. The guard
carries a comment saying so at the point where the mistake would be repeated.

### 9.2 A clean sweep on the first run is suspicious, not reassuring

`assert_same_company` was the eighth instance in this project of a check that
could not fail — and the most instructive, because the previous seven were
**tests** that could not fail and this one was a **fix** that could not work,
certified by a verification that could not tell the difference. The
verification asserted the guard was *called*. A no-op is called.

The 60-of-60 first run is the detail worth keeping. In this codebase, a perfect
result on the first attempt has more often meant *the mechanism is not engaged*
than *the mechanism works*. Treat it as a prompt to go and break something and
confirm red, before believing the green.

### 9.3 A harness's expected set must be derived independently of what it checks

The suite's first version counted its population as
`prosrc like '%assert_same_company%'` — the presence of the fix. Removing a
guard then shrank the denominator to match and the suite reported all-pass over
a smaller set.

That is structurally identical to `ledger_foundation.sql` sitting dead from 0224
onward while looking alive. **A harness whose denominator comes from the thing
it measures cannot report a gap.** The population is now enumerated from the
catalogue — SECURITY DEFINER, takes a uuid, not commented exempt — and a member
with no guard is a failure rather than an absence.

### 9.4 "Mentions" is not "checks" — three times now

The same specific error has appeared three times in this one piece of work:

1. The original audit filtered on *the body never mentions `company_id`* and
   called the result 46. It was 138.
2. `0242`'s generator filtered on *the body never mentions `current_company_id`*
   and skipped two functions — caught by `0243` on its first run.
3. `0243`'s own candidate list had to be written to test *whether the guard is
   called*, specifically because a mention-based predicate would have passed
   `tenant_guard_gaps()` itself, which mentions the guard in its documentation.

A predicate over source text answers "does this string appear". It never
answers "is this enforced". Where the two can differ, the check has to execute
the code, not read it.

### 9.5 There was never an RLS-level fix available

The obvious-sounding suggestion for the SECURITY DEFINER problem is "just turn
on `FORCE ROW LEVEL SECURITY`". It would have shipped a migration that changed
nothing while reading as a fix.

`FORCE ROW LEVEL SECURITY` subjects a table's **owner** to its policies. A role
holding **`BYPASSRLS` bypasses RLS regardless of FORCE** — they are different
switches, and BYPASSRLS wins. On this schema:

* `postgres` owns all 136 tables and all 259 SECURITY DEFINER functions, and
  holds `BYPASSRLS`. Migrations and every definer body bypass via BYPASSRLS, not
  via owner-bypass, so FORCE never applies to them.
* `service_role` holds `BYPASSRLS` too.
* `authenticated` and `anon` are not owners, so RLS already applies and FORCE is
  irrelevant.

Demonstrated: with FORCE enabled on a table having RLS on and **zero policies**,
which should deny a non-bypassing owner everything, `postgres` still read all 44
rows and still inserted.

Removing `BYPASSRLS` from `postgres` is not a real option — it is the role
Supabase's tooling and every migration runs as, and stripping it would put all
259 definer functions under RLS simultaneously.

**So explicit guards inside the functions were the only option, not the
expensive one.** Anyone revisiting 0242 looking for something cheaper should
start here.

### 9.6 Before accepting a green result, state what would have made it red

> **THE MOST GENERAL FORM OF THIS RULE, AND THE ONE TO READ FIRST:**
>
> **A CHECK THAT IS NEVER EVALUATED IS INDISTINGUISHABLE FROM ONE THAT ALWAYS
> PASSES. ASK NOT ONLY "COULD THIS GO RED" BUT "IS THIS EXPRESSION EVALUATED AT
> ALL".**
>
> Established by `scripts/check-migrations.mjs`, which fetched migration
> digests, counted how many were non-null, printed a note, and never compared
> one of them to anything. The digest half of "the recorded SQL must equal the
> file" had never run. It was the third defect found in that one script and the
> only one that produced no answer rather than a wrong answer — and no answer
> reads exactly like a clean pass, which is why it survived the other two
> audits. Full account in §9.10.
>
> The operational habit: when a rule is documented as enforced, open the
> enforcement and find the line that compares. If there is no comparison
> operator anywhere in it, the rule is a comment.

> **AND ITS MIRROR IMAGE, WHICH COSTS MORE WHEN IGNORED:**
>
> **WHEN A CHECK REPORTS A PROBLEM, VERIFY THE CHECK BEFORE ACTING ON THE
> PROBLEM.**
>
> A red result is evidence about *two* things — the subject and the instrument —
> and nothing in the red itself distinguishes them. Three instances now, and
> they failed in both directions:
>
> 1. **The four "executable" migration diffs.** A stripper that removed
>    whole-line comments only, so a trailing `-- …` on a code line counted as
>    executable text and re-wrapping counted as difference. Reported four
>    security-guard migrations as possibly not matching what was deployed.
>    Diffed properly: **none differed in executable logic.** Believing it would
>    have meant re-applying guard migrations to production to fix nothing.
> 2. **Two migrations reported as drifted** that were byte-identical apart from
>    CRLF line endings, because the comparison did not normalise them. On a
>    Windows checkout that instrument reports *every* file as drifted — a
>    checker that cries wolf is a checker nobody reads.
> 3. **`0285`'s integrity check reporting both embedded blocks as DIFFERING**
>    from their sources during the production deployment. They were identical.
>    The marker strings used to slice the file contained `\n`; the freshly
>    checked-out file was CRLF; the markers were never found and the slices were
>    garbage. Normalising first reproduced the exact digests dev's ledger
>    records. **Believing this one would have aborted a correct deployment
>    mid-flight.**
>
> Note the asymmetry with the rule above. A check that never runs fails silently
> and is found late. A check that reports a false problem fails *loudly* and is
> acted on immediately — which is why it is the more expensive of the two, and
> why the first move on a red is to reproduce it a second way.
>
> All three were the same root cause dressed differently: **the instrument
> disagreed with the artifact about what the bytes were.** Comment stripping,
> line endings, line endings again.

> **AND THE ONLY RELIABLE WAY TO FIND ANY OF THEM:**
>
> **EVERY INSTRUMENT FAILURE IN THIS PROJECT WAS FOUND BY READING THE RESULT,
> NOT BY REVIEWING THE PATCH.**
>
> Not one of them was caught by looking at the change that caused it. The
> reviewer of a patch already knows what the patch is for, and so reads it as
> confirmation:
>
> * `check-migrations.mjs` never compared a digest — found by asking what the
>   script had actually printed;
> * `0288` cleared `ledger_checks` by matching its own comment — found by
>   reading the list and noticing an absence;
> * `0301` bumped one of the canary's three copies of its expected count —
>   found by reading `ledger_checks()` output showing *expected 21, actual 21,
>   passed FALSE*. The patch had a guard. The guard checked the same literal
>   the edit changed: a proxy for a proxy.
> * The vetting coverage table reported **0 completed checks** because it
>   counted `police_verification_status = 'verified'`, a label the enum
>   `(pending, cleared, adverse)` does not contain — found by reconciling the
>   table against a view that computed the same thing. A query asked in
>   vocabulary the data does not use returns zero and looks like an answer.
>
> The practical rule: after a change to a check, **run the check and read the
> verdict row**. Asserting the operands is not asserting the verdict — `0301`
> asserted that expected was 21 and actual was 21 and never asked whether
> `passed` was true.
>
> The structural rule, which is cheaper: **when a number must appear in more
> than one place, make it appear in one place.** `0302` collapsed the canary's
> count to a single value rather than correcting the two literals the regex
> had missed, because correcting them leaves the identical trap for whoever
> adds the next check.

> **A THIRD FAILURE MODE, AND THE WORST OF THE THREE:**
>
> **A CONFIDENT WRONG ANSWER STOPS THE SEARCH.**
>
> Ranked by how they behave, not by how often they happen:
>
> * a check that **never runs** fails silently and is found late;
> * a check that reports a **false problem** is expensive but self-announcing —
>   it forces someone to look;
> * a check that returns a **false negative** is worse than both, because it is
>   reassuring. Nothing announces it, and unlike the silent case there is a
>   green result actively arguing that the question has been settled.
>
> `uninvoked_controls()` in `0288` cleared `ledger_checks` — the one function
> the entire audit existed to expose — because its own exempt-list comment
> contained the string `ledger_checks`. The check ran, the test passed, and the
> answer was wrong in the direction that ends the investigation.

> **AND THE RULE THAT WOULD HAVE CAUGHT IT:**
>
> **VERIFY THE CLAIM THE HEADER MAKES, NOT THE OUTCOME YOU EXPECTED.**
>
> `0288`'s header stated, at length, that `ledger_checks` was deliberately not
> exempt and must report itself. Its verification asserted that the five
> known-dead controls appeared, and never asserted the sentence the header had
> just written.
>
> The check worked. The test worked. Neither covered the claim the file made
> about what it was for. This is distinct from everything above: nothing was
> broken, nothing was vacuous, and the instrument agreed with the artifact. The
> gap was between the **stated purpose** and the **asserted property**.
>
> The habit: after writing a header, read back every claim it makes in the
> indicative — "X is not exempt", "Y is refused", "Z is unchanged" — and check
> that a line in the verification tests each one. A claim in prose that no
> assertion covers is a comment, exactly like an unenforced rule.

> **A PROHIBITION, NOT A LESSON:**
>
> **NO CHECK IN THIS CODEBASE INFERS BEHAVIOUR FROM A SUBSTRING IN `prosrc`.**
>
> Three instances is not a recurring mistake, it is a property of the tool:
>
> 1. the original audit's `prosrc not ilike '%company_id%'`, which called
>    `post_journal` tenant-aware because it mentions `company_id` eleven times
>    without ever comparing it;
> 2. `0242`'s `prosrc not ilike '%current_company_id%'`, which skipped two
>    functions for the same reason and needed `0242b` to repair;
> 3. `0288`'s reachability match, which was fooled by its own comment.
>
> Substring matching on source text answers "does this word appear". That is
> never the question anybody means. Where source text genuinely must be
> inspected — the tenant-guard coverage checks are the only legitimate case in
> this schema, because "does this body call the guard" *is* a question about
> the text — the match must at minimum **strip comments** and **require call
> syntax**, and the residual limits must be written down.
>
> Audited 2026-09-01: exactly two functions read `prosrc`,
> `tenant_guard_gaps()` and `uninvoked_controls()`. Both are guard-coverage
> checks. `0290` brings the first up to the standard the second reached in
> `0288b`.

Nine instances now, and the last one was in the FORCE RLS pre-check itself. That
pre-check tested `current_company_id()` and `effective_salary` under FORCE **as
`authenticated`** and both passed — two green results about the wrong subject,
because `authenticated` is not the owner and FORCE is a no-op for it by
definition. Only the third case touched an owner path, and only it meant
anything.

The instances share one shape. The mechanism under test was never engaged:

| # | what looked green | why it was not engaged |
|---|---|---|
| 1–7 | seven tests that could not fail | early returns, unpaired assertions, `case when v_n >= 1 then 'PASS' else 'PASS'`, `prosrc` greps, refusals asserted as "something raised" |
| 8 | `assert_same_company` in 135 functions | the exemption matched every caller, so the guard no-opped; the verification asserted it was *called* |
| 9 | FORCE RLS pre-check | tested a non-owner, for whom FORCE does nothing |

The rule, stated once: **before accepting a green result, say out loud what
would have made it red — and if you cannot name a concrete change that flips it,
you have not tested anything.** Where the change is cheap, make it and watch the
red. `tenant_guard.sql` does this by removing a guard; `period_lock.sql` does it
by deriving its column set from the schema so a missing assertion cannot hide.

**A control that exercises a different trigger from the one under test is not a
control.** Instance ten came from exactly this. A probe of `journal_lines`
carried `set_config('app.ledger_maintenance','on')` in its preamble, and its
control — "`journal_entries` UPDATE is refused" — passed, so the session looked
unprivileged. It was not: `enforce_period_lock` **ignores** maintenance mode
while `enforce_journal_immutable` **honours** it. Two triggers, two gates, and a
control that proved the wrong one was awake. The finding was reported as the
most serious in the project and had to be retracted.

**A test must prove its mutation took effect before asserting on the result.**
Instance eleven, and the second in the failing direction: `period_lock.sql`
mutated `per_day_salary` with `col + 1`, the column was NULL, `NULL + 1` is
NULL, the row never changed, and 0237's carve-out correctly permitted a no-op.
The suite reported FAIL against code that was behaving properly. A test that
goes red while the system is right is how a real check gets deleted for being
noisy.

Instances twelve and thirteen are the same rule, found while writing the G0.2
suite, both by probing rather than by reading:

* **Twelve — the mutation must use the shape that reaches the code path.** The
  first G0.2 probe changed `total_due`, `subtotal` and the rest *on their own*
  and reported every one refused, i.e. nothing wrong. But 0237's carve-out opens
  with `old.amount_received is distinct from new.amount_received`: touched alone,
  those columns never reach the carve-out at all, they fall through to the lock,
  and of course they are refused. The defect is only reachable riding along with
  a receipt. A probe in the wrong shape does not under-test the code, it
  **exonerates** it.
* **Thirteen — `set contract_id = null` on a row whose `contract_id` was already
  null.** Same class as `per_day_salary`: the statement ran, the row did not
  change, the carve-out correctly permitted a no-op, and the test scored the
  column as unprotected when it was not. The fixture now populates
  `contract_id`, and must, because `uq_invoice_contract_month` also forbids
  reusing a contract already invoiced that month.

Both were caught by the suite that caught eleven, within one sitting of writing
it. Worth stating plainly: the suite is currently finding defects in its own
assertions faster than in the code, and that is the suite working, not failing.

**Every guard needs a positive control proving the legitimate path still works.**
A guard verified only by what it refuses is half tested, and the untested half is
the one that takes production down. Two instances, both caught by a positive
control and by nothing else:

* 0245's first discriminator, `xmin = txid_current()`, was false for exactly the
  rows the guard was meant to PERMIT, because every plpgsql `BEGIN…EXCEPTION`
  block is a subtransaction with its own xid and `post_journal` is essentially
  always called from inside one. It would have blocked all posting and passed
  every refusal-only test.
* 0242's guards raised on a legitimately absent id. `region_for_client(NULL)` is
  a normal call — an expense need not have a client, and twelve functions make
  it — and after 0242 it raised `Row not found`, breaking every expense insert.
  The suite's positive control called each function with the caller's OWN id and
  never with NULL: exhaustive in the refusing direction, and testing one of the
  two shapes a legitimate call takes.

**Prefer `now()` to `txid_current()` for "did this happen in the current
transaction".** `now()` is the transaction timestamp and is stable across
subtransactions; xids are not. This will come up again.

**An audit's detection rule is itself a claim and needs its own control.**
Instance fourteen, and the first time this shape appeared in a *methodology*
rather than in a test.

The repost-set audit enumerated, per trigger, the columns the posting reads
minus the columns its change-detection watches. The "watches" set was computed
as *any `old.X` reference in the function*. That rule is wrong, and wrong in the
silent direction: in most of these functions the posting date appears as
`old.<date>` **only inside the `reverse_journal_for_source` call**, never in a
comparison. Counting a use as a comparison made eight date columns invisible and
produced a confident, clean report about a property that was broken in eight
places.

The audit had every other control this project asks for — it was checked against
live `prosrc` rather than comments, it was read before being believed, and its
findings were probed. None of that helps when the detection rule matches the
wrong thing, because every downstream step faithfully processes a population
that was wrong before it started.

Same family as the FORCE RLS pre-check testing a non-owner and the unpinned
project ref reporting on a database it never contacted: **a green result about
the wrong subject.** The control the audit needed is the one §9.6 already
prescribes — name what would make it red. "A trigger that posts at an uncompared
date" was a case the first rule could not produce, and one worked example run
by hand would have shown it.

**The corollary is sharper than the bug.** `enforce_period_lock` carries a whole
branch for date moves — *"Moving a transaction out of a closed month requires
reopening it first"* — and the ledger never performed the move it guards. A
control defending against something that could not happen, sitting beside the
thing that did happen, unguarded. Worth checking, whenever a control looks
thorough, whether the event it refuses is an event the system can produce.

**A generator that reads its input once and writes many times loses all but the
last write. Re-read the target inside the loop.** The second-resolver-map run
requested three guards on one function, emitted three `CREATE OR REPLACE`
statements against the `prosrc` it had read *before* the loop began, and each
one overwrote the previous. One guard survived. Nothing anywhere reported a
problem: no error was raised, the function existed, it compiled, and it carried
a guard — just not the other two.

This is the worst-behaved failure mode in the section, because every other one
leaves a green result that is *wrong*. This one leaves an artefact that is
*plausible*. Reading the output tells you nothing: a function with one guard
looks exactly like a function that only ever needed one. It was caught by
counting guards against guards requested, not by inspection.

The general rule is read-modify-write, and it is not new; what is new is that a
code generator hides it. The loop looks like it writes three independent things.
It writes three things to one address.

**A new guard helper must be taught to the check, or the check quietly disagrees
with the code.** `assert_branch_in_company` was added as a second way to spell a
tenant guard, and `tenant_guard_covered` — which decides whether a function is
guarded — knew only the first. Every function using the new helper read as
unguarded. The fix is to put both forms in `tenant_guard_covered` so a third
helper is one edit in one place, rather than a new blind spot each time. A
coverage check that hard-codes one spelling of the thing it looks for degrades
silently every time the codebase gains a synonym.

**A class fix must be verified per member; uniform shape is not uniform
behaviour.** Eight `journal_on_*` triggers posted at a date they never compared.
Fixed as one class in 0258 — one migration, one shape, nine call sites — and six
of the eight were the one-line edit the class implied. The other two were not.
`journal_on_cheque` and `journal_on_expense_settlement` have no general "did
anything relevant change" test; each is driven by a status transition and
returns early when the status did not move. The date case needed a *third*
branch — **staying** in the state while the date moves — beside entering it and
leaving it.

Added as an `or` to the existing condition, those two would have compiled,
matched the other six by eye, and changed nothing. The reviewer's eye is the
failure surface here: a class fix is reviewed by pattern, and pattern is exactly
what the two outliers satisfy. They were caught by implementing each member
rather than by generalising from the first one, and then by asserting the
*property* — move a posted row's date, the old month must be vacated — across
all nine source tables rather than asserting eight instances of a shape.

Naming a defect as a class is the right move and it is also where the risk
enters: the name asserts the members are the same, and that assertion is
untested until each member is made to behave, one at a time.

**A check keyed on a marker its subjects deliberately do not carry is blind by
construction, and gets worse the more correct the code becomes.** Every balance
in `ledger_checks()` came from `group by a.system_key`. Per-location
sub-accounts — created automatically by `allocate_cash_location_account()` since
long before — carry `system_key = NULL`, because only one account per company
may claim a given key. So the bank and cash controls read the control row's own
lines and could not see a single child.

Two things make this worse than an ordinary blind spot. First, it was invisible
while broken: the sub-accounts had zero journal lines, so a check that ignored
them agreed exactly with a check that read them. Second, it **punishes the fix**.
Posting bank openings to the nine per-account children would have left the bank
control's measured balance untouched — the money lands where the check does not
look — and, because `cash_location_balances` includes the BANK-type locations,
would have driven the *cash* check from red by 595,990.13 to red by
8,106,091.13. A correct posting, marked as an eight-million-rupee regression, on
two independent checks at once.

The rule that generalises: when a check identifies its subject by a flag, ask
what the code does with objects that legitimately lack the flag. If the answer
is "creates them routinely", the check is measuring a subset it never declared.
Fixed in 0259 by summing the account subtree instead — and it had to ship *ahead*
of the data, because a check amended after the posting it misreads is a check
amended to fit an answer.

**ASK WHAT A CHECK MEASURES, NOT WHETHER IT PASSES.** Twice in one session a
control was found blind *by construction* rather than by defect — not broken,
but never able to see the thing it was named for:

* `no_one_sided_entries` scored a journal entry with no lines at all as
  balanced. Zero debits equal zero credits. The check was correct and the entry
  was empty.
* the bank and cash controls summed `group by system_key`, and the per-location
  sub-accounts carry `system_key = NULL` by construction.

Neither was found by running the check. Both were found by asking what the
predicate actually ranges over and comparing that to what the name claims. A
passing check answers "is this true of the rows I looked at"; it never answers
"did I look at the right rows", and no amount of green tells the difference.

The corollary, which is the operational rule: **a check amended after the
posting it misreads is a check amended to fit an answer.** If the amendment is
correct it is correct before the data exists, so ship it first and let it be red
on its own terms. 0259 went in ahead of the G1 opening batch for exactly this
reason — had it followed, its author would have been choosing between a
migration that turns two checks green and one that does not, with the answer
already known.

### A different failure mode: a pattern applied by hand and lost in the generated path

The nine instances above are all *a check that could not fail*. The NULL
regression in 0242 is not one of them, and filing it there would blur a
distinct lesson.

**When a pattern is applied by hand, check whether the generated path uses it
too.** In 0242b I wrote, by hand, exactly the right shape for
`post_manual_journal`'s optional `p_branch_id`:

```sql
if p_branch_id is not null then
  perform public.assert_same_company((select company_id from public.branches where id = p_branch_id));
end if;
```

In the same migration family, in the same session, the generator emitted 135
guards without the `is not null` test. The pattern was known, written down, and
not generalised. It took an expense insert failing in production-shaped
conditions to surface it.

**Audited for other instances of the same failure, and there is a second, larger
one.** The generator guards exactly ONE parameter per function — the first uuid.
`post_manual_journal` has two guards only because I added the second by hand.
**26 guarded functions accept more than one tenant-scoped uuid and check only
one of them:**

* four with three unchecked: `change_category`, `change_client`, `rehire_guard`
  (`p_new_client_id`, `p_contract_line_id`, `p_site_id`), and `fund_region`
  (`p_lender`, `p_borrower`, `p_approval_request_id`)
* the rest with one unchecked, mostly `p_branch_id`, `p_location_id`,
  `p_client_id`, `p_payslip_id`, `p_custodian_location_id`

The exploit shape is the one `post_manual_journal` had: pass your own id in the
guarded position, another company's id in an unguarded one, and the function
writes a cross-tenant reference. Some are covered by hand-written checks in
their own bodies (`assign_employee_code` and `record_invoice_payment` both
validate their second id against the resolved company); most are not.
Polymorphic parameters — `p_source_id`, `p_ref_id` — cannot be resolved
mechanically and need the same treatment as `is_action_approved`.

Not fixed. It needs a second reviewed resolver map for the additional parameter
names, and it is the same shape of change as 0242.

A corollary that has now earned its place: **a clean sweep on the first run is
suspicious, not reassuring.** In this codebase it has more often meant the
mechanism is not engaged than that it works.


### 9.7 Two rules from the ledger work

**A backfill that reconciles two representations must first prove they already
agree.** 0247 rewrote `status` from `reversal_of_entry_id`, and asserted on
every row that the two matched *before* overwriting one of them. Had they ever
disagreed, the backfill would have destroyed the only evidence that they did —
and produced a database that looks consistent because it was made consistent,
not because it was.

**A check whose pass condition is zero must be able to state what non-zero
input would have produced.** 0246's function returned `0.00` for every month
while returning the correct client list, and that reads as "these clients have
no guards" — a plausible sentence about a security company. A wrong sign gets
questioned; a zero gets believed. Its test now carries two non-vacuity guards:
the agreed figure must be non-zero, and the OLD predicate must still disagree
with the new one on the fixture, or the result is reported as NO DEMONSTRATION
rather than as a pass.

The same question is owed to every existing zero-pass check —
`no_one_sided_entries`, `no_billing_clients_on_head_office`,
`no_gate_mode_in_attendance_status` all pass at zero and none can currently say
what would make it non-zero. Not audited yet.
### 9.8 Three rules from the G2/G3 round

**AN INSTRUMENT THAT REPORTS ITS OWN INPUT IS NOT AN INSTRUMENT.**
`checks_evaluated` was shaped `expected = n, actual = n, passed = true`, where
`n` was the count of rows the same query had just produced. It could not fail.
Nothing read it — grep found it only in the migrations that defined it. It was
built to detect a truncated run, and it was itself the thing that could not
report. That is the canary problem recursing one level, and it is the fifteenth
instance of a check that could not fail. It now carries a **hardcoded** expected
count, so adding or losing a check turns it red until someone updates the
constant deliberately. 0266 fixed the shape; 0269, 0271 and 0275 each bumped the
constant as part of adding their check, which is the behaviour the hardcoding
exists to force.

**EVERY OTHER CONTROL COMPARES THE LEDGER TO ITSELF.**
`cash_control_equals_cash_locations` (0259) compares the cash control subtree to
`sum(cash_location_balances.balance)` — and that view is
`cl.opening_balance + coalesce(sum(jl.debit - jl.credit), 0)`. **Both sides are
`journal_lines`.** It is a real and useful measurement — "lines on the parent
that are on no child", which was exactly the 595,990.13 — but it is not
ledger-versus-reality, and its name suggests otherwise.

`custodian_held_operational()` (0262) is the first check in this project that
compares the ledger to something **outside** it: the operational held-cash
figure the application computes in `src/app/lib/custodian.ts` and shows the user.
`bank_held_operational()` (0271) is its bank-side twin. The distinction is the
difference between *internally consistent* and *correct*, and until 0262 the
suite could only establish the first.

Two corollaries earned the same round:

*An aggregate check cannot see an error that nets to zero inside its own
aggregate.* The per-account bank check reported **1,616,923** where the subtree
check reported **938,467**. The 678,456 difference was misrouting between the
control and its children — invisible by construction, not by defect. The
990,000 bank-to-bank transfer that never posted was inside it: both accounts sit
in the bank subtree, so the missing entry cancelled against itself. Third
instance of ask-what-a-check-measures, and the second where the answer was "less
than it appears".

*Two records agreeing is not evidence that either is right.*
`cash_per_location_gl_equals_operational` is **green** for HAMNA (−3,477.00) and
Safi (−1,999.87): the ledger and the operational record agree precisely that a
custodian holds less than nothing. 0275 adds the check that a physical
impossibility is impossible, which neither reconciliation could ever have caught
because reconciliations compare two things to each other and never to the world.

**ANY MIGRATION INSTALLING A POSTING RULE MUST STATE ITS BACKFILL, OR STATE WHY
NONE IS NEEDED.**
0221 installed `journal_on_cheque` as an `AFTER UPDATE` trigger keyed to the
`pending -> cleared` **transition**. Two cheques had already made that
transition, so their posting was owed and could never be paid: a rule keyed to
an observed change cannot repair a row whose change already happened. 0221 stated
no backfill and needed one. It escaped consequence on seven of the eight source
tables only because those tables had no qualifying rows yet — an accident of the
sandbox timeline, not a property of the design.

Two mechanisms enforce it now:

* **Key posting rules to STATE, not to transitions.** `sync_cheque_journal()`
  (0269) and `sync_bank_transfer_journal()` (0272) compute what the row's current
  state requires, compare that to the live entry on four facts, and act only on a
  difference. Idempotent by construction, which is what makes them safe as
  backfills.
* **The backfill is a loop over the rule itself**, so it cannot drift from what
  it backfills — the same failure the fixture audit found, where a fixture
  encoded a *model* of an RPC rather than the RPC.
* **`every_source_row_posted`** (0269, extended by 0272) is red whenever a source
  row a rule covers has no live entry. Proved able to fail by disabling the
  posting trigger and inserting a cleared cheque: `unposted 0 -> 1`. The next
  unbackfilled rule is red the day it ships rather than found by looking.

### 9.9 Two more, from the F4 round

**WHEN A FIX LANDS BEFORE ITS CHECK, THE CHECK MUST BE PROVED AGAINST SYNTHETIC
FAILURE, BECAUSE THE REAL FAILURE IS NO LONGER REACHABLE.**

§9.6 says a check amended after the posting it misreads is a check amended to
fit an answer, and that the remedy is to ship the check first. F4 is the
inverted case: `partnership_allocation()` was already the nested waterfall by
the time its check was written, so the 135% over-allocation could not be
reproduced by running anything. Breaking the function to prove the check would
be worse than not proving it.

The resolution is to write the check against the **output** rather than the
code. `profit_allocation_exhausts_pool` (0282) reads the stored
`profit_allocation_runs` record — `regional_total + equity_total` against
`total_profit` — so a run shaped like the old separate-pools rule can simply be
inserted. It is proved in the migration, in a rolled-back subtransaction, on the
real July figures:

```
old rule    profit −131,120.00  regional −25,224.00  equity −131,120.00  -> RED
nested      profit −131,120.00  regional −25,224.00  equity −105,896.00  -> GREEN
```

Both directions, because a check only ever seen red is as uninformative as one
only ever seen green. A check that reads persisted results rather than
re-deriving them is also the only kind that can be proved this way, which is a
reason to prefer that shape when there is a choice.

**A CONSTRAINT PROVED ONLY BY WHAT IT REFUSES IS HALF PROVED.**

0268 added `invoice_payments_cash_names_a_location` and proved it could reject a
cash receipt with no custodian. It never proved a cash receipt *with* one still
worked. `record_invoice_payment()` inserts without a custodian, so from 0268
until 0281 **every cash receipt through the application was refused** — the only
path an operator has for recording a client paying in cash.

Nothing caught it. The constraint's own test was green, the ledger checks were
green, and the sandbox's cash receipts predated the constraint. It was found by
deliberately exercising the real call path while looking at something else.

So a rule needs both proofs: that it rejects what it should, and that everything
it should accept still passes — the second exercised through the actual caller,
not through a hand-written insert that resembles it. 0281 carries both, and the
"accepts" half runs the real RPC inside a savepoint and rolls it back, because
unwinding an oldest-first payment waterfall by hand would mean writing a model
of the RPC instead of calling it — the same mistake the fixture audit found.

This is a third form of the vacuity problem, distinct from the two already
recorded. A check that cannot fail proves nothing. A check that reports its own
input proves nothing. **A constraint that has only ever been shown to say no
tells you nothing about whether the system still says yes.**

### 9.10 Three from the digest-alignment round

#### THE RULE NOBODY WAS ENFORCING WAS THE ONE WITH A SCRIPT NAMED AFTER IT

`CLAUDE.md` states that the recorded SQL must equal the file, that there are no
acceptable exceptions, and that `ledger_checks()` flags a mismatch.
`scripts/check-migrations.mjs` fetched the digests, counted how many were
non-null, printed a note about the shortfall, and **never compared one of them
to anything**. There was no digest check. There had never been a digest check.

It surfaced only because 0283 exposed `recorded_migration_sql()` for an
unrelated reason and the comparison was then run by hand: 300 files, 26 adrift.

The three defects previously recorded in that script's header each produced a
*wrong answer*. This one produced *no answer*, and no answer reads exactly like
a clean pass. That is the more dangerous shape, and the general form is worth
keeping:

**A CHECK THAT IS NEVER EVALUATED IS INDISTINGUISHABLE FROM A CHECK THAT ALWAYS
PASSES. THE INSTRUMENT'S OUTPUT MUST DEPEND ON THE THING IT MEASURES — SO ASK
NOT ONLY "COULD THIS GO RED" BUT "IS THIS EXPRESSION EVALUATED AT ALL".**

The related habit that would have caught it earlier: when a rule is documented
as enforced, open the enforcement and find the line that compares. If there is
no comparison operator anywhere in it, the rule is a comment.

#### A DIFFERENCE THAT IS AN ARTEFACT OF THE MEASUREMENT IS NOT A FINDING

The first hand audit reported 26 divergences of which 4 had "differing
executable SQL". Both numbers were partly artefacts of how the comparison was
done, and the corrections run in opposite directions, which is the useful part:

* Two files (`0078c`, `0253`) were reported as divergent and were byte-identical
  apart from **CRLF line endings**. The repo is checked out on Windows; the
  ledger stores LF. Any digest comparison that does not normalise line endings
  reports every file on a Windows machine as drifted — a checker that cries wolf
  is a checker nobody reads.
* Two others (`0260`, `0261`) were *not* divergent when the audit ran and became
  divergent afterwards, because they were restored from git in between. A count
  taken before a change and reported after it describes neither state.
* The "executable SQL differs" classification was produced by a stripper that
  removed whole-line comments only. It therefore counted a trailing `-- ...` on
  a code line as executable text, and it counted line re-wrapping as a
  difference. Diffed properly, **none of the four differed in executable
  logic**: `0245` not at all, `0242` and `0251` only in COMMENT ON strings, and
  `0248` only in two declared-but-never-used variables.

Reported as four security-guard migrations whose deployed behaviour might not
match the repo, the finding was alarming and wrong. The measurement was the
defect. Before escalating a discrepancy, reproduce it a second way.

#### ALIGN UP, AND SAY WHICH WAY YOU ALIGNED IT

Where the file and the ledger disagree, the file wins: re-apply so the ledger
carries the full text. Never edit the file down to match the ledger — the
recorded SQL exists to *describe* the file, and trimming a file to match a
truncated record destroys the headers this project deliberately writes and
leaves the ledger looking authoritative about text it never had.

One departure, taken deliberately and recorded here because it is the kind of
thing that should not be discovered later in a diff: the 26 were aligned by
**rewriting the recorded statements, not by re-executing the migrations**.
Re-execution was not available. `0242` would re-run a code generator against
today's catalogue and rewrite functions written after it; `0245` would insert a
second closed accounting period and another test journal entry; `0250` and
`0258` would repost. Applying them again also does not replace a row — it
appends a second one under a new version, so the ledger would gain duplicates.
The executable text was proved equal before each rewrite, and the three cases
where it was not exactly equal were overridden by hand with the reason stored in
the migration's own alignment record.

### 9.11 Two from the compliance-consolidation round

#### FIVE IMPLEMENTATIONS OF A QUESTION WITH NO DATA ALL AGREE

"What is expiring soon" was implemented five times: `compliance_upcoming`, the
`send-compliance-alerts` edge function, `Licences.tsx`, `Dashboard.tsx`, and
ai-chat's `get_expiring_licences`. Two of the five were only found because the
grep was mandated; three had been the accepted count until then.

The five disagreed about which employees to include — two different membership
filters, and it turned out **neither was correct**. That divergence was the
reason the consolidation was ordered, and it was the wrong thing to worry about.
It was **latent**: zero employees differ under the two filters on either
database, so no user has ever seen two numbers.

The real finding was what all five *shared*. Every one of them computed weapon
licence, guard service licence, medical fitness and probation end. **All four of
those columns are empty on dev and on production.** None of the five read
`cnic_expiry` — the only compliance date with data in it, 154 rows on dev and 83
on production, ten of them already expired and one 1,064 days overdue.

So the licence-expiry surface returned nothing, correctly, for its entire
existence. Five implementations of a question that could not be answered wrongly
because there was nothing to answer it with, and their agreement was the
agreement of five empty sets.

**AGREEMENT BETWEEN IMPLEMENTATIONS IS EVIDENCE ONLY WHEN THE INPUTS ARE
NON-EMPTY. BEFORE RECONCILING TWO ANSWERS, CHECK THAT EITHER ONE READ ANY DATA.**

This is the canary one level up. `ledger_foundation.sql` sat dead from 0224
because a silent suite cannot be told from a passing one; here, five silent
implementations could not be told from five correct ones. The same question
answers both: *what would have made this different?* Five agreeing readers of
four empty columns would have produced exactly the output observed, and so the
output carried no information.

The corollary is a habit, not a rule: when consolidating duplicates, check the
population of every input column **before** reconciling the logic. The columns
answer in one query whether the disagreement can bite at all, and if the answer
is no, the duplication was never the defect — the missing coverage was.

#### A WINDOW THAT STARTS AT TODAY HIDES THE FAILURES AND SHOWS THE WARNINGS

`Dashboard.tsx` counted expiries with `d >= today && d <= in30`. An item that has
already expired is not late in that window; it is **outside** it. The tile would
have read zero while ten guards held expired CNICs, and zero is what a healthy
system also shows.

The lower bound is the defect. `<= in30` is a real question ("what needs
attention soon"); `>= today` silently answers a different one ("what has not
failed yet"), and it drops precisely the rows that most need to be seen. A
filter tuned to surface warnings deleted the failures.

**A RANGE FILTER OVER TIME MUST NOT HAVE A LOWER BOUND AT `now()` UNLESS
SOMETHING ELSE SURFACES WHAT FELL BELOW IT. OVERDUE IS THE LOUDEST STATE, NOT
THE EXPIRED ONE.**

`compliance_upcoming` therefore exposes a **signed** `days_remaining` and applies
no window at all. Overdue items come back negative and sort to the top; each
consumer chooses its own upper bound and none of them can drop the bottom by
accident. Where a display genuinely wants "next 30 days", the bound to write is
`days_remaining <= 30`, which keeps every negative row.

The general shape: the two defects in this round are the same defect. One
filtered out the only populated column, the other filtered out the only failing
rows, and both presented the empty result as a clean one.

#### A CONTROL THAT FIRES ON EVERY INPUT IS AS UNINFORMATIVE AS ONE THAT NEVER FIRES, AND WORSE, BECAUSE IT TRAINS ITS READER

The mirror of the rule above, found one round later and from the other side.

`check_deploy_guard` was about to be wired to the deployment path. Measuring
first stopped it:

```
active employees                       758
not weapons-certified                  758   <- every one
no weapon licence document on file     758   <- every one
police verification pending            701
police or NADRA ADVERSE                  0
blacklisted                              0
```

`armed_post_blockers()` returns a non-empty list for **every employee in the
database**, for the same reason the licence columns were empty: nobody has
entered the vetting fields. `weapons_certified` is false for all 758 because it
was never recorded, not because 758 guards failed a test.

Five implementations agreeing over empty inputs and one control alarming over
empty inputs are the same defect: **an output that does not depend on the
world**. Ask of any check not only "could this go red" but "is there any input
for which it goes green".

The asymmetry is what makes this the worse half. A silent check is ignored by
nobody, because nobody sees it. A check that fires on everything is seen, and
teaches the person who sees it that the feed is not worth reading — and it
teaches that lesson about the whole feed, not just about itself. `alerts` has
never held a row in either database. Its first day would have been hundreds of
identical warnings. The feed is currently unread because it is empty; it would
have become unread because it is noise, and only one of those is recoverable.

The fix is not to suppress the noisy control. It is to notice that two different
questions were wearing one name:

* a vetting **FAILURE** — blacklisted, police adverse, NADRA adverse, not in
  active service. True of nobody today, so a control on these is quiet **and
  able to speak**, which is the definition of a working check.
* a vetting **GAP** — not certified, document not on file. A data-entry
  shortfall true of everybody, which is a coverage number, not an alert.
  Nobody needs 758 warnings; one number in a report is the whole content.

**A CONDITION TRUE OF EVERY ROW IS A MEASUREMENT, NOT AN EVENT. ROUTE IT TO A
REPORT, AND KEEP THE ALERT FOR THE THING THAT DISTINGUISHES ONE ROW FROM
ANOTHER.**

### 9.12 Three from the alerting round

#### A TABLE THAT ONLY RECORDS FAILURES CANNOT DETECT ITS OWN ABSENCE

The delivery watchdog was nearly written as "were there failed sends". That
catches a broken sender and is blind to the failure that matters more: a cron
job that stops running writes nothing at all, and an alerting system silent
because it is broken looks exactly like one silent because all is well.

Inverting it — **is there a recent SUCCESS** — goes red for both, because
absence of evidence becomes the evidence.

The general form, and it applies to any log used as a health signal:

**AN INSTRUMENT THAT ONLY RECORDS BAD OUTCOMES CANNOT DISTINGUISH "NOTHING BAD
HAPPENED" FROM "NOTHING HAPPENED". RECORD THE HEARTBEAT, NOT ONLY THE FAULT.**

Two supporting details, both load-bearing:

* **`skipped` is a third status and does not count as success.** A digest run
  that found nothing due did not exercise the transport, so counting it as
  healthy would let a permanently broken sender look fine on any quiet day.
  The mirror rule applies to the scheduled check run, where the opposite is
  true: a run that found nothing red *did* exercise the mechanism, so it does
  count. Same table, same watchdog, opposite treatment of "nothing happened" —
  because in one case nothing happened *to* the mechanism and in the other the
  mechanism ran and found nothing.
* **The provider's message id is recorded, not just a boolean.** "The API
  accepted it and returned this id" is a different claim from "we think we sent
  something", and it is the same distinction one layer out from the rule above.

#### PICK THE CLOCK THAT MATCHES WHAT IS BEING MEASURED

`notification_deliveries.attempted_at` defaulted to `now()`. `now()` is
**transaction-start** time, so two delivery attempts written in one transaction
received identical stamps and could not be ordered — which is how the
verification failed: `order by attempted_at desc limit 1` returned an arbitrary
one of the two.

It is an **event log**. It records when the event happened, not when the
transaction opened, so the default is `clock_timestamp()`.

This sits alongside the earlier note about preferring `now()` over
`txid_current()` for ordering. The rule underneath both:

**A TIMESTAMP IS A MEASUREMENT. ASK WHAT IT IS MEASURING — THE TRANSACTION, THE
STATEMENT, OR THE EVENT — AND PICK THE CLOCK THAT ANSWERS THAT QUESTION.**

**Third instance, 2026-09-01, and the most instructive.** `0310` added
`closed_period_intrusions()` — rows dated inside a closed period that were
*created after* it closed. Its verification closed a month with `now()`,
inserted a row whose `created_at` defaults to `now()`, and asked whether
`created_at > closed_at`. Inside one transaction those are the **same
microsecond**, so the detector reported nothing and the verification failed.

The detector was right; the test was wrong. A real close and a real write are
separate transactions, so strict `>` is correct. The fix was to stop the test
pretending they were simultaneous — close the month an hour earlier, re-close it
with `clock_timestamp()`.

> **A TEST THAT RUNS IN ONE TRANSACTION CANNOT DEMONSTRATE AN ORDERING THAT ONLY
> EXISTS BETWEEN TRANSACTIONS. IF THE THING UNDER TEST DEPENDS ON TWO EVENTS
> HAPPENING AT DIFFERENT TIMES, THE TEST MUST MANUFACTURE THE GAP.**

Worth writing down because the reflex on seeing "detector reported 0 rows" is to
loosen the detector. `>=` would have made the verification pass — and would have
made the check flag every row written in the same instant its month was closed,
which is every legitimate close-after-write.

A related bug in the same function, worth its own line: the detector read "the
latest row" **twice**, once for its timestamp and once for its status. Two
queries asking for the latest row are two chances to pick different rows, and
they duly disagreed the moment two rows shared a stamp — it reported the failure
and printed the *success* row's null error. **Read the row once.**

#### THE INSTRUMENT DISTURBED ITS SUBJECT, FOR THE THIRD TIME

`0298`'s survey of fabricated separations — employees in a separated state with
no exit date, no last working day, no termination date and no reason — ran at
the **end** of a verification block whose earlier steps had inserted an employee
and updated it to `fired`. A fixture does not fill in a leaving date, so the
survey found the row the block had just made and reported the data as
suspect.

Third instance in this codebase:

1. `0290`/`0289`: probes that stub a function must restore it **before**
   judging, or a failure leaves the stub behind and the next reader inherits it.
2. The digest audit: counts taken before a change and reported after it
   described neither state.
3. This: a survey of a population taken after the block started adding rows to
   that population.

**A MEASUREMENT OF EXISTING STATE MUST BE TAKEN BEFORE THE BLOCK THAT CREATES
STATE OF THE SAME KIND — OR IT IS MEASURING ITSELF.**

The fix is ordering, not filtering. Excluding the probe rows by name would have
worked today and would silently stop working the moment a fixture changed its
naming; taking the survey first cannot rot.

### 9.13 A defaulted parameter turns a loud failure into a quiet one

> **WHEN ADDING A PARAMETER TO AN EXISTING FUNCTION, ENUMERATE EVERY CALLER
> RATHER THAN DEFAULTING FOR COMPATIBILITY.**

`0303` gave `partner_basis_for_report(p_basis)` a second parameter,
`p_company_id uuid DEFAULT NULL`, so that existing call sites would keep
working. They did. One of them kept working *wrongly*.

`partnership_allocation` calls `partner_basis_for_report` itself, with one
argument. After the change that call still compiled — and resolved to the
default, NULL — so it asked for the remuneration basis of no company and raised
under the review it sits beneath. **A default converts what would have been a
compile-time error into a runtime one, and a runtime one only appears if
something asks.** The verification asked; nothing else would have, because
`profit_allocation_review` had never been callable in the first place.

The default was still the right shape for the four frontend RPC calls and the
three database callers that legitimately want the session's tenant. What was
wrong was treating "it still compiles" as the check. **The check is the list of
callers.** For these three functions that list is seven entries and took one
grep.

#### And the half that would not have been noticed at all

There is a sharper failure hiding behind the same change, and it is the one to
remember:

> **A FUNCTION THAT THROWS IS AT LEAST HONEST ABOUT NOT WORKING. THE DANGEROUS
> REPAIR IS THE ONE THAT STOPS THE THROWING WITHOUT FIXING THE CAUSE.**

Parameterising `partner_basis_for_report` alone would have made
`profit_allocation_review` stop raising. Its other three arms call
`client_statement_loaded` and `partnership_allocation`, which resolve the tenant
from `current_company_id()` — NULL under cron — so they would have read
`where company_id = NULL`, matched nothing, raised nothing, and returned clean.

A control that throws is visibly broken. A control that returns clean is
**indistinguishable from a control that is working**, and it would have been
wired into the scheduled suite and reported green every morning. Half of `0303`
is the half nobody would have gone looking for.

Related, and the reason both halves were caught: `9.6`'s rule about reading the
result rather than the patch. The first half was found by the verification
failing. The second was found by asking what each arm would read, which is the
same question in a different tense.

### 9.14 A number measured in one database is not a property of the migration

> **ASK OF EVERY LITERAL IN A VERIFICATION BLOCK: IS THIS AN *INPUT* THE
> MIGRATION CREATES, OR A *READING* OF STATE IT DID NOT CREATE?**
>
> **Inputs are fine** — a probe amount, a synthetic three-day divergence, a
> fixture row. They are properties of the test.
>
> **Readings are landmines.** They pass everywhere they were written and abort
> in the first environment that differs, with no warning, at the least
> convenient moment.
>
> When a reading is genuinely what you want to check, **assert the invariant it
> is evidence for and print the reading as a `NOTICE`.**

All seventy migrations in the ledger stream were scanned for this shape. **Three
genuine cases; two of them were mine, written this week, while the older
migrations were already disciplined about it.** The pattern that failed is the
one I introduced.

`0275` is the model to copy, and it was written long before the rule was
articulated: it selects the sandbox company by name, **degrades to a `raise
notice` when that company is absent**, reports how many custodian locations are
negative, and raises only if *every* location is negative — "the arithmetic is
suspect, not the data". A reading, used as evidence, with a failure condition
that is a property of the arithmetic rather than of the data.

#### The corollary about documents

> **ANY DOCUMENT MAKING CLAIMS ABOUT ANOTHER SYSTEM'S STATE NEEDS A RE-CHECK
> BEFORE IT IS RELIED ON, NOT ONLY BEFORE IT IS WRITTEN.**

`PRE_GO_LIVE.md`'s production manifest asserted three things about
`crm-design`, each true when measured and each false when used:

* the partner remuneration basis series (`0230`/`0231`/`0232`) is absent from
  production — **it is recorded there**;
* `partners.basis` still exists on production — **it does not**;
* `PartnerFormModal.tsx` still writes that column, so the form will break —
  **it reads `finance_settings.partner_remuneration_basis`, with a comment
  saying why.**

Nothing in the process re-measured them. The document was treated as the state
rather than as a reading of the state, and a whole go-live precondition and
frontend gate were carried forward on it.

The same defect bit twice more in one sitting:

* the manifest's claim that **`0245`'s verification leaves rows behind** — false,
  and disproved by counting rows rather than by re-reading the file;
* `0308`'s own verification, which asserted **United Bank Ltd reads GL 800,000**.
  True on dev. On production the same account reads GL 0, so the migration
  would have aborted on a fact about a different database. Caught by probing
  prod before applying, not by review.

The last is the sharpest form of it, and the rule it produces is narrower and
more useful than "re-check your documents":

> **A NUMBER MEASURED IN ONE DATABASE IS NOT A PROPERTY OF THE MIGRATION.**
>
> Assert the invariant the change must preserve — here, *removing the mechanism
> moves no money*, checked as a before/after snapshot of every row — and print
> the environment-specific figures as evidence instead of requiring them.

An assertion that encodes a local measurement does not become more true by
being in a migration; it becomes a landmine that goes off in the other
environment, at the least convenient moment, having passed everywhere it was
tested.

### 9.15 Two errors that cancel present as a passing check

> **A CHECK THAT NETS ITS INPUTS CANNOT SEE AN ERROR THAT NETS TO ZERO INSIDE
> ITS OWN AGGREGATE. THE ONLY DEFENCE IS DECOMPOSITION.**

`bank_per_account_gl_equals_operational` reported **0.00** for United Bank Ltd
and had done so for as long as anyone had looked. It was not correct. Two
postings had been routed to the wrong node of the bank subtree — one into the
parent, one into the child — and the aggregate summed both. The check was
reading the truth of a sum whose terms were individually wrong.

Posting the SANDBOX opening batch moved the figure to **800,000**. That is the
check *improving*: the cancelling pair was broken and the residual became
visible for the first time. Reading it as a regression would have been exactly
backwards, and would have produced a "fix" that restored the cancellation.

**It was found by decomposing the aggregate per account, not by re-reading the
check.** No amount of scrutiny of a netting expression reveals what the netting
hides.

This is the fifth instance of a green that was green for the wrong reason —
after the empty entry that scored as balanced, the enum count that could only
ever return zero, the five implementations that agreed because none had data,
and the digest comparison that was never evaluated (§9.6). **It is the first
where the false green sat in a real financial control rather than in an
instrument**, which is what makes it the expensive one: the other four misled a
reader, this one would have certified a set of books.

The operational habit follows from the shape rather than from the incident: for
any check that aggregates before comparing, **run it once grouped by its
finest dimension** — per account, per location, per period — and keep that
decomposition, because the aggregate will go green again the moment a second
error arrives to cancel the first.

### 9.16 A figure in a header describes the database it was measured on

> **A FIGURE IN A HEADER DESCRIBES THE DATABASE IT WAS MEASURED ON AND NOTHING
> ELSE.**

The companion to §9.14, and the reason that rule is not enough on its own.
§9.14 governs literals inside *assertions*, where being wrong is loud: the
migration aborts. A figure in **prose** is worse behaved. It never aborts
anything. It is read by the next person as a property of the system, and it is
believed, because a number written in a migration header carries the authority
of the file it sits in.

`0271`'s header explained a ~6.4M discrepancy as opening balances sitting in
sub-accounts — a routing defect that later migrations would correct. Measured
against production, the explanation did not fit: Meezan showed GL −500,000
against operational 3,843,255, which is not a balance in the wrong account but
**a balance that was never posted at all.** The header did not lie about dev.
It simply described dev, in a file that would be applied to production, in
prose that no assertion checked.

`0260`'s header cites **7,510,101.00**, which is production's exact
`bank_accounts.opening_balance` sum. That one is a coincidence — the figure was
measured on dev — and a coincidence is the worst possible outcome here, because
it is the case that survives every spot-check.

Twenty-three headers in the ledger stream carry a dev-measured figure with no
assertion behind it. They are not all worth the same:

1. **A figure a reader would take as a property of production.** Fix these.
   They produce wrong decisions, as `0271`'s did.
2. **A figure inside an assertion.** Already governed by §9.14; audit before
   the migration is applied, not after.
3. **Narrative arithmetic inside an explanation.** Lowest value. Fix
   opportunistically.

The rule for writing one: **name the database beside the number.** "6,771,645
on `crm-design-dev`" is a reading. "6,771,645" is a claim about the world, and
it will be wrong somewhere.

### 9.17 One lesson, three angles: what a constraint has to be proved against

`0268` produced the same defect three times in three different shapes. They are
worth recording together, because each was found only after the previous one had
been fixed and believed sufficient.

> **1. A CONSTRAINT PROVED ONLY BY WHAT IT REFUSES IS HALF PROVED.**
>
> `0268` demonstrated that its check rejects a cash row with no custodian, and
> never demonstrated that a good row still passes. It did not: the deployed
> `record_invoice_payment` inserted no custodian, so `0268` would have refused
> **every cash receipt on production**. Proving the refusal is half. The other
> half is that everything the rule should accept still passes, and the only way
> to know is to exercise the real call path.

> **2. A PRE-FLIGHT MUST CHECK WHETHER THE DEPLOYED CODE CAN SATISFY THE NEW
> CONSTRAINT, NOT ONLY WHETHER THE EXISTING DATA DOES.**
>
> `0268`'s data pre-flight was clean — 0 violating rows on all four tables — and
> would have been clean at any moment in the migration's life. The data was
> never the problem. The writer was. A pre-flight that queries only the table is
> asking the wrong object a question it cannot answer.

> **3. CHECK THE WRITER *AND THE ROWS IT IS ABOUT TO MOVE*.**
>
> The least obvious of the three, and found last. `0268`'s payslip constraint is
> `payment_mode <> 'Cash' or not disbursed or custodian_location_id is not null`
> — keyed to a **state flag**. Production holds **zero** violating payslips and
> **eight** that violate the instant payroll is disbursed. The violating state
> does not exist yet; it is created by a normal operation. No query over current
> data can see it, and rule 2's fix — read the writer — does not find it either,
> because the writer is fine in isolation. Only the writer *applied to the rows
> it will touch* reveals it.
>
> **A CONSTRAINT GUARDED BY A STATE FLAG IS SATISFIED BY DATA THAT HAS NOT YET
> REACHED THAT STATE. ASK WHAT THE NEXT TRANSITION PRODUCES, NOT WHAT THE TABLE
> HOLDS.**

The progression is the point. Each rule is a strictly larger question than the
one before it, and each was reached only by being wrong in the smaller one:

| | asks about | missed |
|---|---|---|
| 1 | the constraint | that the good path was broken |
| 2 | the writer | that data-clean proves nothing about writers |
| 3 | the writer × the rows | that a flag-keyed rule is dormant, not satisfied |

Three of `0268`'s eleven write paths still cannot satisfy it, which is why it
remains deferred after the rest of its release shipped.

#### A smaller note from the same investigation

`Accounting.tsx`'s `resolvePaymentCustodianLoc()` returns `null` when the
company id resolves to null, and the guard above it only tests that a custodian
was *selected*. A user whose company cannot be resolved therefore reaches the
constraint instead of the message — a raw Postgres error in a toast where
`0281` deliberately produced a legible refusal. Low severity, same class of
defect: **a validation that checks the input but not the resolution of that
input.**

### 9.18 The fall-through is where the decision gets made by accident

Three instances now, in three different shapes, all in the finance path:

| where | the fall-through | what it decided |
|---|---|---|
| the branch resolver | `else 'left'` | a side, for every unlisted value |
| the period lock | an early `return` | that the period was open |
| `settlement_account` | `else bank_account_gl(...)` | that every unknown mode is a bank payment |

The third is the clearest. Written as

```sql
when p_payment_mode = 'Cash'    then cash_account_for(...)
when p_payment_mode = 'Cheque'
     and outgoing               then unpresented_cheques
else                                 bank_account_gl(...)
```

the `else` reads as "Bank". It is not. It is **"Bank, and every value nobody
enumerated, and NULL"** — and four tables feed this function, so adding a mode
to any one of them would have posted it to a bank account with a null account
id. `0317` names every mode and raises on the rest.

> **A DEFAULT THAT ABSORBS THE UNKNOWN CASE CANNOT FAIL, AND A BRANCH THAT
> CANNOT FAIL IS INDISTINGUISHABLE FROM ONE THAT IS NEVER CHECKED.**

The shape is hard to see because in all three the fall-through is *correct for
the values that exist today*. It is only wrong about the value nobody has
added yet, which means it will be discovered by the change that adds one — at
which point the failure looks like a bug in the new feature rather than in the
branch that swallowed it.

**LOGGED, NOT DONE:** a sweep of every `else` and `coalesce` in the finance
path that SUPPLIES A VALUE rather than raising. `coalesce` deserves equal
scrutiny — `coalesce(x, 0)` in a balance is the same act as `else` in a
branch: it turns "unknown" into a number and loses the distinction. Not
started; scheduled after Blocks 5–9.

#### The distinction between a control and a claim

`0317` added a gate refusing a payroll run whose Cash payslips name no
custodian. `disburse_payroll_run()` **has no caller**, and `payroll_runs` is
empty on production. The gate is in the right place and guards a door nobody
currently walks through.

Recording that in the migration is not a caveat, it is the finding. The fix
for the eight custodian-less cash payslips is the FRONTEND writing the column;
the gate is what tells us if that stops. A control described without saying
what calls it is a claim, and this project has already found detectors that
nothing invoked (`0288`).

### 9.19 Scheduled: advance invoicing, and the check that cannot see it

**Ruling (Shayan):** AR posts at `invoice_date`; revenue at `period_start`;
`unearned_revenue` carries the interval.

```
Invoice raised in September for October service:
  Dr  Accounts Receivable      at invoice_date
  Cr  Unearned Revenue         at invoice_date
At period_start (October):
  Dr  Unearned Revenue
  Cr  Revenue
```

This preserves A4 — revenue in the service month — while recognising that the
client owes the money from the day they are billed.

Nothing on production has `invoice_date < period_start`, so there is nothing to
backfill. But `clients.advance_payment` exists and `run_auto_invoices` reads it
to bill the current month rather than the previous one, so **the first
advance-billed client creates the first instance.**

The reason this needs its own check: `ar_control_equals_open_invoices` cannot
see it. Both sides of that comparison move together at whatever single date the
entry used, so it stays green while revenue sits in the wrong month. A check
comparing two figures that are computed from the same entry is blind to when
that entry was dated — the same family as 9.15, two errors that cancel.

**Scheduled after Blocks 5–9. Not folded into the deployment.**
