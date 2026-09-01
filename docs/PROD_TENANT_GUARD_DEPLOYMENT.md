# Production deployment — the tenant guard group

**Status: PREPARED. NOT APPLIED. REHEARSAL BLOCKED — the preview branch requires
the Pro plan (see §5). No gate has run.**

**Rollback capture taken:** `supabase/rollback/prod_secdef_functions_20260901.sql`,
257 functions, md5 `28cbd4912d69b3cf96f5378bea585dd1`, commit `4beae55`.

Target: `crm-design` (`mmkfpnshxjcyijhuydgr`). Nothing in this document has been
run against production. Every figure below comes from **reading** production —
catalogue queries and read-only RPC calls — which CLAUDE.md permits and which is
how the defect was found.

**The ledger work does not ride along.** This deploys alone: no posting rules, no
`ledger_checks` changes, no data. Every migration here replaces function bodies
and adds comments. **The group writes no rows to any application table.**

---

## 1. Why

`authenticated` on production can read other companies' data through the RPC
surface. Demonstrated, not inferred, as `sa@sandbox.test` against a different
company, using only `provolatile in ('s','i')` functions:

```
avg_monthly_net_payroll(GUARDS AND GUIDES (PVT) LTD) = 0
count_client_employees(<their client>)               = 18
effective_salary(<their employee>, today)            = (40000.00, 0.00, 1290.32, 2026-06-29)
```

Another company's client headcount, and an individual's salary, day rate and
effective date, returned to an account that sees **zero** of their rows through
any table:

```
as sa@sandbox.test, role authenticated, foreign-company rows visible:
employees 0   clients 0   journal_entries 0   invoices 0
payslips  0   bank_accounts 0   profiles 0    companies visible: 1 of 4
```

Table RLS holds. SECURITY DEFINER gets no caller RLS — that is what the mode
means — so the RPC surface is a separate boundary and it is open:

```
assert_same_company on prod                                          0
SECURITY DEFINER functions taking a uuid, callable by authenticated 140
...with no current_company_id / is_ssa_unscoped check               138
...of those, that WRITE                                              77
```

**Scope: every authenticated user of every company on production.** Four
companies today. Removing the sandbox login closes none of it.

`0241` closed `anon` (0 functions executable by `anon` on prod today, verified).
`authenticated` was never closed, because the migration that closes it is
dev-only.

---

## 2. Manifest

> ## READ THIS BEFORE READING THE DEPLOYMENT LOG
>
> **STEPS 1–3 APPLYING CLEANLY IS NOT PROGRESS. IT IS NOT EVIDENCE OF ANYTHING.**
>
> The guard is a **no-op** until `0285` lands. `assert_same_company` exempts its
> caller on a test that matches every caller until `0242c` fixes it, so through
> steps 1–3 nothing can refuse and nothing can break — including nothing that
> *should* refuse. Three green steps in a row mean the SQL parsed. They do not
> mean the deployment is working, and they say nothing at all about whether the
> leak is closed.
>
> Anyone watching the log will see three passes and conclude it is going well.
> **The deployment has done nothing until step 4.** Every behavioural risk, every
> possible refusal of legitimate traffic, and the entire point of the exercise
> begin there.
>
> If the deployment is stopped after step 3 for any reason, production is exactly
> as exposed as it was before it started, while carrying 135 functions that call
> a guard which does not guard. That is a worse state than not starting, because
> it looks fixed.

Seven migrations, in this order. Every one is already applied and exercised on
`crm-design-dev`.

| # | migration | what it does | may it be skipped |
|---|---|---|---|
| 1 | `0242_tenant_guard` | creates `assert_same_company`; generates a guard into 133 function bodies in two labelled patterns | no |
| 2 | `0242b_tenant_guard_handwritten_two` | the two functions 0242's predicate skipped; also closes `record_invoice_payment`'s existence oracle and `post_manual_journal`'s unchecked `p_branch_id` | no |
| 3 | `0243_tenant_guard_gaps` | `tenant_guard_gaps()`, the standing check that makes this hold for the 134th function | no |
| 4 | **`0285_tenant_guard_prod_activation`** — `0242c` + `0248` fused, one transaction | **makes the guard actually fire, and NULL-tolerant in the same commit** | **NO — see below** |
| 5 | `0251_tenant_guard_gaps_per_parameter` | the check asks about every tenant-scoped parameter, not just the first | no |
| 6 | `0252_second_resolver_map` | guards the remaining 29 parameters; `assert_branch_in_company`; `fund_region` self-funding check | no |

