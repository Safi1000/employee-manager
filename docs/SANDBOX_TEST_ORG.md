# Sandbox Security (Test Org) — verification guide

A complete, self-contained test company. Every number below was read back out of
the database after seeding, so anything the app shows that differs from this
document is a bug in the app.

**Org name:** `SANDBOX SECURITY (TEST ORG)`
**Company id:** `7e57c0de-0000-4000-8000-000000000001`
**"Today" when seeded:** 5 August 2026. Data runs June–August 2026.

Every seeded row's id starts with `7e57c0de`, so the whole org is easy to spot
and easy to delete (see [Removing it](#removing-it) at the end).

---

## 0. How to get into it

There is **no login** for this org, on purpose — creating auth accounts means
creating credentials, which is not something to do casually.

Sign in as yourself (super-super-admin) and use the **company switcher** to view
as `SANDBOX SECURITY (TEST ORG)`. Everything below assumes you are viewing as
that company with the **region selector set to "All regions"**.

> **Set the region to All regions first.** The org has three regions and clients
> are split across them, so a regional filter deliberately hides some of the data
> described here.

---

## 1. What's in it

| | Count |
|---|---:|
| Employees | 53 |
| Clients | 7 |
| Sites | 7 |
| Shift definitions | 10 |
| Contracts | 8 |
| Contract lines | 20 |
| Contract addendums | 3 |
| Postings (deployments) | 45 |
| Attendance records | 2,330 |
| Payslips | 98 |
| Invoices | 9 |
| Invoice payments | 5 |
| Cheques | 4 |
| Expenses | 14 |
| Fixed assets | 5 |
| Journal entries | 89 |
| Chart of accounts | 32 |
| Salary history rows | 53 |
| Guard documents | 300 |
| Document checklist rows | 530 |

Regions: **Head Office**, **North Region**, **South Region**, plus **Closed
Region** (inactive — it should not appear in the region picker).

---

## 2. Clients — the four states that matter

This is the main thing to check on **Assignments & Pay**, because each client was
built to land in a different branch of the display rules.

| Client | Posted | Committed | Variance | What you should see |
|---|---:|---:|---:|---|
| **Apex Tower** | 14 | 14 | 0 | Normal card, no tag. Two sites. |
| **Harbour Logistics** | 10 | 9 | **−1** | Overstaffed by one. |
| **Meridian Mall** | 10 | 12 | **+2** | Understaffed by two. |
| **Zenith Pharma** | 0 | 3 | — | Card shows, tagged **"No employees"** |
| **Silk Route Hotels** | 4 | 0 | — | Card shows, tagged **"No live contract"** |
| **Nordic Arms Supply** | 0 | 0 | — | **Hidden** — services-only contract |
| **Dormant Holdings** | 0 | 0 | — | **Hidden** — no contract and nobody posted |

So Assignments & Pay should list **5 client cards**, two of them tagged. If you
tick "show services clients", Nordic appears as a 6th.

### Why each one is what it is

- **Zenith Pharma** has a live contract (CON-0006, 3 guards) but was never
  mobilised. This is the "signed but not staffed" case.
- **Silk Route Hotels**' contract (CON-0005) **expired 30 June 2026** but four
  guards are still on the books. This is the case that used to be invisible.
- **Nordic Arms Supply** bills weapons and equipment, not people. Its contract
  lines are `WEAPON` and `EQUIPMENT`, so it has no headcount to manage.
- **Dormant Holdings** has nothing at all. It should never appear.

---

## 3. Sites and shifts

| Client | Site | Shifts defined | Guards posted |
|---|---|---|---|
| Apex Tower | Apex Tower A | day, night | 6 day + 4 night |
| Apex Tower | Apex Tower B | day | 3 day + 1 night |
| Meridian Mall | Meridian Mall | day, evening, night | 5 + 3 + 2 |
| Harbour Logistics | Harbour Yard | day, night | 4 day + 6 night |
| Silk Route Hotels | Silk Route Hotel | day | 4 day |
| Zenith Pharma | Zenith Plant | day | 0 |
| Nordic Arms Supply | Nordic Depot | none | 0 |

**Deliberate mismatch to check:** Apex Tower B has **one** shift definition (day)
but **one guard posted on night**. The attendance board should still show that
guard — a posting is the source of truth for who works, not the shift table.

**Split by site:** Apex, Meridian, Harbour and Zenith have contract lines pinned
to a site, so opening their contract shows **Split by site = Yes**. Silk Route's
line has **no** site, so it opens as **No**. Both paths are covered.

---

## 4. Attendance

Attendance runs **1 June – 4 August 2026**. Pattern, applied to every posted
guard:

| Day of month | Status |
|---|---|
| 7th | `rotation_leave` |
| 14th | `rest_day` |
| 21st | `absent` (awol) for every 5th guard |
| 28th | `absent` (sick) for every 7th guard |
| all other days | `present` |

Totals:

| Month | Present | Absent | Rotation leave | Rest day |
|---|---:|---:|---:|---:|
| June 2026 | 1,052 | 12 | 38 | 38 |
| July 2026 | 976 | 10 | 34 | 34 |
| Aug 2026 (1–4) | 136 | 0 | 0 | 0 |

### The shift-change test case — check this one

**Tanveer Abbas** (Apex Tower A) changed shift mid-year:

- **Day** shift from 15 Feb to **30 June 2026**
- **Night** shift from **1 July 2026** onward

Open the attendance board on **20 June** — he must show as **day**. Open it on
**20 July** — he must show as **night**. If July shows day, or June shows night,
the dated-shift logic has regressed. His records are 30 day rows in June and 31
night rows in July.

### The transfer test case

**Noman Saeed** was at **Apex Tower A** from 20 Jan to 28 Feb, then moved to
**Meridian Mall** from 1 March. His Apex posting is closed, not deleted, so his
attendance history at Apex must still be visible on June/July dates at Meridian
and on Feb dates at Apex.

### The service-window test case

Silk Route's guards have **no attendance after 30 June 2026**, because their
contract ended then. Try to mark them for July — the app should refuse with
"attendance for … is after this guard's service window". That refusal is correct.

### Confirmations

1 and 3 August are **confirmed** for every open client-shift (20 confirmations).
**2 August is deliberately left unconfirmed** — that day should show as awaiting.

---

## 5. Employees

All 53, by state:

| Lifecycle state | Count | Category |
|---|---:|---|
| active | 36 | client |
| active | 3 | office_staff |
| active | 2 | reliever |
| active | 1 | armed |
| active | 1 | gunman |
| on_leave | 2 | client |
| applicant | 2 | client |
| waitlisted | 1 | client |
| left | 1 | client |
| terminated | 1 | client |
| fired | 1 | client |
| absconded | 1 | client |
| archived | 1 | client |

**Guard codes** run `SBX-00001` … `SBX-00050`. The two applicants and one
waitlisted candidate have **no** guard code — codes are issued on hire, and that
is correct.

### Things to check

- **Separated staff must NOT appear on Assignments & Pay.** Sohail Tanvir (left),
  Imad Wasim (terminated), Mohammad Amir (fired), Ahmed Shehzad (absconded) and
  Umar Akmal (archived) all still carry a `client_id` for payroll history, but the
  Assignments & Pay page must filter them out.
- **They must still appear** in the Employees list under the matching lifecycle
  filter, and their closed postings must still be in their history.
- **Mohammad Amir** is blacklisted with a reason, and has a **blocked** clearance
  certificate (kit not returned, incident open). His full-and-final should be
  gated.
- **`armed` and `gunman` categories:** Sarfraz Khan and Azhar Mahmood.
  Assignments & Pay only groups `client` / `office_staff` / `reliever`, so these
  two will not show there. That is a known gap in the page, not a data problem —
  worth deciding what should happen to them.

### Salary history

50 people have a dated salary. Three Apex day guards — **Waqar Younis, Zubair
Khan, Naveed Alam** — got a **10% increment effective 1 July 2026**
(32,000 → 35,200). Their salary history has two rows each; everyone else has one.
Open the salary panel on any of the three: it must show both, with dates.

---

## 6. Invoices and receivables

| Invoice | Client | Billing month | Net | Received | Balance | Status |
|---|---|---|---:|---:|---:|---|
| INV-202607-0001 | Apex Tower | Jun 2026 | 782,000 | 782,000 | 0 | paid in full |
| INV-202607-0002 | Meridian Mall | Jun 2026 | 655,040 | 655,040 | 0 | paid, **cash** |
| INV-202607-0003 | Harbour Logistics | Jun 2026 | 537,600 | 537,600 | 0 | paid by **cleared cheque** |
| INV-202607-0004 | Nordic Arms | Jun 2026 | 69,000 | 69,000 | 0 | services invoice |
| INV-202607-0005 | Silk Route | Jun 2026 | 202,400 | 0 | 202,400 | **unpaid, overdue** |
| INV-202608-0001 | Apex Tower | Jul 2026 | 782,000 | 400,000 | 382,000 | **part paid** |
| INV-202608-0003 | Meridian Mall | Jul 2026 | 633,880 | 0 | 633,880 | unpaid |
| INV-202608-0004 | Harbour Logistics | Jul 2026 | 537,600 | 0 | 537,600 | **cheque bounced** |
| INV-202608-0002 | Apex Tower | Aug 2026 | 782,000 | 0 | 782,000 | current |

Totals by **billing period** (not invoice date):

| Billing month | Invoices | Subtotal | Withheld | Net | Received | Outstanding |
|---|---:|---:|---:|---:|---:|---:|
| Jun 2026 | 5 | 2,497,000 | 250,960 | 2,246,040 | 2,043,640 | 202,400 |
| Jul 2026 | 3 | 2,179,000 | 225,520 | 1,953,480 | 400,000 | 1,553,480 |
| Aug 2026 | 1 | 850,000 | 68,000 | 782,000 | 0 | 782,000 |

**Total outstanding: 2,537,880.**

### The month test

Note the **invoice numbers say July/August but the service is June/July**. This
is the trap that caused a real bug before: the list and the P&L must both group on
the **billing period**, not the invoice date. If the Invoices list says an invoice
is "June" but the P&L counts it in July, they have diverged again.

### Withholding

- Apex and Meridian are **filers** → 8% withheld.
- Harbour Logistics is a **non-filer** → **16%** withheld (102,400 on 640,000).

### Cheques

| Cheque | Amount | Direction | Status |
|---|---:|---|---|
| CHQ-100201 | 537,600 | incoming | **cleared** |
| CHQ-100202 | 537,600 | incoming | **bounced** (insufficient funds) |
| CHQ-100203 | 382,000 | incoming | pending |
| CHQ-900044 | 185,000 | outgoing | pending |

Check: **the cleared cheque must not offer a Bounce action.** The pending ones
must offer both Clear and Bounce, and bouncing must open the app's own form (not
the browser prompt) and ask for a reason.

---

## 7. Expenses and P&L

| Month | Cost of services | Operating expense | Total |
|---|---:|---:|---:|
| June 2026 | 359,000 | 180,000 | 539,000 |
| July 2026 | 71,000 | 574,540 | 645,540 |
| Aug 2026 | 38,000 | 195,540 | 233,540 |

**Rough P&L check for June 2026:**

| | |
|---|---:|
| Revenue (net of withholding) | 2,246,040 |
| Cost of services | −359,000 |
| Operating expenses | −180,000 |
| Payroll (June, 49 payslips) | −1,975,137 |
| Depreciation (June) | see Fixed Assets |
| **Result** | a **loss** of roughly 268,000 before depreciation |

June is deliberately loss-making and July is deliberately better, so a month-on-
month comparison has something to show.

**89 journal entries** were posted automatically by the triggers — from invoices,
payments, expenses, advances, fixed assets and depreciation. Nothing was
hand-posted. If the P&L or trial balance disagrees with the tables above, the
journal triggers are the place to look.

---

## 8. Payroll

| Run | Period | Stream | Status |
|---|---|---|---|
| June guard | Jun 2026 | guard_field | **completed** |
| June office | Jun 2026 | salaried | **completed** |
| July guard | Jul 2026 | guard_field | **approved** (not disbursed) |
| July office | Jul 2026 | salaried | **draft** |

| Month | Payslips | Net total |
|---|---:|---:|
| June 2026 | 49 | 1,975,136.67 |
| July 2026 | 49 | 1,977,003.34 |

Every payslip carries working days, present days, absent days, leave days, a
per-day rate, EOBI of 370, and an absence deduction computed from the attendance
above. Absences are the only reason two guards on the same salary differ.

**The lock test:** try to add a bonus or adjustment to a **June** payslip. It must
be refused — "payroll run is completed and locked". July's are editable. This
lock is working; it blocked me during seeding, which is exactly right.

Also seeded: 4 advances, 3 payslip adjustments (July), 3 Eid reward lines (July),
6 accrued guard bonuses.

---

## 9. Everything else

| Area | What's there |
|---|---|
| **Posts** | 8 (7 active, 1 deactivated with the lapsed contract) + 3 post orders |
| **Incidents** | 5 — one of each severity, statuses open → closed |
| **Supervisor visits** | 4 — completed ×2, missed, scheduled |
| **No-shows** | 2 — one covered by a reliever, one left uncovered |
| **Vacancies** | 2 — one open, one filled |
| **Complaints** | 3 — open, in progress, closed |
| **Service reviews** | 3 — ratings 5, 3 and 2 |
| **Renewal pipeline** | 3 — negotiating, contacted, lost |
| **Compliance cases** | 5 — every stage from not_started to issued |
| **Statutory filings** | 5 — including one **overdue** (June withholding tax) |
| **Tasks** | 6 — todo, in_progress, done; priorities low → urgent |
| **Alerts** | 6 — blocking, warning, dashboard; open/acknowledged/resolved |
| **Important dates** | 5 — including one already overdue |
| **Inventory** | 7 items — weapons, uniform, equipment, site asset; one below reorder level |
| **Issuances** | 3 — good, damaged/not returned, returned |
| **Ammunition counts** | 2 — one tallied, one **4 rounds short and unresolved** |
| **Vehicles** | 2 (one inactive) + 4 vehicle logs |
| **Fixed assets** | 5 across every category; depreciation run for June and July |
| **Partners** | 2 (60/40) with opening balances |
| **Reserve policies** | all 5 reserve types |
| **Appraisals** | 5 — draft, moderated, approved; ratings below → outstanding |
| **KPIs** | 7 definitions, 5 recorded values |
| **Recruitment** | 5 candidates — screening, interview, offer, hired, rejected |
| **Accounting periods** | May 2026 **closed** (test the period lock against it) |

---

## 10. A suggested run-through

1. **Switch to the org**, region = All regions.
2. **Clients** — 7 listed, statuses active/inactive only.
3. **Contracts** — 8, one of each status (active, expired, terminated, draft).
   Open Apex's: Split by site = **Yes**, 2 sites, 6 lines. Open Silk Route's:
   Split by site = **No**.
4. **Assignments & Pay** — 5 cards, Zenith tagged "No employees", Silk Route
   tagged "No live contract", Dormant and Nordic absent. Expand Apex → 2 sites →
   guards. Check the Department column reads Guard / Supervisor / Senior
   Supervisor from the contract lines.
5. **Attendance** — set the date to 20 June, then 20 July, and check Tanveer
   Abbas flips day → night. Check 2 August is unconfirmed while 1 and 3 are
   confirmed.
6. **Employees** — filter by each lifecycle state; confirm the counts in §5.
7. **Payroll** — June locked, July editable. Payslip totals match §8.
8. **Invoices** — 9 invoices, months grouped by service period, one part-paid,
   one bounced cheque. Receivables = 2,537,880.
9. **Cheques** — cleared one offers no Bounce; pending ones do.
10. **P&L** — June a loss, July better; totals reconcile to §7.
11. **Everything in §9** — each page should have at least one row in every state.

---

## 11. Two bugs found while building this

**Fixed:** `post_orders` could never be written to. The `inherit_region_from_post()`
trigger is shared by four tables and read `new.client_id`, but `post_orders` has
no such column, so **every insert failed** with `record "new" has no field
"client_id"`. Fixed in migration
`0164_fix_inherit_region_from_post_missing_client_id.sql`.

**Not fixed, worth knowing:** `cheque_apply_balance()` writes a `bank_transactions`
row without a `company_id`, relying on the `fill_company_id` trigger to read it
from the logged-in user's session. That works in the app, but it fails for
anything running without a session (a background job, a SECURITY DEFINER path, a
data import). The cheque already knows its own company, so passing it through
would be more robust. I worked around it during seeding rather than change
production behaviour.

---

## Removing it

Every row belongs to the one company, and ~100 tables cascade from `companies`,
so:

```sql
-- Audit triggers fire during the cascade and can break the delete, so disable them first.
delete from public.companies where id = '7e57c0de-0000-4000-8000-000000000001';
```

If that errors on a foreign key, the tables that do **not** cascade
(`cash_locations` and friends) need clearing first — the same sequence used for
the earlier org purge. Ask and I'll write it as a script.
