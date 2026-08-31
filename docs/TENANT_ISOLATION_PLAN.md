# Tenant isolation — how to test it, and what is already broken

**Plan only. Nothing here is built.**

No test in this project has ever verified tenant isolation. Every suite runs as
`postgres`, which carries `rolbypassrls`, so every RLS policy is bypassed and
any isolation assertion would report PASS with the policies deleted.

Looking for a way to test it turned up three confirmed cross-tenant write holes
that need no test to demonstrate. They are in §0.

---

## §0 — Confirmed holes, found while writing this plan

These are not "untested". They are reproducible now, on production.

### 0.1 Three SECURITY DEFINER RPCs mutate by id with no tenant check

`SECURITY DEFINER` runs as the function's owner. **The caller's RLS does not
apply inside it** — that is the entire point of the mode. So a definer function
that does not check `company_id` itself has no tenant boundary at all.

```sql
-- verify_employee_identity(p_employee_id uuid)  — SECURITY DEFINER, EXECUTE to authenticated
update public.employees
   set identity_verified = true, identity_verified_at = now(),
       identity_verified_by = auth.uid(), updated_at = now()
 where id = p_employee_id;          -- no company_id, no permission check
```

Any authenticated user of any tenant can mark any employee in **any company**
identity-verified, given only that employee's UUID.

```sql
-- release_final_dues(p_employee_id uuid)
-- checks clearance status only; no tenant check
-- disburse_payroll_run(p_run_id uuid)
-- checks status = 'approved' only; then marks the run and its payslips disbursed
```

`disburse_payroll_run` is the worst of the three: it flips another company's
payroll run to disbursed and updates its payslips.

These three were **sampled** from a list of 46. The other 43 are unreviewed.

### 0.2 Two tables have RLS switched off entirely, with full grants to `anon`

| Table | RLS | `anon` grants | Tenant data? |
|---|---|---|---|
| `deployments_overlap_backup_0183` | **disabled** | SELECT, INSERT, UPDATE, DELETE, TRUNCATE | **yes — has `company_id`** |
| `org_copy_map_0186` | **disabled** | SELECT, INSERT, UPDATE, DELETE, TRUNCATE | id mapping |

Identical on **prod and dev**. `deployments_overlap_backup_0183` holds
deployment rows for every tenant and is readable — and truncatable — with the
anon key, which ships in the client bundle.

`employee_branch_realign_backup_20260618` has the same grants but RLS **is**
enabled with 0111's `ssa_only` policy, so it is covered. These two never got the
same treatment.

### 0.3 `signup_intents` has RLS enabled and zero policies

Deny-all for `anon` and `authenticated`. Not a leak — the opposite — but it
means anything writing it must go through a definer RPC. Worth confirming the
signup path actually does.

---

## (a) How to run a suite as a non-bypassing role

Three options exist. Recommending the second.

### Option 1 — signed JWT through PostgREST
Sign an HS256 token with the project JWT secret (`role: authenticated`,
`sub: <profile uuid>`) and issue every assertion as an HTTP request.

Genuinely exercises the production path, including PostgREST's own exposure
rules. But: no transaction, so nothing rolls back — every test writes for real;
assertions become HTTP round-trips; and it needs the JWT secret in CI.

### Option 2 — `SET LOCAL ROLE` inside one transaction — **RECOMMENDED**

```sql
begin;
  set local role authenticated;                      -- no BYPASSRLS, not the table owner
  set local request.jwt.claims = '{"sub":"<profile-uuid-in-company-A>"}';
  -- auth.uid() now resolves, current_company_id() returns company A,
  -- and every RLS policy applies exactly as it does for a real user.
  ...assertions...
  raise exception 'ROLLBACK_ISOLATION_TESTS: %', v_results;   -- rolls back
```

Why this one:

- It keeps the harness shape the project already uses — one transaction, a
  deliberate exception, nothing left behind.
- `authenticated` has neither `rolsuper` nor `rolbypassrls` and does not own the
  tables, so policies bind. **`FORCE ROW LEVEL SECURITY` is not required for
  this to work** — that setting only matters for the owner.
- SECURITY DEFINER functions still run as their owner, which is precisely the
  behaviour §0.1 needs to catch.
- `set local role` reverts at commit or rollback, so a failed run cannot leave
  the session privileged.

One caveat that must be designed around: the suite has to `set local role
postgres` (or `reset role`) before its final `raise`, or the rollback message
and any catalog reads run as `authenticated` and may themselves be blocked. The
fixtures must also be created **before** dropping to `authenticated`.

### Option 3 — Supabase CLI local stack + pgTAP
`supabase start`, `supabase test db`. The standard answer and the right CI
target eventually. Needs Docker, a seeded local database, and the migration
replay to work end to end — which, given the 27 prod-only migrations and dev's
unbacked ledger, it currently does not. Revisit after the ledger work lands.

**Recommendation: Option 2 now, Option 3 as the CI target once a from-scratch
replay is trustworthy.**

---

## (b) FORCE ROW LEVEL SECURITY — the full list

**Zero tables have it. On either environment.**