Six steps, seven migrations: step 4 is `0242c` and `0248` fused into a single
migration so the guard cannot be live and NULL-intolerant even for an instant.
The reasoning is in §4; the decision was taken deliberately and the two
migrations' text is carried verbatim, in order, with nothing rewritten.

### 0242c is not optional, and it is the reason the other six matter

0242's helper exempted trusted backends with

```sql
if current_user not in ('authenticated', 'anon') then return; end if;
```

**SECURITY DEFINER sets `current_user` to the function owner.** Every guarded
function is owned by `postgres`, so the exemption matched for every caller and
the guard returned without checking anything. Measured on dev at the time:

```
as authenticated, outside a definer function : current_user = authenticated
inside a definer function                    : current_user = postgres
```

Deploying 1–3 and stopping produces 135 functions that call a guard which never
guards — the leak intact, with the appearance of a fix. **0242c is what converts
this deployment from theatre into a control.**

Note the sequencing consequence, which is also the safety property: **items 1–3
are inert.** Until 0242c lands, the guard is a no-op, so nothing can be refused
and nothing can break. All behavioural risk begins at item 4.

---

## 3. Dependency check — does prod have what the group needs

Run against production. Every gate clean.

**Helpers the group calls, all present:** `current_company_id`,
`is_ssa_unscoped`, `region_for_client`, `fund_region`, `same_company_branch`,
`record_invoice_payment`, `post_manual_journal`, and all seven exempt-list
functions (`user_can_see_employee`, `can_see_region`, `employee_in_branch`,
`is_action_approved`, `employee_company_id`, `has_perm`, `has_permission`).
`assert_same_company`, `assert_branch_in_company`, `tenant_guard_gaps` and
`tenant_guard_covered` are absent, as expected — the group creates them.

**0242's own preconditions, evaluated against prod's catalogue:**

| gate | what it refuses to proceed past | prod |
|---|---|---|
| 4a | a resolver-map table without `company_id` | none — all 25 present |
| 4b | a plpgsql body whose first `begin` is missing or inside a string literal | none |
| 4c | a SECURITY DEFINER body containing the `$function$` delimiter | none |
| 4d | a first-uuid parameter with no entry in the resolver map | none |

**Hard-coded expectations in the verify blocks — these are the ones that abort a
deployment, and they were written against dev.** Predicted for prod:

| assertion | requires | prod predicts |
|---|---|---|
| 0242: `v_resolved >= 50` | ≥ 50 | **74** |
| 0242: `v_claimed >= 40` | ≥ 40 | **59** |
| 0243: guarded functions `>= 120` | ≥ 120 | **135** |
| 0251: gap params `= 29` | exactly 29 | **29** |
| 0251: gap functions `>= 15` | ≥ 15 | **21** |
| 0252: functions carrying a second-map guard `>= 15` | ≥ 15 | **21** |
| 0252: `tenant_guard_gaps()` = 0 afterwards | 0 | every one of the 29 gap parameters is in 0252's map — **no unmapped parameter** |

The `= 29` is the one that could have been an ambush: an exact equality written
against dev's catalogue. Prod predicts exactly 29 across 21 functions. That is
not luck — it says prod and dev have the same SECURITY DEFINER shape — but it is
also the single most fragile line in the group, and the rehearsal exists to
observe it rather than predict it.

**Fixtures the verify blocks need, all satisfiable on prod:** 4 companies;
2 with both a client and a non-SSA profile (0248, 0249-style tests need one);
3 with both a branch and a non-SSA profile (0252); 6 non-SSA profiles.

**The one function on prod that dev has never exercised:** `guard_completeness`.
It exists on prod and was dropped from dev by `0278`. 0242 will guard it —
`p_employee_id` → `employees`, a mapped parameter, the ordinary `[resolved]`
path. It is dead code on prod (nothing calls it; it scores every employee 0),
so guarding it is inert, but it is the only rewrite target in this deployment
that no dev run has covered. Named here so it is not a surprise in the diff.

