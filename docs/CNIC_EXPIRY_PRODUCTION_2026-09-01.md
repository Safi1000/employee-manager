# Expired CNICs — active employees, production

Run **2026-09-01** against `crm-design` (`mmkfpnshxjcyijhuydgr`), **read-only**.
Nothing was written to production to produce this.

For Shayan, to hand to Safi.

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
