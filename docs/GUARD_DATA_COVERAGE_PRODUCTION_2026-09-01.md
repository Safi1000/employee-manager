# Guard data coverage — active employees, production

Run **2026-09-01** against `crm-design` (`mmkfpnshxjcyijhuydgr`), **read-only**.
Nothing was written to production to produce this.

For Shayan, to hand to Safi.

Started as a list of expired CNICs. It is broader than that, because the same
shape turned up in every other guard field measured: the number that matters is
not what the data says, it is how little of it there is.

## This is a BACKLOG measure, not a compliance failure

Confirmed by Shayan: **the vetting is happening, on paper, and none of it has
reached the system.** Uploads begin once the current work lands.

So every number below is a **target list for that upload**, not a finding about
how the business operates. The gap closes by data entry, not by process change.

**Re-run this report after the upload.** It is the only way anyone will know
the backlog is finished, and the completion signal is specific:
`cnic_expiry_coverage` going green in `ledger_checks()`.

## The line that reads as reassurance and is not

Below you will find **0 police-verification adverse results and 0 blacklisted
guards** on 347 active employees.

**There are almost no failures on record because there are almost no results on
record.**

Of 347 active guards, **one** has a police clearance and **two** have a NADRA
clearance. Every other police check — 346 of them — still sits at `pending`
where intake put it, and not one has ever been recorded `adverse`.

A zero in the adverse column is not evidence that nobody failed; it is evidence
that nobody has been recorded either way. Read it as an empty column, never as
a clean one.

> **An earlier version of this file said the pipeline had never produced a
> completed check. That was false**, and it is worth knowing why before you
> trust any other number here.
>
> The query counted `police_verification_status = 'verified'`. The column is an
> enum of `(pending, cleared, adverse)` — **there is no `verified`**. It was a
> count of a value the column cannot hold, so it could only ever return zero,
> and zero read like an answer.
>
> Three results out of 347 does not change the size of the backlog. It changes
> what may be said about it. The figures in this file are now taken from
> `public.vetting_dashboard`, the view that computes the same coverage in the
> vocabulary the data actually uses.

---

## Correction to the figure I reported earlier

I said **twenty**. The correct number is **ten**.

The query I ran first counted twenty rows, but production holds **two company
records for the same business** and every employee exists in both. Twenty rows,
ten people.

| company | ref | employees | users | last login | last attendance |
|---|---|---|---|---|---|
| `GUARDS AND GUIDES (PVT) LTD` | `7f7899a0-…c68d1e` | 552 | 4 | 2026-08-31 | 2026-08-31 |
| `guards n guides` | `f706043b-…f8d2a` | 527 | **0** | **never** | 2026-08-13 |

`guards n guides` was created 2026-08-13, has **no user accounts**, has never
been logged into, and its attendance stops on the day it was created. **234 of
its 234 employees with a CNIC share both the CNIC number and the employee code
with a row in the live company.** It is a dormant copy, not a second client.

Everything below is the **live** company only. The dormant copy is raised
separately at the end — it is not a compliance item, but it is not nothing.

---

## The ten

Ordered by how long the CNIC has been expired. All are `active`. All are
currently deployed.

| # | code | name | father/husband | region | client | CNIC | expired | days overdue |
|---|---|---|---|---|---|---|---|---|
| 1 | GGS-00250 | Faisal Wazir | Muhammad Saqwan | ISB/RWP | Emaar DHA ISB | 37401-1424635-7 | 2023-10-03 | **1,064** |
| 2 | GGS-00018 | Tahir Mehmood (RWP) | Muhammad Yaqub | ISB/RWP | Emaar DHA ISB | 37402-0225676-7 | 2024-04-03 | **881** |
| 3 | GGS-00247 | Hamid Iqbal (NG) | Khusal Khan | ISB/RWP | Emaar DHA ISB | 37402-0965381-1 | 2024-05-04 | **850** |
| 4 | GGS-00037 | Muhammad Akram | Shar Muhammad | ISB/RWP | Emaar DHA ISB | 38303-9287039-5 | 2025-02-20 | 558 |
| 5 | GGS-00051 | Tahir Zaman | Umar Khan | ISB/RWP | Emaar DHA ISB | 14203-0747436-9 | 2025-03-18 | 532 |
| 6 | GGS-00033 | Muhammad Naveed (RWT) 159 | Muhammad Riaz | ISB/RWP | Emaar DHA ISB | 37405-0378087-5 | 2025-03-21 | 529 |
| 7 | GGS-00066 | Touseef Zahoor | Muhammad Zahoor | ISB/RWP | Emaar DHA ISB | 37405-8474095-3 | 2025-09-14 | 352 |
| 8 | GGS-00075 | Nisar Ahmed | Muhammad Hussain | ISB/RWP | Emaar DHA ISB | 37401-4811189-5 | 2026-02-09 | 204 |
| 9 | GGS-00269 | Muhammad Nazir | Saleh Muhammad | ISB/RWP | Emaar DHA ISB | 37302-1121738-3 | 2026-03-23 | 162 |
| 10 | GGS-00038 | Abdul Ghaffar | Abdul Ghafor | ISB/RWP | Emaar DHA ISB | 37405-0495765-7 | 2026-04-11 | 143 |