Everything else is one-directional: 16 functions exist on dev and not on prod
(the ledger work), and the guard simply will not apply to them.

---

## 4. The one window where legitimate traffic can be refused

This is the failure mode the whole rehearsal is designed around, and it has a
precedent one layer down: `0268` proved its constraint could refuse a bad cash
receipt and never proved a good one still worked, and **every cash receipt
through the application was refused for the next thirteen migrations.**

Here the same shape is structural rather than accidental:

* **0242 and 0242b emit guards that are not NULL-tolerant.** A `[claimed]` guard
  is `perform assert_same_company(p_company_id);` and `assert_same_company`
  raises on NULL by design — that is the no-existence-oracle property and it must
  not change.
* **`region_for_client(NULL)` is a normal call.** An expense need not belong to a
  client, and twelve functions call it. On dev, 0242 broke **every expense
  insert** this way. That is what 0248 exists to fix.
* **0248 must land after 0242c**, not before. Its own verification asserts that a
  *foreign* client id is still refused with `Row not found` — which only happens
  once the guard actually fires. Applied before 0242c, 0248's self-test fails and
  the migration aborts.

So the order is forced, and between item 4 and item 5 there is a window in which
the guard is live and NULL is not tolerated. **In that window, any legitimate
call passing an optional tenant-scoped id as NULL is refused.**

Two ways to close it. Both are put to you rather than chosen:

**(a) Fuse 4 and 5 into one migration for the production deployment.** A single
`0285_tenant_guard_prod_activation.sql` containing 0242c then 0248 verbatim,
applied as one transaction, so the guard becomes live and NULL-tolerant in the
same commit. The window becomes zero. Cost: prod's ledger records `0285` and not
`0242c`/`0248`, so `check-migrations.mjs` will report two repo files unrecorded
on prod until the two rows are backfilled with their own text — which is
accurate, because their text is exactly what ran.

**(b) Apply all seven in sequence and accept a window of seconds**, in a
low-traffic period, with 0248 queued and ready. Simpler, records the ledger
honestly with no extra artifact, and the exposure is a handful of seconds of
possible refusals rather than a wrong state.

**DECIDED: (a). Approved 2026-09-01.** The window is short but the failure is
user-visible and silent-looking — an operator gets `Row not found` from a form that has nothing to
do with rows not being found. Seconds of that is worth one deliberate artifact.

No other window exists. Items 6 and 7 are safe by construction: 0251 is
read-only, and every guard 0252 emits is NULL-tolerant (`if X is not null then …`
for resolved parameters, and `assert_branch_in_company` returns early on NULL).

---

## 5. Rehearsal — on a branch, before production

A Supabase **preview branch off `crm-design`** gives a copy of production's
schema to run the sequence against. Branch cost **approved 2026-09-01**.

### BLOCKED — the preview branch cannot be created, and it would not have been enough

Attempted 2026-09-01, cost confirmed at **$0.01344/hour** for this organization:

```
create_branch(crm-design, "tenant-guard-rehearsal")
  -> PaymentRequiredException: Branching is supported only on the Pro plan or above
```

The cost was approved; the capability is gated by plan, not by price. The
organization holds five projects — `crm-design`, `crm-design-dev` and three
paused — and is not on Pro.

**Nothing was created and nothing was charged.** No gate ran.

#### A second problem with the branch approach, worth knowing before paying for it

`create_branch` "will apply all migrations from the main project to a fresh
branch database" and **"production data will not carry over"**. Both halves
matter, and the second is the one that would have stopped the rehearsal even on
Pro:

**Every migration in this group self-tests against live rows.** They were written
that way deliberately — a guard proved only by inspection is not proved — and on
an empty database they do not pass, they *abort*:

| migration | what its verification needs | on an empty branch |
|---|---|---|
| `0242c` (in `0285`) | two companies and a non-SSA profile | raises `0242c cannot self-test` |
| `0248` (in `0285`) | a client in another company; a bound tenant identity | the foreign-id and non-existent-id refusals cannot be exercised — with no JWT claims the guard exempts the caller and the assertion fails |
| `0252` | two companies with branches; `fund_region` callable | cannot select a branch; self-funding probe unreachable |

