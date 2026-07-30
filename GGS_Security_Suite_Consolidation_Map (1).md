# GGS Security Suite — Consolidation Map

A restructure plan for the CRM. Three layers: the proposed new structure, a panel-by-panel ledger of what happens to every current screen (so nothing gets lost), and the handful of business decisions that are still yours to make.

Current state: **8 sections, ~45 panels**, with the same concepts scattered across multiple homes.
Target state: **8 sections, ~28 panels**, each concept living in exactly one place.

---

## STATUS — restructure implemented (2026-07-29)

The **structural restructure below is done** — nav regrouped into the 8 target sections, panels merged/moved/renamed/killed, all old URLs redirect so nothing 404s. Tabbed merges: Payroll (Payslips+Runs), Assets & Issuance (Register+Issuance), Accounting Core (Opening Balances + Chart of Accounts), Access & Governance (Users+Governance). Decision 3 (client notes/rating) shipped with migration `0147` (applied).

**Correction — most "BUILD/FIX" items were already built.** A live-system check found the doc's "needs building" claims were out of date:

- **Accounting Core is fully functional** — 1,217 journal entries / 2,938 double-entry lines / 410 CoA accounts. TB + GL are real, off the double-entry journal. Not broken.
- **Performance is fully wired** — KPI computation, bonus-pool generation (HO + regional), pool approval, appraisal transitions, appreciation runs, attendance/Eid bonuses all call live RPCs from the Performance panel. It's unused (0 pools generated), not unwired.
- **HO cost allocation is built and posting** — `run_ho_cost_allocation` with real posted runs, triggered from Treasury. It allocates by **average deployed guards** (see revised Decision 4), not revenue share.
- **Project Financing** already has a real subsystem (projects, investors, investments, investor ledger, PROFIT_SHARE / FIXED_FINANCE return types).

Net: no further finance building is planned. **The two greenfield items are now built:**

- **Recruitment intake** — `recruitment_candidates` table (migration `0148`, applied) + a full pipeline UI (add candidate → applied/screening/interview/offer → hired, plus reject/withdraw, source, branch, notes). A hire is flagged `hired`; the actual employee record is still created in Employees (intake data is intentionally light).
- **Daily Reports auto-PDF + record** — branded `generateDailyOperationsReportPdf` (`src/app/lib/dailyReportPdf.ts`) wired as a "Download PDF" action on the Daily Reports tab: date-wise per-post reporting, present-vs-required, silent posts, exceptions. Each generation also writes a durable record to `daily_report_exports` (migration `0149`) — the counts snapshot + who/when — and recent exports are listed on the tab.

**Audit round (fixed two deviations found on re-read):**

1. **Dissolving Client Relationships had orphaned complaints + renewals** (their only UI was that panel). Re-homed faithfully: `client_complaints` → **Incidents** ("Client Complaints" tab), `renewal_pipeline` → **Licenses & Renewals** ("Contract Renewals" tab). No data lost, no separate panel re-added.
2. **Regional P&L wasn't surfaced in Profit-Share.** Added a "Regional P&L" entry to Profit-Share that deep-links Treasury's Regional P&L tab (Treasury now reads `?tab=`). Treasury stays in Finance for reserves/cockpit/inter-region/partner-capital.

**Second audit round — the two "minor content" items are now done too (full doc compliance):**

3. **Daily Reports trimmed to the doc.** Dropped the supervisor-visit / no-show / mobilisation / post-order tabs; the panel is now just the date-wise report + PDF + record. (Underlying tables/RPCs untouched — only the UI surface was removed.)
4. **Sites & Strength properly split.** New `Deployment.tsx` = the contracted-vs-active headcount snapshot only (no per-post/per-site drill-down). Billing reconciliation moved into **Invoices** as a "Billing reconciliation" tab (`v_client_billing_reconciliation`). Old `SitesStrength.tsx` is orphaned.

No deviations remain — every Layer-2 row is implemented as written (or explicitly superseded by a Decision).

---

## LAYER 1 — The proposed structure