Phone numbers are in the database against each code; they are left out here so
this file can be circulated.

Two rows worth a second look on their own terms:

* **GGS-00247, Hamid Iqbal** — join date `2026-04-23`, CNIC expired
  `2024-05-04`. He was taken on with a CNIC that was **already 719 days
  expired**. That is not a lapse during employment; it is an intake that should
  not have passed.
* **GGS-00269, Muhammad Nazir** — no join date recorded at all.

---

## Ten is a floor, not a total

This is the part that matters more than the list.

| | active employees |
|---|---|
| Total (`active` + `on_leave`) | **347** |
| CNIC **expiry** recorded | 83 |
| CNIC **number** not recorded at all | 142 |
| **No expiry recorded** | **264** |
| Expired | **10** |
| Expiring within 30 days | 0 |
| Expiring within 90 days | 1 (GGS-00062, Najam Ul Saqib, 2026-10-10) |

And the reason only 83 have one:

| client | guards deployed | expiry recorded | expired |
|---|---|---|---|
| **Emaar DHA ISB** | 70 | **66 (94%)** | 10 |
| MIU | 36 | 6 | 0 |
| Nova Group | 41 | 5 | 0 |
| HMC Taxila | **109** | **4** | 0 |
| AWT | 4 | 1 | 0 |
| Rising Sun Lodges | 2 | 1 | 0 |

CNIC expiry is captured at essentially one client and nowhere else. Emaar
appears to require the documentation, so it gets collected there; HMC Taxila
has 109 guards on site and four recorded expiries.

**So all ten expired CNICs are at Emaar not because Emaar is the problem, but
because Emaar is the only place we would find out.** The other 264 are not
compliant — they are unmeasured. The true number of deployed guards holding an
expired CNIC is somewhere between 10 and 274, and nothing in the system today
can narrow that.

Fixing the ten is a morning's work. Fixing the 264 is the actual exposure.

---

## The anomaly: `3000-01-01`

| code | name | CNIC | DOB | expiry |
|---|---|---|---|---|
| GGS-00527 | Muhammad Nazeer Ahmad | 32202-4268653-1 | 1963-05-10 | **3000-01-01** |

**Flagged, not corrected.** One row. It is the only date beyond twenty years
out.

Before treating it as a typo: this employee is **63**, and NADRA issues
**lifetime-validity CNICs**. `3000-01-01` looks like somebody encoding "does not
expire" in a column that has no way to say so. If that reading is right, the
data is not wrong — the column is missing a state, and overwriting the date
would destroy the only record that the card is a lifetime card.

Deciding which it is is Safi's call. Two questions to settle together:

1. Is `3000-01-01` a data-entry error, or an in-house convention for "lifetime"?
2. If lifetime CNICs are a real category, the column needs a way to express it
   (a nullable expiry plus an explicit `cnic_lifetime` flag) rather than a
   sentinel date that sorts to the bottom of every list forever.

### A constraint, proposed but not added

A `CHECK` rejecting an expiry more than ~20 years out would have caught this at
entry. I have **not** added it, for the reason above: if the sentinel is
deliberate, the constraint would break the only path that records a lifetime
card, and I would be guessing at policy. Same reasoning as the reverse-map
defect — refuse rather than guess.

Recommend deciding (1) first. The constraint follows from the answer, not the
other way round.

---

## Why nobody has seen this

`cnic_expiry` has been populated on production for as long as the column has
existed. **No screen has ever displayed it.**

There were five separate implementations of "what is expiring soon" —
`compliance_upcoming`, `send-compliance-alerts`, `Licences.tsx`,
`Dashboard.tsx`, and ai-chat's `get_expiring_licences`. All five computed weapon
licence, guard service licence, medical fitness and probation end. **All four of
those columns are empty on production.** Not one of the five read `cnic_expiry`,
the only compliance date that has any data in it.

The Dashboard tile compounds it: its window runs from *today* forward, so an
item that has already expired falls out of the filter entirely. Even had it read
the right column, the tile would have shown **zero** while ten guards were
overdue — the failures dropping off the bottom of a filter built to show
warnings.