So a branch would need fixtures seeded first: at least two companies, a non-SSA
profile in each, a client in each, a branch in each, and one employee. That is
synthetic data on a throwaway database, which is fine — but it must be planned
and written, not improvised at deployment time, and **the rehearsal then proves
the group against fixture data rather than against production's shape**.

#### What the D0 capture is now also for

If a branch is ever created, the first thing to run against it is not gate 1. It
is a fidelity check: dump the branch's SECURITY DEFINER functions with the same
expression that produced
`supabase/rollback/prod_secdef_functions_20260901.sql` and compare the md5 to
`28cbd4912d69b3cf96f5378bea585dd1`.

A branch is built by **replaying prod's recorded migrations**, not by copying
prod's current schema. All 254 prod rows do carry their SQL, which is the good
case — but CLAUDE.md records that `0231`, `0231b` and `0232` were applied through
the SQL editor, which writes no `schema_migrations` row at all. Anything in that
class is absent from the replay, and the branch would differ from production in
exactly the way nobody would think to check. **Equal md5 means the rehearsal is
about production. Unequal means it is about something else, and the difference
has to be read before any gate result is believed.**

#### Options, with honest costs

1. **Upgrade the organization to Pro.** Restores the planned rehearsal. The
   branch itself is $0.01344/hour; the plan price is Supabase's and is not quoted
   here because it has not been verified. Still needs fixture seeding and the
   fidelity check above. **Recommended** — it is the only option that rehearses
   the real sequence on a real replay of production.

2. **Rebuild production's schema into a scratch project.** Free-tier projects
   exist, but production's ledger is **254 migrations and 1,058 kB of SQL**, and
   there is no database-to-database channel here: each migration would have to be
   read out of prod and pushed up individually, roughly 254 calls and a megabyte
   of transcription. It would still arrive with no data and need the same
   fixtures. Slow, expensive, and it earns nothing the branch would not.

3. **Deploy to production without a rehearsal.** Not recommended and not
   proposed. The failure mode this group has already produced once on dev is a
   guard that refuses legitimate traffic — `0242` broke every expense insert —
   and the whole reason `0285` exists is that the same shape is reachable here.
   Rehearsing is what turns `0251`'s hard-coded `= 29` from a prediction into an
   observation.

4. **Rehearse the reversible parts on dev.** Cheap, and worth stating precisely
   so it is not mistaken for the rehearsal: dev already carries the entire group,
   so re-running it proves idempotency and nothing about a pre-guard database.
   Dev cannot be returned to the pre-guard state without restoring 257 function
   bodies onto a schema that has since moved on 23 migrations. It would be
   rehearsing on a database that is neither dev nor prod.

---

### The gates, when a substrate exists

Seven gates. **If any gate fails, stop and report — do not proceed to the next.**

1. **The sequence applies.** All seven, in order, no migration aborting. This is
   what turns the `= 29` prediction into an observation.
2. **The refusing direction.** Re-run the three demonstrated calls against a
   foreign company. Each must raise `Row not found` (SQLSTATE 42501), and all
   three must raise the *same* message — a different message for "no such row"
   versus "not your row" reinstates the existence oracle 0242b closed.
3. **The permitting direction, which is the half that matters here.** Per §9.9,
   a guard proved only by what it refuses is half proved:
   * the same three calls against the caller's **own** company still return data;
   * `region_for_client(NULL)` does not raise;
   * **an expense insert with no client succeeds** — the exact regression 0242
     caused on dev;
   * a cash receipt through `record_invoice_payment` succeeds — the exact shape
     of the 0268 regression, one layer down;
   * `post_manual_journal` with `p_branch_id = NULL` succeeds.
4. **`supabase/tests/tenant_guard.sql` passes on the branch**, with its count
   assertion satisfied — the harness must prove it ran, not merely not fail.
5. **`tenant_guard_gaps()` returns zero rows**, and is shown able to return more
   than zero by removing one guard and re-running, so the final green is not
   vacuous.