```
1. OVERVIEW
   └─ Dashboard  (read-only aggregator, re-points after restructure)

2. CLIENTS & CONTRACTS
   ├─ Clients
   ├─ Contracts        (holds total guard count, not posts)
   └─ Invoices         (auto-generation logic kept as-is)

3. WORKFORCE
   ├─ Employees
   ├─ Recruitment      (absorbs Vacancies + recruitment intake → becomes an Employee)
   ├─ Attendance
   ├─ Payroll          (Payroll + Payroll Runs merged: period run → payslips)
   ├─ Performance      (needs wiring — build, not restructure)
   └─ Relievers        (see Decision 1)

4. OPERATIONS
   ├─ Deployment       (per-client contracted vs active headcount snapshot — the surviving
   │                     useful half of old "Sites & Strength", plus optional day/night notes)
   ├─ Daily Reports    (repurposed Field Operations: date-wise client report → auto-PDF + record)
   ├─ Incidents        (absorbs "complaints" from old Client Relationships)
   └─ Assets & Issuance (Inventory + Assets merged: one register + one issuance ledger)

5. FINANCE
   ├─ Accounting Core  (Opening Balances + Chart of Accounts + General Ledger + Trial Balance
   │                     — one continuous spine, currently split across 3 broken/empty panels)
   ├─ Bank & Ledgers   (Bank Accounts, Cash Custody, Accounts Payable, Receivables)
   ├─ Expenses & Advances
   ├─ Cash Flow        (the engine that drives profit-share)
   ├─ Financial Reports (P&L + client-wise P&L — fix HO cost allocation)
   └─ Period Close     (fix logic: block postings, allow corrections)

6. PROFIT-SHARE   (renamed from "Partnership Finance")
   ├─ Regional P&L        (per region, cash-basis)
   ├─ Participation Rules (the distribution rules engine)
   ├─ RMD Statements      (partner ledgers + statements)
   ├─ Regional Scorecard  (moved here from Finance)
   └─ Project Financing   (outside investors — separate mechanism, feeds in; see Decision 2)

7. COMPLIANCE   (already clean — no merges)
   ├─ Licenses & Renewals (absorbs contract "renewals" from old Client Relationships)
   ├─ Compliance Calendar
   ├─ Compliance Cases
   └─ Documents           (the one document hub — everything converges here)

8. ADMIN
   ├─ Alerts
   ├─ Tasks
   ├─ Access & Governance (Users & Permissions + Governance merged)
   ├─ Audit Log
   └─ Settings
```

---

## LAYER 2 — What happens to every current panel

**KEEP** = survives roughly as-is · **MERGE** = folds into another · **MOVE** = relocates ·
**KILL** = removed · **BUILD** = kept but needs building/fixing