The consolidated view (`compliance_upcoming`, dev) reads `cnic_expiry` and
returns signed `days_remaining`, so overdue items sort to the top rather than
vanishing. It is on dev only and ships with the ledger deployment.

---

## The dormant duplicate company

Not a compliance item; raised because it was found on the way and it will
mislead somebody eventually.

`guards n guides` (`f706043b-c548-4d15-b4c7-ef81f77f8d2a`) holds 527 employee
records duplicating the live company's, with matching CNICs and employee codes.
It has no users and has never been signed into.

It matters for three reasons:

1. **Every count run across companies is inflated.** Any figure not filtered to
   one `company_id` roughly doubles. That is how ten became twenty in my first
   pass, and it will do the same to anything else.
2. **Guard-limit and billing** are per company. Two companies, two seat counts.
3. If it was a migration rehearsal or an import trial, it is finished, and
   leaving it in place means every future reader has to rediscover that it is
   not real.

**Do not delete it on this report's say-so.** Someone should confirm what it was
created for. But it should be either archived or explained.

---

## Vetting coverage: the pipeline has never produced a completed check

Measured 2026-09-01 on `GUARDS AND GUIDES (PVT) LTD`, 347 active employees.

| field | recorded | missing |
|---|---|---|
| CNIC number | 205 | **142** |
| CNIC expiry | 83 | **264** |
| Date of birth | 184 | **163** |
| Join date | 263 | 84 |
| Phone | 207 | 140 |
| **Police verification — cleared** | **1** | 346 still `pending` |
| **NADRA Verisys — cleared** | **2** | 345 still `pending` |
| **Weapons certified** | **0** | 347 |
| **Weapon licence on file** | **0** | 347 |
| Police or NADRA **adverse** | 0 | — |
| Blacklisted | 0 | — |

Read the last two rows against the four above them: no *failures* on record
because almost no *results* on record. See the inversion noted at the top of
this file.

### Correction, 2026-09-01, and how it was found

The two verification rows above previously read **0 cleared** for both police
and NADRA, and this section previously said the pipeline had never produced a
completed check. Both were wrong. Three results exist: one police clearance and
two NADRA clearances.

The cause is worth more than the number. The original query counted
`police_verification_status = 'verified'`. The `vetting_status` enum is
**`(pending, cleared, adverse)`** — there is no `verified`. The zero was
structural, not measured: a count of a value the column cannot hold, which
cannot return anything but zero. Asked in the vocabulary the data actually
uses, the answer is 1 and 2.

It surfaced only when this table was reconciled against
`public.vetting_dashboard`, the view that has computed this same coverage
since 0057 and that nothing read. **The population and every overlapping figure
agreed exactly** — 347 either way, 346 police-pending, 345 NADRA-pending, 0
adverse, 347 not weapons-certified — so the `lifecycle_state` versus `status`
divergence does not split this population. The only disagreement was in the two
columns the view did not compute, and those were the two that were wrong.

**This table is now generated from `vetting_dashboard`**, which `0306` extended
with the cleared and not-recorded counters so it can measure the upload, and
which the Compliance page now displays. Regenerate from the view; do not
rebuild the query.

**This is the same finding as the four empty licence columns and the 264
missing CNIC expiries** — one backlog with several faces, and this table is its
size.

Until the upload lands, the system cannot answer "is this guard cleared" for
any of 347 people. That is a statement about the database, not about the
guards.

### What this changed in the code, and what it deliberately did not

`check_deploy_guard` was about to be wired to raise an alert whenever a guard
with blockers is deployed. Measured first: `armed_post_blockers()` is non-empty
for **every employee in the database**, so it would have raised a warning on
every deployment forever. A control that fires on every input carries exactly
as much information as one that never fires, and it is worse, because it trains
its reader to ignore the feed.

So `0297` split the question:

* **A vetting FAILURE** — blacklisted, police adverse, NADRA adverse, not in
  active service, a certification that lapsed. Someone looked and the answer
  was bad. **True of nobody today**, which is exactly what lets a control on it
  stay quiet and still be able to speak. This is now wired: deploying a guard
  with a vetting failure records a warning.
* **A vetting GAP** — not certified, document not on file, verification still
  pending. Nobody looked yet. **True of everybody.** That is this table, not an
  alert. Nobody needs 758 warnings; the table above is the whole content.

---

## Two schema proposals — shapes only, neither built

Both need an operational decision before any code.

### 1. `employees.cnic_lifetime boolean not null default false`