| | dev | prod |
|---|---:|---:|
| Tables in `public` | 136 | 137 |
| RLS enabled | 134 | 135 |
| **RLS forced** | **0** | **0** |
| RLS enabled, not forced | 134 | 135 |
| RLS disabled | 2 | 2 |

The list of tables lacking FORCE RLS is therefore every table in `public`, and
enumerating 137 names adds nothing.

**What this does and does not mean.** `anon` and `authenticated` are not table
owners and have no `BYPASSRLS`, so policies **do** bind for real application
users today. The absence of FORCE RLS is not by itself a live tenant leak.

What it does mean: any session running as the owner — `postgres`, `service_role`,
every migration, every admin script, and every existing test — silently ignores
every policy. That is why no test has ever verified isolation, and it is why a
future test could pass against deleted policies.

Turning FORCE RLS on is a real behaviour change for `service_role` paths and
must not be done casually. The isolation suite does not need it (see (a) Option
2). Treat it as a separate, later decision.

---

## (c) What the isolation suite must assert

Two companies, A and B, with a fixture row in each. Acting as a profile in A:

**Per company-scoped table** (~130 of them, generated rather than hand-written):

1. `select` returns **zero** of B's rows.
2. `insert` of a row carrying B's `company_id` is refused — or silently
   rewritten to A's by `fill_company_id`, which must then be asserted, because
   "it worked" and "it was redirected" are different outcomes.
3. `update` of B's row by primary key affects **zero rows**.
4. `delete` of B's row affects **zero rows**.

Points 3 and 4 need `get diagnostics ... row_count`. An UPDATE filtered away by
RLS raises nothing and reports success — the same zero-row trap as T31.

**Per view** (38): a view without `security_invoker = true` runs as its owner and
ignores the caller's policies entirely. Assert the flag on every view, then
assert each returns none of B's rows.

**Per SECURITY DEFINER RPC** (the 46 in (d), then the rest): call it with B's id
from a session in A. It must refuse. This is where the leaks are.

**Negative control, mandatory:** the same suite, acting as B, must SEE B's rows.
Without it every assertion passes against a database where the fixtures were
never created — the vacuity lesson applied to isolation.

---

## (d) SECURITY DEFINER inventory

279 functions in `public`. **257 are SECURITY DEFINER. 254 are executable by
`anon` or `authenticated`.**

Broken down (production):

| Class | Count | Assessment |
|---|---:|---|
| Trigger functions | 83 | Not directly callable; run in the writer's transaction. Lower risk. |
| No-argument session helpers | 13 | `current_company_id`, `has_perm`, `is_ssa_unscoped`, … Derive scope from `auth.uid()`; correct by construction. |
| Take an id **and** reference `company_id` | 112 | Filter internally. Need review that the filter is on the *caller's* company, not merely present. |
| **Take an id and never mention `company_id`** | **46** | **The hole.** Nothing scopes them to the caller. |

The 46 are listed in full below. Three were sampled and all three are
exploitable (§0.1), so the base rate is not reassuring.

Highest priority within the 46 — those that **mutate**:

```
acknowledge_alert            approve_bonus_pool           disburse_payroll_run
launch_site                  mark_form_signed             reassign_client_employee_codes
release_final_dues           set_performance_enrollment   transition_appraisal
transition_payroll_run       verify_employee_identity
```

Read-only but still leaking, if they return another tenant's data:

```
ai_credit_available          ai_credit_status             armed_post_blockers
assert_cheque_capacity       attendance_billable_quantity attendance_billing_suggestion
attendance_leave_history     attendance_payroll           attendance_window_block_reason
bonus_proration              can_see_region               can_work_armed_post
client_service_report        client_shift_roster          count_client_employees
deployment_client_on         effective_salary             employee_clearance_gates
employee_in_branch           has_perm                     has_permission
is_action_approved           kpi_score_for_appraisal      no_show_count
opening_batch_totals         partner_client_breakdown     payslip_client_split
receivable_owner_region      region_for_client            region_for_employee
region_for_post              regional_pl                  run_unacked_exception_count
tasks_on_time_pct            user_can_see_employee
```

Some of these are authorisation helpers whose job is to answer a question about
an arbitrary id (`user_can_see_employee`, `can_see_region`, `has_perm`) and are
correct as they stand. Each needs a verdict recorded, not an assumption — the
point of the list is that **no one has ever gone through it**.

### The rule to apply

A `SECURITY DEFINER` function that accepts an id must resolve that id's
`company_id` and compare it to `current_company_id()`, refusing on mismatch.
There is no caller RLS to fall back on. A shared helper —
`assert_same_company(p_company_id uuid)` — would make the check one line and
make its absence visible in review.

---

## Sequence

1. Fix §0.2 now: enable RLS on the two tables, or drop them. Cheap, no
   dependencies, and one is anon-truncatable on production.
2. Fix §0.1's eleven mutating RPCs. Highest severity.
3. Build the harness from (a) Option 2, with the negative control.
4. Generate the per-table assertions in (c).
5. Work the 46 in (d) to a recorded verdict each.
6. Decide on FORCE RLS separately.
