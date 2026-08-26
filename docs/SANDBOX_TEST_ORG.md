# Sandbox Testing Org — verification guide

A self-contained test company for rigorous manual testing. Every number below was
read back out of the database after seeding, so anything the app shows that
differs from this document is a bug in the app.

**Org name:** `SANDBOX TESTING ORG`
**Company id:** `5eed0000-0000-4000-8000-000000000001`
**Seeded:** 25 August 2026. Data runs June–August 2026.

Every seeded row's id starts with `5eed`, so the whole org is easy to spot and
easy to delete (see [Removing it](#removing-it)).

> This replaces the earlier `SANDBOX SECURITY (TEST ORG)`
> (`7e57c0de-…-0001`), which has been deleted along with its two
> `*@sandbox.local` auth users.

---

## 0. How to get into it

There is **no login** for this org, on purpose — creating auth accounts means
creating credentials, which is not something to do casually.

Sign in as yourself (super-super-admin) and use the **company switcher** to view
as `SANDBOX TESTING ORG`.

> **Set the region to "All regions" first.** The org has three live regions and
> clients are split across them, so a regional filter deliberately hides some of
> the data described here.

---

## 1. What's in it

| | Count |
|---|---:|
| Regions (branches) | 4 (one inactive) |
| Bank accounts | 6 |
| Cash locations (auto-created from the bank accounts) | 6 |
| Clients | 8 |
| Sites | 9 |
| Shift definitions | 12 |
| Contracts | 8 |
| Contract lines | 20 |
| Contract addendums | 5 |
| Employees | 67 |
| Postings (deployments) | 59 |
| Salary history rows | 67 |
| Attendance records | 4,181 |
| Attendance confirmations | 20 |
| Document checklist rows (auto-seeded) | 670 |
| Chart of accounts (auto-seeded) | 30 |

Regions: **Head Office**, **North Region**, **South Region**, plus **Closed
Region** (inactive — it should not appear in the region picker).

Deliberately **not** seeded: invoices, payments, cheques, payroll runs,
payslips, expenses, journal entries, fixed assets. The finance side is empty by
design — this org covers clients / contracts / attendance / employees / banking.

---

## 2. Clients — the states that matter

This is the main thing to check on **Assignments & Pay**. Each client was built
to land in a different branch of the display rules.

| Client | Region | Committed | Posted | Variance | What you should see |
|---|---|---:|---:|---:|---|
| **Citadel Bank Ltd** | North | 20 | 20 | 0 | Normal card, no tag. Two sites. 22 rows (2 on leave). |
| **Delta Port Authority** | South | 14 | 15 | **−1** | Overstaffed by one. |
| **Orion Mall Management** | North | 13 | 11 | **+2** | Understaffed by two. |
| **Vertex Labs (Pvt) Ltd** | South | 4 | 0 | — | Card shows, tagged **"No employees"** |
| **Palm Grove Resorts** | South | — | 4 | — | Card shows, tagged **"No live contract"** |
| **Ironclad Munitions** | Head Office | — | 0 | — | **Hidden** — services-only contract |
| **Slate Holdings** | North | — | 0 | — | **Hidden** — no contract, nobody posted |
| **Nova Textiles Mills** | Closed | — | 0 | — | **Hidden** — contract terminated, nobody posted |

So Assignments & Pay should list **5 client cards**, two of them tagged. Tick
"show services clients" and Ironclad appears as a 6th.

### Why each one is what it is

- **Citadel** is balanced *only once the addendum is applied* — see §3. If it
  reads +2, addendum arithmetic is being skipped.
- **Delta Port** is overstaffed because **Haroon Rasheed** is posted to the
  client but **pinned to no contract line**. He must still appear on the card
  and still count towards posted strength.
- **Orion Mall** is understaffed because a REDUCE_HEADCOUNT addendum cut one
  day guard on 1 July and the post was never refilled.
- **Vertex Labs** has a live contract (4 guards, from 1 July 2026) but was never
  mobilised. The "signed but not staffed" case.
- **Palm Grove**'s contract **expired 31 July 2026** but four guards are still
  on the books. The case that used to be invisible.
- **Ironclad** bills weapons and equipment, not people. Its lines are `WEAPON`
  and `EQUIPMENT`, so it has no headcount to manage.
- **Slate Holdings** has nothing at all — no contract, no sites, nobody.

---

## 3. Contracts

Eight contracts covering **every** status and both contract types.

| Client | Type | Window | Status |
|---|---|---|---|
| Citadel Bank | guard_deployment | 1 Jan 2026 → **never expires** | active |
| Delta Port | guard_deployment | 1 Mar 2026 → 28 Feb 2027 | active |
| Orion Mall | guard_deployment | 15 Feb 2026 → 14 Feb 2027 | active |
| Vertex Labs | guard_deployment | 1 Jul 2026 → 30 Jun 2027 | active |
| Palm Grove | guard_deployment | 1 Aug 2025 → 31 Jul 2026 | **expired** |
| Ironclad | **services** | 1 Jan 2026 → 31 Dec 2026 | active |
| Nova Textiles | guard_deployment | 1 Jun 2025 → 31 May 2026 | **terminated** |
| Nova Textiles | guard_deployment | 1 Sep 2026 → 31 Aug 2027 | **draft** |

Contract codes (`CON-…`) were assigned by the `assign_contract_code` trigger in
insert order; read them off the app if you need to cite one exactly.

**Citadel is `is_infinite = true` with a 30-day notice period.** It has no end
date and must never be treated as expired.

**Split by site:** Citadel, Delta, Orion, Vertex and Nova have lines pinned to a
site, so their contracts open with **Split by site = Yes**. **Palm Grove's line
carries no site**, so it opens as **No**. Both paths are covered.

### The five addendums — the arithmetic test

| Ref | Contract | Change | Effective | Effect today |
|---|---|---|---|---|
| ADD-2026-01 | Citadel | ADD_HEADCOUNT +2 on Tower Guard (Day) | 1 Aug 2026 | **counts** — 6 → 8 |
| ADD-2026-02 | Orion | REDUCE_HEADCOUNT −1 on Mall Guard (Day) | 1 Jul 2026 | **counts** — 6 → 5 |
| ADD-2026-03 | Delta | RATE_CHANGE to 62,000 | 1 Aug 2026 | rate only, no headcount effect |
| ADD-2026-04 | Delta | EXTEND_END_DATE to 31 Aug 2027 | 1 Aug 2026 | date only |
| ADD-2026-05 | Citadel | ADD_HEADCOUNT +3 on Tower Guard (Night) | **1 Dec 2026** | **must NOT count** — future |

Citadel's committed strength is **20 today** (18 on the base lines + 2 from
ADD-2026-01). If the app shows 18 it is ignoring addendums; if it shows 23 it is
counting the future one.

---

## 4. Sites and shifts

| Client | Site | Shifts defined | Guards posted |
|---|---|---|---|
| Citadel Bank | Citadel HQ Tower | day, night | 8 day + 6 night + 1 supervisor |
| Citadel Bank | Citadel Data Centre | **day only** | 3 day + **2 night** |
| Delta Port | Delta Port Terminal 1 | day, night | 5 day + 5 night + 1 Sr. Supervisor + 1 unpinned |
| Delta Port | Delta Port Terminal 2 | day | 3 day |
| Orion Mall | Orion Mall | day, evening, night | 5 + 3 + 2 + 1 asst. supervisor |
| Palm Grove | Palm Grove Beach Resort | day | 4 day |
| Vertex Labs | Vertex Plant | day | 0 |
| Nova Textiles | Nova Textiles Mill | day | 0 |
| Ironclad | Ironclad Depot | none | 0 |

**Deliberate mismatch to check:** Citadel Data Centre has **one** shift
definition (day) but **two guards posted on night** (Ata Rehman, Nadeem
Ghauri). The attendance board must still show them — a posting is the source of
truth for who works, not the shift table.

---

## 5. Attendance

Runs **1 June – 24 August 2026**. Pattern, applied to every posted guard:

| Day of month | Status |
|---|---|
| 7th | `Leave` (rotation leave) |
| 14th | `rest_day` |
| 21st | `absent` (awol) for every 5th guard |
| 28th | `absent` (sick) for every 7th guard |
| all other days | `present` |

> Leave is stored under the canonical **`Leave`** token, which is what the
> attendance board itself writes (it maps `rotation_leave` → `Leave` on save and
> back again on read). Both render as "Leave".

### The shift-change test case — check this one

**Tanveer Abbas** (TST-00009, Citadel HQ Tower) changed shift mid-year:

- **Day** shift from 1 Jan to **30 June 2026**
- **Night** shift from **1 July 2026** onward

Open the attendance board on **20 June** — he must show as **day**. Open it on
**20 July** — he must show as **night**. Verified in the data: `day` and `night`
respectively. If July shows day, the dated-shift logic has regressed.

### The transfer test case

**Noman Saeed** (TST-00018) was at **Orion Mall** from 15 Feb to 15 June 2026,
then moved to **Citadel Data Centre** from 16 June. His Orion posting is closed,
not deleted. Verified: his 10 June attendance is attributed to **Orion**, his 10
July attendance to **Citadel**. History must not be rewritten by the transfer.

### The service-window test case

Palm Grove's four guards have **no attendance after 31 July 2026**, because
their contract ended then. Try to mark them for August — the app should refuse
with "attendance for … is after this guard's service window". That refusal is
correct, and the database enforces it (it blocked the seeding too).

### Double duty

- **Shoaib Akhtar** (TST-00004) on **5 August**: two rows, `day` + `night`.
- **Wasim Akram** (TST-00010) on **6 August**: two rows, `night` + `day`.

Double duty is a second *attendance row* on the date under a different
`worked_shift`, never a second posting.

### Relief cover

Both relievers worked ordinary days (10–12 August) and covered a real absence on
**21 August**: Adeel Iqbal covered Rashid Latif (day), Faraz Anwar covered Wasim
Akram (night). Both of those guards are genuinely marked absent that day.

### Confirmations

**22 and 24 August are confirmed** for every live client-shift (20
confirmations). **23 August is deliberately left unconfirmed** — that day should
show as awaiting.

---

## 6. Employees

All 67, by state:

| Lifecycle state | Count | Category |
|---|---:|---|
| active | 50 | client |
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

**Guard codes** run `TST-00001` … `TST-00067`. The two applicants and the one
waitlisted candidate have **no** guard code — codes are issued on hire, and that
is correct. Employee codes (`EMP-…`) were assigned by the app's own counter.

### Things to check

- **Separated staff must NOT appear on Assignments & Pay.** Sohail Tanvir
  (left), Imad Wasim (terminated), Mohammad Amir (fired), Ahmed Shehzad
  (absconded) and Umar Akmal (archived) all still carry a `client_id` for
  payroll history, but the page must filter them out. They must still appear in
  the Employees list under the matching lifecycle filter, with their closed
  postings intact.
- **Mohammad Amir** is **blacklisted** with a reason and is not eligible for
  rehire. Attempting to rehire him must be refused.
- **On-leave guards** (Sohail Fazal, Manzoor Elahi) are posted to Citadel and
  appear on its card, but must **not** count towards posted strength — Citadel
  reads 22 rows and 20 posted. Their attendance stops on 30 June.
- **`armed` and `gunman`** (Sarfraz Khan, Azhar Mahmood): Assignments & Pay only
  groups `client` / `office_staff` / `reliever`, so these two will not show
  there. That is a known gap in the page, not a data problem.

### Salary history

All 67 people have a dated salary row. Three Citadel day guards — **Waqar
Younis, Zubair Khan, Naveed Alam** — took a **10% increment effective 1 August
2026** (32,000 → 35,200), so they have **two** rows each; everyone else has one.
Open the salary panel on any of the three: it must show both, with dates.

---

## 7. Banking

Six accounts, and each one auto-created a matching **cash location** via the
`sync_bank_account_cash_location` trigger — check Treasury shows all six.

| Bank | Account | Type | Opening | Notes |
|---|---|---|---:|---|
| Meezan Bank | 0102-0100-1234-5601 | Current | 5,000,000 | main operating account |
| Habib Bank Ltd | 0234-7900-4455-0002 | Current | 1,250,000 | |
| United Bank Ltd | 0345-2200-8899-0003 | Savings | 800,000 | **auto-zero monthly** is on |
| Bank Alfalah | 0456-3300-1122-0004 | Current | 0 | **inactive** — must not be offered as a payment target |
| Askari Bank | 0567-4400-6677-0005 | Savings | 350,000 | full IBAN / SWIFT / branch filled |
| JS Bank | 0678-5500-3344-0006 | Current | 0 | **client-owned** (Citadel Bank), not a company account |

Checks worth running: the inactive account must not appear in payment pickers;
the client-owned account must not be counted in company cash; both account types
(Current / Savings) render correctly.

---

## 8. Tax and billing profiles

- **Citadel, Orion, Vertex, Ironclad, Slate, Nova** are **filers** → 8% withheld.
- **Delta Port and Palm Grove** are **non-filers** → **16%** withheld.
- **Orion** is the only `SLA` / `VARIABLE` client and the only one with
  `attendance_billing` on.
- **Orion** (125,000) and **Palm Grove** (202,400) carry opening balances.
- Every client has a distinct `employee_id_prefix` (CTD, DPA, ORN, VTX, PGR,
  IRN, SLT, NVT) — display codes should use it.

---

## 9. A suggested run-through

1. **Switch to the org**, region = All regions.
2. **Clients** — 8 listed. Nova sits in the inactive Closed Region.
3. **Contracts** — 8, one of each status. Open Citadel's: **Split by site =
   Yes**, 2 sites, 5 lines, never expires, 3 addendums. Open Palm Grove's:
   **Split by site = No**.
4. **Assignments & Pay** — 5 cards; Vertex tagged "No employees", Palm Grove
   tagged "No live contract"; Ironclad, Slate and Nova absent. Expand Citadel →
   2 sites → guards. Check the Department column reads Guard / Supervisor /
   Sr. Supervisor from the contract lines, and that Haroon Rasheed shows on
   Delta despite having no line.
5. **Attendance** — set the date to 20 June, then 20 July, and check Tanveer
   Abbas flips day → night. Check 23 August is unconfirmed while 22 and 24 are
   confirmed. Try to mark a Palm Grove guard for August — it must refuse.
6. **Employees** — filter by each lifecycle state; confirm the counts in §6.
7. **Banking / Treasury** — 6 accounts, 6 cash locations, one inactive, one
   client-owned.

---

## 10. Known issue found while building this

**`attendance_records_enforce_reliever()` tests the wrong string.** It compares
`new.status = 'Present'` (capitalised), but the attendance board writes
`'present'` (lower case). Two consequences for reliever rows:

- the guard "Relievers marked Present must record `worked_for_client_id`" never
  fires; and
- the `else` branch then treats every real reliever row as "not present" and
  **nulls out `worked_for_client_id`**, silently dropping the client the
  reliever actually covered.

The two `relief_cover` rows seeded on 21 August were written with a
`worked_for_client_id` and had it stripped by this trigger. `covering_for_guard_id`
survives, so the cover is still traceable. Not fixed here — it is production
behaviour and wants a deliberate decision.

---

## Removing it

The company row does **not** cascade cleanly on its own: `cash_locations` and a
few finance tables hold non-cascading foreign keys, `journal_lines` pins
`branches`, and a `payroll_run_phases` lock trigger blocks the delete. The purge
that worked is below — it disables **user** triggers only, so foreign-key
cascades stay enforced throughout.

```sql
do $$
declare
  v_old uuid := '5eed0000-0000-4000-8000-000000000001';
  r record; pass int; moved boolean; n bigint;
begin
  for r in select c.oid::regclass rc from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
           where ns.nspname='public' and c.relkind='r'
             and exists (select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
  loop execute format('alter table %s disable trigger user', r.rc); end loop;

  for pass in 1..8 loop
    moved := false;
    for r in select c.oid::regclass rc from pg_class c
             join pg_namespace ns on ns.oid=c.relnamespace
             join pg_attribute a on a.attrelid=c.oid and a.attname='company_id' and a.attnum>0
             where ns.nspname='public' and c.relkind='r'
    loop
      begin
        execute format('delete from %s where company_id = $1', r.rc) using v_old;
        get diagnostics n = row_count;
        if n > 0 then moved := true; end if;
      exception when others then null;
      end;
    end loop;
    exit when not moved;
  end loop;

  delete from public.companies where id = v_old;

  for r in select c.oid::regclass rc from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
           where ns.nspname='public' and c.relkind='r'
             and exists (select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
  loop execute format('alter table %s enable trigger user', r.rc); end loop;
end $$;
```

Afterwards, confirm nothing was left disabled — this must return 0:

```sql
select count(*) from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal and t.tgenabled <> 'O';
```
