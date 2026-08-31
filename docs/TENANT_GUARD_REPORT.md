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