6. **The application, not just SQL.** Log in against the branch and exercise the
   paths most likely to pass a NULL: create an expense with no client, create an
   advance, raise an alert with no branch, request an approval. A P0001 or a
   `Row not found` surfacing in a toast is a fail even if every SQL test passed.

7. **`guard_completeness` specifically, by name.** It is the **only rewrite
   target in this deployment that no dev run has ever covered** — it exists on
   production and was dropped from dev by `0278`, so every dev proof of 0242
   was taken against a catalogue that did not contain it. It is dead code
   (nothing calls it; it scores every employee 0) and its parameter is the
   ordinary mapped `p_employee_id` → `employees`, so the expectation is that it
   is inert. Untested is untested: after the sequence, confirm on the branch
   that its body carries a `[resolved]` guard, that it still returns without
   raising for an employee of the caller's own company, and that it refuses one
   from another. Report it as its own line, not folded into a count.

Only after all seven does production get scheduled.

---

## 6. Verification against production, after

Externally, through PostgREST with production's own anon key and a real user
session — not through this agent's service-role connection, which bypasses
exactly what is being tested. The negative direction and the positive direction
are both required.

```
NEGATIVE — must now refuse, all three, with identical messages
  POST /rest/v1/rpc/avg_monthly_net_payroll  {"p_company":"<other company>"}
  POST /rest/v1/rpc/count_client_employees   {"p_client_id":"<their client>"}
  POST /rest/v1/rpc/effective_salary         {"p_employee_id":"<their employee>", ...}
  expect: 42501 "Row not found" on each

POSITIVE — must still work, same session
  the same three calls against the caller's OWN company: data returned
  an expense insert with client_id NULL: accepted
  a cash receipt through the invoice payment screen: accepted
  the payroll and invoice screens: unchanged
```

**This needs a credential that does not exist in this repo.** `.env.local` and
`.env.development.local` carry anon keys, which is enough for the PostgREST
calls but not to log in as a real user; a test account on a real production
company is required, and creating one is a production data decision.

---

## 7. Rollback

There is no `drop` that undoes this: 0242 rewrites function bodies in place, and
the pre-guard bodies exist only in whatever the catalogue held before the run.

* **The capture is taken. This is done.**
  `supabase/rollback/prod_secdef_functions_20260901.sql` — 257 functions,
  326,065 characters, md5 `28cbd4912d69b3cf96f5378bea585dd1`, committed
  `4beae55`. That dump *is* the rollback and there is no other one. It was
  base64-encoded by Postgres and decoded locally rather than transcribed,
  because 123 CR characters live inside function bodies and a hand-copy would
  have dropped them without failing anything. See
  `supabase/rollback/README.md`.
* **The cheap partial rollback is 0285’s half of 0242c.** Reverting the helper to a form that
  returns unconditionally disables all 135 guards in one statement without
  touching a single rewritten body. It restores the leak, which is the point —
  it is an emergency lever for "the guard is refusing legitimate traffic and we
  need the product working", not an undo.
* **`tenant_guard_gaps()` and `assert_same_company` can simply be dropped**; the
  guarded bodies then fail on a missing function, which is worse than the leak,
  so this is not a rollback path. Use the dump.

---

## 8. What this deployment deliberately leaves open