For the `3000-01-01` case above. NADRA issues lifetime-validity CNICs and the
column has no way to say so, so somebody encoded it as a sentinel date.

* When true, `cnic_expiry` is not required, and `compliance_upcoming` excludes
  the row from the expiry arms entirely — **not as expired, not as unrecorded,
  but as satisfied**.
* Coverage counting (the table above) treats a lifetime CNIC as **recorded**.
  It is on file; it simply has no expiry.
* A boolean rather than a NULL-with-convention, and the 264 employees with no
  expiry recorded are the reason: a boolean keeps "lifetime" and "not recorded"
  distinguishable, where a NULL scheme collapses them the first time somebody
  forgets the flag.
* **Backfill nothing.** GGS-00527's `3000-01-01` stays until Safi confirms the
  card is lifetime; then it becomes `cnic_lifetime = true` and the sentinel
  clears. One row, one confirmation, no guessing.
* Only *afterwards* does the sanity constraint become possible: with a way to
  say "does not expire", an expiry more than N years out is unambiguously a
  typo. Proposed, not added, and it must not land before the flag exists — it
  would break the only path that records a lifetime card.

It touches the employee intake form. That is why it is a proposal.

### 2. ~~`posts.armed`~~ — WITHDRAWN. The model was wrong.

I proposed marking posts as armed so `check_deploy_guard` could apply the rule
as written. Shayan withdrew it, and the reason is worth keeping because the
proposal was not merely unnecessary — it described a business that does not
exist:

**Weapons are allotted per CLIENT, not per post.** Emaar holds roughly 30
weapons against roughly 35 guards on a shift, so the allotment moves between
people through the day. "Is this an armed post" is not a question the business
asks, and there is nothing for a boolean to attach to.

A column would have looked reasonable, been fillable, and encoded a model
nobody uses — the most expensive kind of wrong, because it survives review.

`check_deploy_guard` therefore stays exactly as `0297` built it: **any vetting
failure at any deployment**. Broader than the rule as originally written, safe
in that direction, chosen rather than inherited, and now the only version of it
with a coherent model behind it. No further work on it.

Weapon allotment and custody control is deferred to a later stage of Bastion
and logged in `PRE_GO_LIVE.md`.

---

## Found on the way: a lapsed contract with guards still on it

Not a CNIC item. Recorded here because it surfaced while repointing the
Dashboard and because it is the second time the same client has appeared as the
same defect from a different direction.

The Dashboard's compliance panel read `clients.contract_end`; the consolidated
view reads `contracts.end_date`. Where both exist they agree. What the
comparison exposed was two clients carrying an end date with **no active
contract row behind it** — and "no active contract row" did not mean "no
contract". Both have contracts; they are excluded by *status*:

| client | contract rows | client `contract_end` | guards on site |
|---|---|---|---|
| **Palm Grove Resorts** (CLI-0005) | `CON-0005: expired` | 2026-07-31, 32d past | **4** |
| Nova Textiles Mills (CLI-0008) | `CON-0007: terminated`, `CON-0008: draft` | 2026-05-31, 93d past | 0 |

Both are on `SANDBOX TESTING ORG`, so there is **no live customer exposure
today**.

**The pattern is what matters, and it is worse than "a missing contract":**

> A contract lapses. The client record keeps the end date. Guards stay on site.
> Nothing bills.

Palm Grove is the same client that appeared in July carrying **121,148 of
payroll against nothing invoiced**. Two independent routes, one client, one
underlying failure — work continuing under an agreement that has ended.

`0293` adds these to `compliance_upcoming` as an explicit
`client_contract_end` **anomaly** — labelled so nobody tries to renew a
contract that does not exist. It is currently the only thing in the system that
would catch this shape.

**Logged for the ledger work, not built now:** a check for *deployed guards at a
client with no active contract*. That is the direct question, and neither the
compliance view nor the billing path asks it.

---

## Recommended order

1. **The ten.** Renewal chased for each; whether any should stand down from post
   until renewed is an operational call, not one this file can make.
2. **GGS-00247** separately — intake with an already-expired CNIC. Worth knowing
   how that got through.
3. **Decide `3000-01-01`**, then the constraint.
4. **The 264 with nothing recorded.** The largest item and the only one that
   changes the shape of the problem.
5. **Explain or archive `guards n guides`.** *(Confirmed since: this is the
   0186 clone, already on the production cleanup list.)*
6. **Palm Grove Resorts** — sandbox, so not urgent, but the pattern is real and
   the check for it does not exist.
7. **The vetting upload.** The largest item in this file by volume. Not a
   process problem — the records exist on paper. Re-run this report when it is
   done; `cnic_expiry_coverage` turning green is the signal.