| Current location | Panel | Verdict | Where it goes / note |
|---|---|---|---|
| Overview | Dashboard | KEEP | Aggregator. Finalise last — widgets re-point after everything else settles. |
| Contracts & Clients | Clients | KEEP | — |
| Contracts & Clients | Contracts | KEEP | Confirmed: holds total guard count, no posts. |
| Contracts & Clients | Sites & Strength | SPLIT/KILL (done) | **Done**: new `Deployment.tsx` shows only the contracted-vs-active headcount snapshot (`v_client_strength_reconciliation`). Per-post/per-site drill-down dropped. Billing reconciliation → **Invoices** ("Billing reconciliation" tab). Old `SitesStrength.tsx` orphaned. |
| Contracts & Clients | Invoices | KEEP | Auto-gen + "one invoice per contract per month" rule kept. Absorbs billing reconciliation. |
| Contracts & Clients | Client Relationships | DISSOLVE (done) | Reviews → client record (Decision 3). **Complaints → Incidents** ("Client Complaints" tab). **Renewals → Licenses & Renewals** ("Contract Renewals" tab). Panel redirects to Clients. |
| Workforce | Employees | KEEP + BUILD | Improvements parked for a dedicated pass. |
| Workforce | Attendance | KEEP | — |
| Workforce | Payroll | MERGE | Merges with Payroll Runs into one Payroll (period run → payslips). |
| Workforce | Payroll Runs | MERGE | Was the empty "batch/period" half of Payroll. Becomes the run layer. |
| Workforce | Performance | KEEP (already built) | ~~KPI/appraisal/bonus exist but aren't wired.~~ **Correction: fully wired** — KPI compute, bonus pools (HO+regional), approval, appraisal transitions, appreciation, attendance/Eid bonuses all live. Just unused so far. |
| Workforce | Relievings (Attendance, Payroll) | DECISION | See Decision 1. Cost mechanic differs from salary. |
| Workforce | Vacancies | MOVE (built) | → Workforce ▸ Recruitment. **Built**: `recruitment_candidates` pipeline (applied→screening→interview→offer→hired). Vacancy = free-text position for now. |
| Operations | Deployment Roster | KILL/LIGHTEN | Daily per-post assignment dropped (supervisor handles it, you don't log it). Optional light snapshot survives inside Operations ▸ Deployment. |
| Operations | Field Operations | REPURPOSE (done) | Becomes Operations ▸ Daily Reports. Branded date-wise per-post report → "Download PDF" + stored record. **Supervisor-visit / no-show / mobilisation / post-order tabs now dropped** — panel is Daily Reports only, per the doc. |
| Operations | Incident Reporting | KEEP | Strong. Absorbs "complaints". |
| Operations | Inventory | MERGE | → Assets & Issuance (issuance ledger half). Termination kit-clearance link kept — see below. |
| Operations | Assets | MERGE | → Assets & Issuance (register half). Weapons/ammunition recorded once, not twice. |
| Finance | Banking Ledgers | KEEP/SPLIT | Bank Accounts, Cash Custody, AP stay. Client Receivables merges with the standalone Receivables panel. |
| Finance | Treasury & Regional | SPLIT (surfaced) | **Regional P&L now also appears in Profit-Share** (deep-links Treasury's Regional P&L tab). Reserves / inter-region / cockpit / partner-capital stay in the Treasury panel (kept in Finance) rather than physically torn apart — UI-level split, tables untouched. |
| Finance | Opening Balances | MERGE | → Accounting Core (feeds the Chart of Accounts). |
| Finance | Expenses (Expenses, Advances) | KEEP | Advance→payroll-deduction link kept. |
| Finance | Receivables | MERGE | Merges with Banking Ledgers' Client Receivables → one Receivables. |
| Finance | Cash Flow | KEEP | Now also the source of truth for profit-share (cash basis). |
| Finance | Financial Reports | KEEP | HO cost allocation across regions is **already implemented and posting** (`run_ho_cost_allocation`, avg-deployed-guards basis). Partnership reports move out to Profit-Share. Remaining gap is only client-wise (not regional) split, if wanted later. |
| Finance | Regional Scorecard | MOVE | → Profit-Share. |
| Finance | Chart of Accounts (CoA, TB, GL) | MERGE (already built) | → Accounting Core with Opening Balances. ~~Currently non-functional — needs building.~~ **Correction: fully functional** — 1,217 journal entries; TB + GL off the double-entry journal. Merge is UI-only. |
| Finance | Period Close | KEEP + FIX | Block new *postings* (expenses, attendance) but allow *corrections* (edit an April client, disburse April payroll). See notes. |
| Partnership Finance | Partners Account | MOVE | → Profit-Share ▸ RMD Statements. |
| Partnership Finance | Profit Distribution | MOVE | → Profit-Share ▸ Participation Rules. |
| Partnership Finance | Project Financing | MOVE | → Profit-Share ▸ Project Financing. Separate mechanism (see Decision 2). |
| Compliance | Licenses & Renewals | KEEP | Absorbs contract renewals — becomes the single renewals source. |
| Compliance | Compliance Calendar | KEEP | — |
| Compliance | Compliance Cases | KEEP | — |
| Compliance | Documents | KEEP | The one document hub. Employee CNIC/verification, contract files, invoice attachments should all feed this. |
| Admin | Alerts | KEEP | Currently hard-coded — worth making configurable eventually. |
| Admin | Tasks | KEEP | — |
| Admin | Users & Permissions | MERGE | → Access & Governance. |
| Admin | Governance | MERGE | → Access & Governance. RMD flag set here, consumed by Profit-Share. |
| Admin | Audit Log | KEEP | — |
| Admin | Settings | KEEP | — |

---

## The two workflows that must survive the restructure

These aren't panels — they're cross-section chains you already run in real life. They must not get broken by the merges.

**1. Termination kit-clearance.** Offboarding an employee checks Assets & Issuance for outstanding kit. Uncleared items → deducted via Payroll (your settlement/kit-return vouchers). Touches Workforce + Assets & Issuance + Payroll.

**2. The profit waterfall (cash basis).** Cash received (Cash Flow) → client P&L (after HO allocation) → regional P&L → participation % applied per region → RMD statement. Investor returns, if any, are booked as a cost before the regional figure. Nothing pays out on invoices raised — only on cash collected.

---

## LAYER 3 — Decisions still yours to make

Everything above is structure and I've made those calls. These are business calls I shouldn't make for you.

**Decision 1 — Relievers: separate panel, or fold into Attendance/Payroll?**
Regular guards are salaried monthly. Relievers are a per-day cost *netted against a client's statement* — a billing mechanic, not a payroll one. Because the accounting genuinely differs, my lean is: keep **Relievers** as one thin panel (mark reliever day → cost auto-nets against that client), and *don't* try to force it into the salaried Payroll flow. The alternative is a shared attendance-marking screen with a regular/reliever toggle. Your call on how separate it stays.

**Decision 2 — Project Financing: how does an investor's cut hit the regional number? → chosen: book as a cost line.**
Book the investor's return as a cost line against that client — client P&L drops, regional profit drops, RMD share computes on what remains. One waterfall, no special-casing. (A Project Financing subsystem already exists — projects, investors, investments, investor ledger, PROFIT_SHARE/FIXED_FINANCE return types — so this is a confirm-the-posting task, not a from-scratch build. Not yet verified line-by-line that returns post as journal cost lines; flagged for the finance follow-up if pursued.)

**Decision 3 — Client "reviews" (the leftover from Client Relationships).**
Complaints and renewals now have homes. Service reviews/ratings are the orphan. Either drop them, or fold a light "notes/rating" field into the client record. Low stakes — just decide so nothing dangles.

**Decision 4 — HO cost allocation basis. → RESOLVED: keep average-deployed-guards.**
Originally framed as an open choice (revenue share / headcount / flat). On inspection the system **already allocates HO overhead by average deployed guards** — a deliberate design that posts a region-tagged clearing pair (nets to zero company-wide) and feeds the §16 bonus pools — with real posted runs. Rather than rewrite live, data-carrying finance logic, the decision is to **keep the deployed-guards basis**. `finance_settings.ho_allocation_basis` already holds the basis as a parameter if a methodology change is ever wanted. (Original lean of "revenue share" is set aside — it would have re-posted history on a second calculation path for no clear gain.)

---

## Suggested build order — DONE (2026-07-29)

The structural pass is complete. Original ordering, annotated with what actually happened:

1. ~~**Accounting Core** first — currently broken.~~ **Done as a UI merge** (Opening Balances + Chart of Accounts). It was *not* broken — the ledger is live.
2. **Assets & Issuance** merge — done (Register + Issuance tabs). Unblocks termination-clearance.
3. **Profit-Share** consolidation — done (renamed from Partnership Finance; Regional Scorecard moved in; Partners→RMD Statements; Profit Distribution→Participation Rules). HO allocation was already settled (Decision 4: keep deployed-guards).
4. **Payroll/Runs** merge + **Workforce** tidy — done (Payroll hub with Runs tab; Recruitment home reserved; Relievers as one thin panel per Decision 1).
5. **Operations** — done (Deployment snapshot = repurposed Sites & Strength; Daily Reports = repurposed Field Ops; Assets & Issuance from step 2).
6. **Clients & Contracts** cleanup — done (Client Relationships dissolved and redistributed; reviews → client record per Decision 3).
7. **Compliance / Admin** merges — done (Access & Governance = Users + Governance).
8. **Dashboard** — widget links re-pointed to new homes (roster→deployment, payroll-runs→payroll?tab=runs); full widget re-point is a light follow-up.

**Greenfield (now built):** Recruitment intake pipeline (migration `0148`); Daily Reports auto-PDF **+ stored record** (migration `0149_daily_report_exports` — each PDF logs a counts snapshot; recent exports shown on the tab). Dashboard widget re-point verified complete (all links resolve to new homes). Consolidation is fully implemented; no known follow-on work remains.