* **`is_action_approved` stays exempt** and does leak a boolean about another
  company's `ref_id` — no amounts, no names. Polymorphic `(p_ref_table,
  p_ref_id)`; closing it needs a per-`ref_table` resolver, which is its own
  change. Already logged as a residual.
* **The ledger work stays on dev.** Migrations 0237–0284 minus this group are not
  part of this deployment and their prod gap is unchanged.
* **`sa@sandbox.test` is not addressed here.** It is a separate decision and this
  deployment does not depend on it — but it also does not fix it, and the account
  remains a super-admin credential on the production auth tenant.

---

# S1 — APPLIED TO PRODUCTION, 2026-09-01

`0242`, `0242b`, `0243` applied to `crm-design` (`mmkfpnshxjcyijhuydgr`) under
named authorisation. Each migration's own verification block ran inside its
transaction and passed.

## Recorded SQL equals the file — checked, not assumed

Migration text cannot bypass context on the way IN, so all three were
retyped into `apply_migration`. The digest check written in the previous round
is what makes that safe, and this is its first use in anger:

| migration | version | file md5 | recorded md5 |
|---|---|---|---|
| `0242_tenant_guard` | `20260831233913` | `f8bcb6cf53b973f36d7b321c49b0eaac` | **equal** |
| `0242b_tenant_guard_handwritten_two` | `20260831234010` | `21a765c236e352c7bef89c2db4b8d301` | **equal** |
| `0243_tenant_guard_gaps` | `20260831234055` | `eb5933127b925192eca454f599ed8b31` | **equal** |

Three for three. No transcription error.

## Observations against S0's predictions

| | predicted | observed |
|---|---|---|
| `[resolved]` guards after `0242` | 74 | **74** |
| `[claimed]` guards after `0242` | 59 | **59** |
| `[resolved]` after `0242b` (+2) | 76 | **76** |
| functions carrying a guard | 135 | **135** |
| `tenant_guard_gaps()` (0243 per-function form) | 0 | **0** |

**The 136 in the raw count is not a discrepancy.** 133 rewritten by `0242`,
2 by `0242b` = 135 functions carrying a guard, plus `tenant_guard_gaps()`
itself, whose body contains the string `assert_same_company` because it
searches for it. Confirmed by naming the one function that matches on the
string but carries no `tenant guard [` marker: it is `tenant_guard_gaps`.
Stated because "predicted 135, got 136" is the shape of an ambush, and this
one is a counting artefact with a name.

`guard_completeness` — the rewrite target no dev run has ever covered, dropped
from dev by `0278` and still live here — **was rewritten**, and `0243`'s check
passes over it.

## THE POINT OF THIS STAGE: behaviour is unchanged, and the leak is still open

Captured before S1 and again after, through the same channel that demonstrated
the leak — `set local role authenticated` with `sa@sandbox.test`'s claims,
read-only calls only:

```
                              BEFORE S1        AFTER S1
avg_monthly_net_payroll(foreign co)   0               0
count_client_employees(foreign client) 2              2
effective_salary(foreign employee)    {40000.00, 0.00, 1290.32, 2026-06-29}   identical
employees rows via TABLE (foreign)    0               0
```

Identical. **Production is exactly as exposed as it was this morning.** 135
functions now call a guard that returns without checking anything, because
`current_user` inside SECURITY DEFINER is the owner and `0242`'s helper exempts
it. That is `0242c`'s bug, reproduced here deliberately and on purpose.

Three green steps are not progress. This one is worth exactly one thing: the
rewrite landed without changing behaviour, so any behaviour change at S2 is
attributable to S2.

## Permitting-direction baseline, captured while the guard is inert

For comparison at S2, when these must still succeed:

```
region_for_client(NULL)            -> NULL   (does not raise)
count_client_employees(OWN client) -> 25
```

## Not done, deliberately

No V1 account was created — per plan it is created at the start of S2. No
write path was exercised on production. `0285`, `0251`, `0252` not applied.

---

# S2 — APPLIED TO PRODUCTION, 2026-09-01. THE LEAK IS CLOSED.

0285 (fused 0242c + 0248) applied to crm-design under named authorisation.
Both embedded verification blocks ran inside the single transaction and
passed. **The emergency lever was not needed.**

## Environment note, because it nearly mattered

This stage was run from a different checkout than S0/S1. Local `dev` was 16
commits behind `origin/dev` and carried **none** of the deployment artifacts —
no `supabase/rollback/`, no `0285`, no `.gitattributes`. Applying 0285 from
that state would have meant deploying with no rollback capture and no
emergency lever, which is precisely what S0 exists to prevent.

Caught by checking for the artifacts before using them rather than assuming
the working tree matched the plan. Resolved by pulling `origin/dev`.

**The `.gitattributes` written in S0 earned its place on the first try.** The
D0 capture crossed two machines, both with `core.autocrlf=true`, and arrived
byte-exact: md5 28cbd4912d69b3cf96f5378bea585dd1, 257 markers, all 123
embedded CR characters intact.

One false alarm worth recording: the first 0285 integrity check reported both
embedded blocks as DIFFERING from their sources. They did not. The marker
strings used to slice the file contain newlines, the freshly-checked-out file
has CRLF, so the markers were never found and the slices were garbage.
Normalising first gave 873c87f1 and f50007b5 — the exact digests dev's ledger
records. **The instrument was broken, not the artifact** — the same class as
the CRLF finding in 9.10 and the comment-stripper artefact in the four-diffs
audit. Third instance.

## Recorded SQL equals the file — four for four

0285_tenant_guard_prod_activation, version 20260901002831,
file md5 = recorded md5 = ab2a30526315f600a3e36ce13ca3357e.

## V1 — created, used, removed, all in this session

    uid     deadbeef-0000-4000-8000-000000000001
    email   v1-guard-verify@bastion.test
    role    accounting  (minimum: RLS here is company-scoped, not role-gated)
    company GUARDS AND GUIDES (PVT) LTD
    branch  NULL (unbranched, so branch_scope policies pass trivially)

Created by hand in auth.users + auth.identities + public.profiles. GoTrue
first refused sign-in with "Database error querying schema" — its Go model
scans the token columns into non-nullable strings, so the hand-inserted NULLs
had to be set to empty strings. Recorded because the next person to create a
user this way will hit it.

**Removed at the end of this session**: profile, identity, session and auth
user all deleted, one row each. Sign-in now returns invalid_credentials.

Its still-unexpired JWT was retested after deletion and is **inert** — no
profile means current_company_id() is NULL, so the guard refuses it. Revoking
the profile revokes the access, not merely the login.

## 3. PERMITTING DIRECTION — checked first, with the guard live

As V1, with V1's claims bound, **inside a transaction that was rolled back**,
so nothing persisted on real customer data. Verified after: zero probe rows
survive.

    check                                       before 0285   after 0285
    expense insert, client_id NULL                   OK           OK
    cash receipt via record_invoice_payment          OK           OK
    post_manual_journal, p_branch_id NULL            OK           OK
    region_for_client(NULL)                          OK           OK
    count_client_employees(OWN client)               OK           OK

GUARDS AND GUIDES has no invoices and no bank accounts, so the cash-receipt
probe built its own prerequisites inside the same rolled-back transaction. An
earlier failure in that probe was a missing account_type on my fixture, not a
guard refusal — distinguished rather than counted.

**The 0242-on-dev regression did not recur. No lever pulled.**

## 4. REFUSING DIRECTION — through production's real HTTP channel

Real password sign-in against production auth, real JWT, real PostgREST — not
the agent's service-role connection, which would have bypassed the thing under
test.

    call                                 BEFORE 0285                      AFTER 0285
    avg_monthly_net_payroll(foreign)     0                                42501 Row not found
    count_client_employees(foreign)      2                                42501 Row not found
    effective_salary(foreign employee)   40000.00 / 1290.32 / 2026-07-01  42501 Row not found

    count_client_employees(OWN)          2                                2
    effective_salary(OWN employee)       52965.00 / 1708.55 / 2026-08-05  identical
    avg_monthly_net_payroll(OWN)         0                                0
    region_for_client(NULL)              null                             null

**No-oracle property holds**, tested explicitly — a foreign id and a
non-existent id return byte-identical responses on both functions. A third
tenant (SANDBOX TESTING ORG) is refused the same way, so this is not a
two-company artefact.

## 5. The application layer as V1

Every screen's data layer loads: employees 552, clients 43, branches 4,
chart_of_accounts 51; expenses, invoices and journal_entries empty, which is
correct for this company. Cross-tenant table reads still return zero rows —
RLS unchanged, as expected.

**Honest limit: this is the application's data layer, not its rendered UI.** A
human still needs to click through the NULL-passing forms — new expense with
no client, cash receipt, manual journal with no branch — and confirm no
"Row not found" reaches a toast. Every RPC and table call behind those forms
is proved above; the rendering is not.

## Final state

    tenant_guard_gaps()                      0
    functions with a NULL-tolerant guard   135
    functions carrying a guard             136   (135 + tenant_guard_gaps itself)
    assert_same_company                    0242c form (JWT claims, not current_user)

ledger_checks() on prod reports one failure, no_billing_clients_on_head_office
= 1. Pre-existing and unrelated: 0285 executed only CREATE OR REPLACE FUNCTION
and a COMMENT ON, and wrote no application rows.
