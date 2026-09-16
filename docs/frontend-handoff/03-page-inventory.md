# 03 — Page-by-Page Inventory

Format for each page: **Purpose** · **Layout** (the actual component/DOM hierarchy, top to
bottom) · **Tables** (exact column headers; type notes) · **Cards/metrics** · **Modals** (title
→ size → contents) · **Page-specific patterns** · **Mobile today**.

Conventions used throughout, so they are not repeated: every page starts with `<Header title
subtitle actions/>` (sticky) followed by a scroller `<div class="flex-1 overflow-y-auto px-3 py-4
md:p-8">` unless stated otherwise; "card" means `bg-white|bg-card rounded-lg|xl border`; filter
selects are `ThemedSelect` (~`md:w-56`); every table is `<table class="w-full">` inside
`overflow-x-auto` unless flagged; "Actions" columns hold `ghost` `Button`s or icon buttons; row
counts/line counts refer to the source file. Permission keys shown as `key`.

Line counts are given so you can gauge effort: anything > 2,000 lines is a multi-day page.

---

## Overview

### Dashboard — `pages/super-admin/Dashboard.tsx` (1,100)
**Purpose.** Landing page: headline counts, money-in/out this month, bank overview, live activity,
charts, upcoming compliance, contracts ending, incidents, period-close state. Every widget is
gated on a `hasPermission` *and* on Settings → Dashboard Widgets toggles (`show("bank_overview")`…).
**Layout.**
```
Header "Dashboard" / subtitle = today's date
scroller (px-3 py-4 md:p-8)
  [empty-state card "Nothing to show yet" if no widgets visible]
  grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6      ← StatCard row 1
  grid … lg:grid-cols-4                                                ← StatCard row 2
  grid grid-cols-1 [lg:grid-cols-2] gap-6                              ← Bank Account Overview | Top Clients (by payments this month)
  card "Live activity" → <ActivityFeed/> (rows animate in, .feed-row-fresh)
  card "Expenses by category" → grid grid-cols-1 md:grid-cols-2 (recharts PieChart 250px | legend list)
  grid grid-cols-1 [lg:grid-cols-2]                                    ← "Attendance Trend · Last 7 Days" (LineChart 260px) | "Compliance · Overdue and Next 60 Days" (list)
  grid grid-cols-1 [lg:grid-cols-2]                                    ← "Contracts ending" (list) | "Recent incidents" (list)
  card "Period Close Status"
  <DashboardAttachments/>                                              ← file list + upload
```
**Cards.** `StatCard`: Total Employees (brand) · Attendance Today (present/absent/leave breakdown) ·
Expenses · <month> (danger, trend vs prev) · Payroll · <month> (warning, trend) · Active Contracts
(brand) · Open Incidents (danger if >0 else info) · Compliance due <30d (danger if overdue).
**Tables.** None — lists are `divide-y` rows with `p` text.
**Modals.** None.
**Mobile today.** Grids stack at `md`; charts are fixed-height `ResponsiveContainer`s.

### Tasks — `Tasks.tsx` (800)
**Purpose.** Kanban-style task board (admins assign; others see "My Tasks") + a personal checklist.
**Layout.** Header (title switches "Task Board"/"My Tasks") → scroller → `grid grid-cols-1 md:grid-cols-3 gap-4` of three columns (To do / In progress / Done, each `bg-white border border-slate-200 border-t-4 border-t-{info|warning|success}-500`) holding task cards → `<PersonalChecklist/>` below.
**Modals.** "New Task" [md], "Edit Task — {title}" [md]: title, description textarea, assignee `ThemedSelect`, due date, status, priority; `grid grid-cols-1 sm:grid-cols-2`.
**Mobile today.** Columns stack. Fine.

### My Profile — `MyProfile.tsx` (600) — no permission (employee link is the entitlement)
**Purpose.** A logged-in employee's own record: pay history, advances, attendance, documents, warnings, cash held if custodian.
**Tables.** Payslips: `Month | Present | Base | Bonus | Advance | Deductions | Net | Paid | Status`. Advances: `Date | Amount | Mode | Notes`. Both `overflow-x-auto`, no card view; 2 non-breakpoint `grid-cols-2`.

---

## Clients & Contracts

### Clients — `Clients.tsx` (1,660) — `clients.view|edit`
**Purpose.** Master client records with tax profile, billing address, contacts, bank details; each client's contracts and invoices in a detail view.
**Layout.**
```
Header "Clients" [actions: + Add Client (primary, clients.edit)]
scroller
  filter card: grid grid-cols-1 md:grid-cols-4 gap-3 → search (name/code) | status tabs All/Active/Inactive | Industry select | Branch select
  list card
    <MobileCardList/>  (title=name, subtitle=code, badge=Active/Inactive, fields Industry/Branch/Employees/Contracts, actions View/Edit)
    hidden md:block overflow-x-auto <table>
```
**Table.** `Client | Industry | Branch | Employees (count) | Contracts (count) | Status (badge) | Actions (View · Edit · Delete/Deactivate)`. Client cell shows name + mono code.
**Modals.** "Add Client" [lg] / "Edit Client" [lg] — sections: identity (name, code, industry, branch, status), contacts (billing email, phone, signatory), tax (NTN, STRN, filer/non-filer, tax name/rate rows), billing address textarea, bank (title, account/IBAN, bank), notes; grids `sm:grid-cols-2`. Detail modal `{client name}` [lg] — inner underline tabs Overview / Contracts / Invoices / Documents: Overview = `grid grid-cols-2 gap-x-4` `Field`s (**no breakpoint**); Contracts tab table `Code | Type | Period | Status | Guards | Rate | Edit` (opens `ContractEditorModal`); Invoices table `Invoice | Date | Amount | Received`; Documents = contract PDF link.
**Patterns.** Status pills; `window.confirm` on delete; `contracts.edit` gates the Edit column inside the detail modal.

### Contracts — `Contracts.tsx` (775) — `contracts.view|edit`
**Purpose.** Contract list across clients; opens the shared contract editor/viewer/renew/cycles modals.
**Layout.** Header [+ New Contract] → scroller → filter row (`ClientFilterSelect`, status `ThemedSelect`, search) → list card → `MobileCardList` + `hidden md:block` table.
**Table.** `Code | Client | Type | Period (start–end) | Guards (active/allotted) | Weapons & equipment | Value/mo | Status (ContractStatusBadge) | Document (link/upload) | Actions (View · Edit · Renew · Cycles · Delete)`. Sort headers on Period / Guards / Value.
**Modals (shared components).** `ContractEditorModal` [lg] — header fields (client, code, type, dates, billing group), **contract lines table** `Category | Notes | Committed | Rate / month | Line value` with inline inputs (`w-48`), addendum section (`AddendumTable`: `Effective | Change | Category / Line | Shift | Source | Reference`), footer Save; a nested "This client already has a contract" [sm] confirm. `ContractViewModal` "Contract {code}" [lg] — read-only `Field` grid (`grid-cols-2`, no bp) + lines table with extra `Active` column. `ContractRenewModal` [md]. `ContractCyclesModal` "Cycles — {code}" [lg].
**Mobile today.** List OK; editor modal internals not adapted.

### Invoices — `Invoices.tsx` (2,040) + `components/InvoiceGenerate.tsx` (1,290) — `invoices.view|edit`
**Purpose.** Invoice ledger with payments, PDF export, and a Generate tab that drafts one invoice per active contract per month.
**Layout.**
```
Header "Invoices" [actions: Invoice Structure (secondary) · + New Invoice (primary)]
scroller
  underline tabs (flex gap-1 border-b; active border-b-2 border-brand-500 text-brand-700): Invoices | Generate (Generate only with invoices.edit)
  [Ledger]
    grid grid-cols-1 md:grid-cols-3 gap-4 → stat cards Total Invoiced (brand) · Total Received (success) · Outstanding (warning)
    list card: toolbar (ClientFilterSelect, status ThemedSelect, month) → MobileCardList → hidden md:block table
  [Generate] <InvoiceGenerate/>
```
**Tables.** Ledger: `Invoice # | Client | Invoice Month | Invoice Amount | Received | Outstanding | Status (ThemedSelect inline when invoices.edit, else badge) | Attachment (Drive link / upload) | Actions (PDF · Record Payment · Payments · Edit · Delete)`. Payments (inside Edit Invoice): `Date | Amount | Mode | Notes | Actions` with `sticky top-0` thead. Generate: drafts table `Invoice # | Client | Contract | Billed month | Contract window | Amount | (Cleared ✓) | …` then per-draft line editor `Description | Qty | Rate | Amount | (remove)` with variable-column grid variant (`min-w-[110px]/[90px]` inputs).
**Modals.** "New Invoice" [md] (client → contract selects, month, amount, notes; `sm:grid-cols-2/3`), "Edit Invoice" [md] (+ payments table), "Record Payment" [md] (date/amount/mode; Bank → bank `ThemedSelect`; Cash → **custodian `ThemedSelect` with held balance**; `AmountInWords` under amount), "Edit Payment" [md], `InvoiceStructureModal` "Invoice Structure" [lg] (Company Branding: logo/name/address/prefix; Template Options: 3 auto-selected PDF templates).
**Patterns.** Deep-link `?focus=<id>&focusType=invoices|invoice_payments` (`lib/focus.ts`) scrolls to and highlights a row; Generate drafts persist server-side (`invoice_generation_drafts`).

---

## Workforce

### Employees — `EmployeeManagement.tsx` (6,000) — `employees.view|edit`
**Purpose.** The full employee record: roster, hire/fire lifecycle, identity verification, salary history, documents, ID history, PDF forms/ID cards, Excel export.
**Layout.**
```
Header "Employee Management" [Export (secondary) · Generate documents (N) (secondary) · + Add Employee (primary)]
scroller
  <GuardCapBanner/>                                     ← plan-limit warning
  grid grid-cols-2 md:grid-cols-4 gap-3                 ← count tiles: Registered · Active · Inactive · No CNIC / Join Date (clickable filter)
  list card
    toolbar: flex flex-wrap gap-2 → search (flex-1 min-w-[200px]) · "Filters (n)" toggle button · Sort by ID button · solid-pill tabs Active | Waiting List | Terminated (ml-auto)
    [filtersOpen] second row: ClientFilterSelect + 7 ThemedSelects (category, shift, completeness, lifecycle, CNIC expiry, duplicate CNIC, branch)
    [Waiting List tab] sub-tabs Rehire | Fresh
    <MobileCardList/> (accent = danger for fired, title=name, subtitle=display code, badge=lifecycle pill, fields Phone (tel: link) / Client · Category, actions View · Edit · Rehire · Hire)
    hidden md:block overflow-x-auto <table>
```
**Table.** `Employee ID (mono display code + permanent code) | Name (+ warning chips: incomplete / CNIC expired) | Phone | Client / Category | Physical Copy (toggle) | Status (dot + pill) | Actions (View · Edit · Rehire · Hire)` — Actions is **`sticky right-0`** with opaque bg. Row left border `border-l-2` coloured for fired.
**Modals (10).**
- "Add Employee" [lg]: `FormSection`s Basic Information · Candidate Details (intake) · Ex-Service · Bank Details · Documents (`DocumentInput` + `CameraCapture` photo); all `sm:grid-cols-2/3`.
- "Edit Employee" / "Hire — complete employee record" [lg]: same + Identity Verification panel (verify/unverify/amend with reason), **`EmployeeHrSection`** = 5 collapsible `FormSection`s (Personal Information · Emergency Contact · Ex-Service · Experience · Internal Office Data) with child tables (children, references, previous jobs — `grid grid-cols-[1fr_auto_auto_auto]`), Family/References/Checklist, Salary increments & history panel (`set_employee_salary`, table `Effective date | Base | Allowance | Reason`), Add Documents.
- "Employee Profile" [lg]: `Tabs` Profile | History; Profile = `grid sm:grid-cols-2` `Field`s + documents list + Download Form PDF / ID card; History = Employee ID History, Shift changes, Payroll disbursements, Payslip corrections (`PayrollAdjustmentHistory`), link to Attendance Timesheet.
- "Employee ID History" [sm] · "Incomplete — {name}" [sm] (missing fields list) · "Generate documents — N guard(s)" [sm] (`BulkGenerateModal`: data form / ID card, progress table) · "Rehire — {name}" [sm] (`RehireModal`: client, line, salary) · "Change client" [sm] · "Change category" [sm] · "Change shift — {name}" [sm] · `ExportFieldsModal` "Export employees — choose columns" [lg].
**Patterns.** Collapsible form sections auto-open on the first invalid field; inline field-error summary; `window.confirm` once; 24 `ThemedSelect`s, 66 inputs. Raw `bg-emerald-100`/`bg-amber-50` chips (non-token).
**Mobile today.** List is done. The edit modal is the hardest form in the app (5 sections, nested tables).

### Assignments & Pay — `EmployeeAssignments.tsx` (3,540) — `assignments.view` (+ `assignments.accounts` for pay columns, `assignments.hr` for posting actions)
**Purpose.** Employees grouped by client (and Office Staff / Relievers / "Not on a contract line"), with contracted-vs-enrolled reconciliation, bulk pay-rule editing, posting, transfer, fire.
**Layout.**
```
Header "Assignments & Pay" [Export]
scroller
  [error/notice banners]
  flex flex-wrap gap-2 → compact tiles: Contracted (billed) · Enrolled (active) · Sites · Clients mismatched
  flex flex-wrap gap-3 → search clients (flex-1 min-w-56) · show-fired toggle · expand/collapse all
  one card per group (client / office / relievers / unposted):
    header row: chevron · name · hint (hidden md:inline) · recon badges (contracted/enrolled/gap) · buttons Assign employees / Edit rules (labels hidden sm:inline)
    [open] per-site sub-headers →
      <MobileCardList/> (md:hidden)
      hidden md:block overflow-x-auto border-t <table>
```
**Table (per group).** `☐ | Code | Name | Department | Shift | [Base | Per day | Allowance | Joined/Left on ← assignments.accounts only] | Edit (sticky right-0)`. Checkbox column drives bulk selection → "Edit rules — {scope}".
**Modals.** "Edit rules — {scope}" [lg] (`EditRulesModal`: pay mode fixed/variable, bucket rows `grid grid-cols-[1fr_7rem_7rem]` **no bp**, annual increment, location/branch, affected-employee table `Employee | Base | Allowance` with `sticky top-0` thead) · "{employee name}" [lg] (`RowEditModal`: Posting (category, shift, contract line, dates), Pay, Other details, Shift history) · "Assign employees to {site}" [lg] (`AssignEmployeesModal`: search + candidate list + shift/line) · "Transfer {name}" [sm] · "Fire / Resign — {name}" [sm] (`FireGuardModal`) · "Disciplinary Warnings — {name}" [sm] · Change client / Change category [sm] (reused from Employees).
**Patterns.** 11 `whitespace-nowrap` cells; `sticky` used 5×; group expand state; `hint` text hidden below `md`.

### Attendance — `AttendanceBoard.tsx` (1,810) + `ShiftManagement.tsx` (275) + `components/AttendanceSheetModal.tsx` (895) + `components/BulkMarkByEmployeeModal.tsx` (725) — `attendance.view|edit`
**Purpose.** Daily board: presume present, record exceptions per site, supervisor confirms per site; vacancies queue; shift management; Monthly Board (OPS verification); bulk mark; Excel/PDF exports.
**Layout.**
```
Header "Attendance"
scroller (space-y-4)
  <Tabs/> Daily board | Vacancies (count) | Shift Management (assignments.hr)
  [board]
    filter card: flex flex-col md:flex-row gap-2 → group ThemedSelect (md:w-56) · search (flex-1) · Bulk Mark by Employee (attendance.bulk_mark) · ExportMenu (md:ml-auto; dropdown w-80 with date-range picker)
    date row: prev/next day, date input, "Monthly Board" (label hidden md:inline)
    flex flex-wrap → compact tiles Confirmed x/y · On ground · Exceptions · Awaiting
    one card per client (bg-card rounded-lg overflow-hidden)
      client header (name, reported badge, Monthly Board button)
      per site: header (site name, reported badge, Monthly Board) → <table>
  [vacancies] <VacancyQueue/> card → table (no thead): client · reason · opened date · Dismiss
  [shifts] <ShiftManagement/>: per-client cards → table `Code | Name | Department | Shift | (Change shift)`
```
**Board table (per site).** `Shift | Contracted | Deployed | Reported (names, truncate max-w-[160px]) | Exceptions | Status (badge) | (Report/Confirm button)`.
**Modals.** `ShiftDrillModal` "{client} — {site}" [lg]: roster list with per-guard status pills Present/Absent/Leave/Double Duty (`ThemedSelect` for absent reason, reliever source), supervisor name, override reason → Confirm. `BulkMarkByEmployeeModal` "Bulk Mark by Employee" [lg]: `ClientFilterSelect` + employee picker (`w-56`), **month calendar** (7-col), per-date shift chips D·N·E, status Present/Absent/Leave/Double Duty, mark/clear. `AttendanceSheetModal` — **the Monthly Board** (own shell, not `Modal`): see patterns doc; `ShiftSplitModal` "Shift structure — {client}" [md].
**Patterns.** Attendance gate messages (blocked / override_required); status chips use raw `bg-violet-50` for DD in one place; `attendance_gate` RPC.
**Mobile today.** No card view; nested cards → tables scroll. Monthly Board is the acknowledged hard case.

### Attendance Timesheet (corrections) — `AttendanceManagement.tsx` (2,030) — reached from Employees → History; also `/relievers` as **Relievers** (`relieversOnly`)
**Purpose.** Per-employee month calendar for corrections; reliever day marking (pick site covered); attendance history; Excel export.
**Layout.** Header (title varies) → scroller → compact tiles → filter card (`ClientFilterSelect`, site/shift `ThemedSelect`s, month input, search) → Employees table card → Attendance History card (table) → calendar panel (`grid grid-cols-7 gap-1.5`, day cells).
**Tables.** Employees: `Employee ID | Name | (mark buttons) | Location | Shift | Status | (Monthly Board link)` with inline `ThemedSelect`s for status/site. History: `Date | Location | Client | Present | Absent | Leave | Actions`.
**Modals.** "Attendance Details" [lg] (3 stat cards Present/Absent/Leave `sm:grid-cols-3` + day list), "Export attendance to Excel" [sm], "Attendance details — {name}" [sm], `BulkMarkByEmployeeModal`.
**Mobile today.** `min-w-[110px]/[140px]/[200px]` inputs; 2 non-bp grids.

### Payroll (Payslips tab) — `PayrollManagement.tsx` (4,210) — `payroll.view|edit|adjust`; also `/relievers/payroll` (`relieversOnly`) and embedded in Payroll Run
**Purpose.** Period payslips per client/group: attendance-driven salary calc, disbursement (cash/bank/cheque with custodian), mark paid, cheque tracking, adjustments, payslip PDF, export sheets.
**Layout (standalone).**
```
Header "Payroll Management" [Export payroll sheets · Disburse selected / Mark all disbursed (payroll.edit)]
[danger banner if a period is closed]
scroller (ref'd; drawer height measured from it)
  grid grid-cols-1 md:grid-cols-3 gap-4 → stat cards Total Disbursed (success) · Total Not Disbursed (warning) · Total Advance (danger)   [siteGrouped shell adds a 4th: Total Salaries (brand), md:grid-cols-4]
  [siteGrouped] Finance-verified client "shell" cards (bg-success-50 when fully disbursed) → each embeds <PayrollManagement afterNet runInline siteGrouped/> for that client
  flex flex-col lg:flex-row gap-6
    left (flex-1 min-w-0): list card → toolbar (search w-[220px] min-w-[180px] · period ThemedSelect · ClientFilterSelect · category/status/branch ThemedSelects · tabs All/Active/Fired) → overflow-x-auto <table>
    right: salary drawer  w-full lg:w-[400px] lg:sticky lg:top-4 lg:overflow-y-auto  (maxHeight measured)  — OR, when runInline, portalled into an accordion row under the selected employee
```
**Table.** `☐ | Employee (name, code) | Attendance (P/A/L/DD counts) | Base | Net Salary | Status (badge) | Actions (Preview · Disburse · Adjust)`. `bodyColCount` varies with `afterNet`/`runInline`.
**Salary drawer contents.** "Salary Calculation" [History badge if past period]; identity row; `grid grid-cols-2 sm:grid-cols-5` attendance counts (Working / Present / Double duty / Absent / Leave, overridden marker); earnings & deductions lines; leave override input; payment block: mode `ThemedSelect` (Cash → **custodian select with held balance**, Bank → bank select, Cheque → cheque select) + date; Raise adjustment.
**Modals.** "Export payroll sheets" [md] · "Payslip Preview" [lg] (`sm:grid-cols-2` header, `grid-cols-2 sm:grid-cols-5` attendance, Earnings & Deductions, printable) · "Disburse Selected" / "Mark All as Disbursed" [md] (mode/custodian/date; `AmountInWords`) · "Disbursement Date" [sm] · "Raise adjustment — {name}" [sm].
**Patterns.** `BusyOverlay` during bulk disbursement; `createPortal` for the inline accordion; `?focus=` deep link resolves period first; `banks.view` gates balance display.

### Payroll ▸ Adjustments — `PayrollAdjustments.tsx` (265) — `payroll.adjust`
Header "Adjustments" → "Open" list card → table (no `<th>` markup; rows: employee, period, amount ±, reason, status, Settle/Cancel). Modals: "Pay/Receive {amount}" [sm] (mode + custodian `ThemedSelect`s, date, note), "Cancel adjustment" [sm] (reason). `PayrollAdjustmentHistory` component shared with Employee Profile.

### Payroll ▸ Leave — `LeaveBalances.tsx` (240) — `payroll.edit` for overrides
Header "Leave" → two cards: "Lost at the cap" (table) and "A guard's balance, and how it got there" (employee `ThemedSelect` `min-w-[16rem]` → ledger table). Quota override input.

### Payroll Run — `PayrollRun.tsx` (875) — `payroll.view|edit`; Finance Verify needs `payroll.approve`
**Purpose.** Move each client/staff-group scope through Draft → Review → Finance Verify for a month.
**Layout.**
```
Header "Payroll Run"
scroller (px-4 md:px-8 py-6)
  flex flex-wrap justify-between → segmented tabs Draft (n) | Review (n) | Finance Verify (n)  ·  search (w-56) · month input · Export
  [Draft]  list of scope rows (icon, name, OPS-verified stamp or "not verifiable", → Send to Review)
  [Review] grid grid-cols-1 md:grid-cols-2 → stat cards Total Salaries (success) · Total Advance (danger) — scoped to the expanded client or all
           accordion: one card per scope; header row (chevron, icon, name, OPS stamp / "OPS unverified" chip, Export, Back to Draft, Send to Finance)
           [expanded === key] border-t → <PayrollManagement clientScopeId categoryScope throughNet runInline siteGrouped/>
  [Finance Verify] info banner + list rows with Finance Verify (permanent) / locked state
```
**Modals.** "Export payroll sheets" [md] · "Finance Verify — permanent" [sm] (danger callout + confirm).
**Patterns.** **Single-open accordion** (`expanded: string | null`); search hiding the open scope closes it; live totals bubble up from the embedded table via `onTotals`/`onRows` callbacks.

### Performance — `Performance.tsx` (530) — route only (hidden from nav) — `performance.approve`
Sections as cards: Enrollment (salaried staff) · KPI Dashboard (table `Employee | KPI | Target | Value | RAG`) · New appraisal (5 score inputs 1–5) · Appraisals · Appreciation (annual flat %) · Accrue bonuses · Guard bonus ledger. No modals.

---

## Operations

### Daily Reports — `DailyReports.tsx` → `FieldOps.tsx` (320) — `roster.view|edit`, `incidents.view`, `attendance.view`
**Purpose.** One written note per active client per day; export as branded PDF; export history.
**Layout.** Header "Daily Reports" → date picker row (sticky) → `grid` of client cards (`grid-cols-[…]`, 2 fixed-template grids) each with a textarea "Details for this client today…" and save state → exports table. Raw `text-amber-700` accents.

### Incidents — `IncidentsHub.tsx` → tabs **Incidents** (`Incidents.tsx`, 990) | **Client Complaints** (`ClientComplaints.tsx`, 113) — `incidents.view|edit`
**Incidents layout.** Header "Incidents" [+ Log Incident] → filter card (search, client/severity/category/status `ThemedSelect`s) → list card → `MobileCardList` + table.
**Table.** `Code | When | Client / Post | Severity (badge; critical = solid danger) | Category | Guards (chips, max-w-[180px]) | Status | Actions (Edit · Delete)`. Sortable When/Category/Status/Guards.
**Modals.** "Log Incident" [lg] / "Edit {code}" [lg]: occurred-at, client → post, severity, category, description textarea, response textarea, guards multi-pick with search ("Search guards…"), status; `sm:grid-cols-2`.
**Client Complaints.** Simple card with inline add form + table `Client | Raised | Description | Status`. Has a non-bp `grid-cols-2`.

### Assets & Issuance — `AssetsIssuance.tsx` → tabs Store | Issuance | Clearance | Register — `inventory.view|edit`, `banks.view`
- **Store** (`InventoryStore.tsx`, 895): Header "Store" → "Kit is required from" setting card → "Stock on hand" table (item, qty, actual cost, replacement cost; `sticky` header ×2) → "Item types" table. Modals: "New item type"/"Correct item type" [sm], "Paste item types" [lg], "Opening stocktake" [lg] (editable rows), "Record a purchase" [lg]. 3 non-bp grids, 4 `overflow-x-auto`.
- **Issuance** (`KitIssuance.tsx`, 400): Header "Issuance" → search → holdings table (guard, item, serial, condition, since). Modals: "Issue kit" [md] (guard/client/site/item/condition `ThemedSelect`s ×7), "Return to store" / "Handover to another guard" [sm].
- **Clearance** (`Clearance.tsx`, 415): two cards "Not cleared — Operations" (`clearance.ops`) and "Cleared by operations — Finance" (`clearance.finance`), each a table (guard, fired date, kit items, fines/dues, action). Modal "Assess kit — {name}" [lg] (per-item condition + suggested fine). Generates clearance certificate PDF.
- **Register** (`Assets.tsx`, 305): fixed assets table `Asset | Region | Cost | Accum. dep | NBV | Status | Action`; vehicles + logs form; ammunition counts table `Date | Issued | Accounted | Discrepancy`; four inline "New …" forms in cards. 2 non-bp grids.

---

## Finance

### Banks & Ledgers — `Accounting.tsx` (5,415) + `CashCustody.tsx` (1,090, as `CashCustodyPanel`) — `banks.view`, `receivables.view`, `payables.view`, `accounting.edit`
**Purpose.** Receivables (per client), payables, bank accounts + cheques + cash deposits, cash custody by custodian. Every money movement here is an RPC (`record_bank_transfer`, `record_cash_deposit`, `record_invoice_payment`…).
**Layout.**
```
Header "Banks & Ledgers" [actions vary by tab — banks: Transactions · Wire Transfer · Add Bank Account; cash-custody: Transactions · Record Transfer · Add Location; receivables/payables: History]
scroller
  [banks]        grid grid-cols-1 md:grid-cols-4 → Cash in Hand (success; "Set opening" link) · Bank Balance (brand) · Cheques in Transit (warning) · …
  [receivables]  grid grid-cols-2 md:grid-cols-5 → Opening (slate) · Total Invoiced (brand) · Withholding Tax (danger) · Total Received (success) · Outstanding (warning)
  [payables]     grid grid-cols-1 md:grid-cols-4 → Pending (warning) · Overdue (danger) · Paid (success) · total
  [cash-custody] grid grid-cols-1 md:grid-cols-3 → Total Cash in Hand (success) · Owed to Partners (Undrawn) (warning) · …
  main card (bg-white rounded-lg border mb-6)
    header p-6 border-b flex flex-wrap: solid-pill tabs Client Receivables | Accounts Payable | Bank Accounts | Cash Custody (filtered by permission) · tab-specific filters (ml-auto: search, month range, status ThemedSelects)
    [receivables] <table>
    [payables]    <table>
    [banks]       bank accounts <table> (row actions Withdraw · Edit) → "Cheques" / "Cash Deposits" segmented sub-view (chequeSectionView) with filters + "New Cheque" / "Cash Deposit" buttons → <table>
    [cash-custody] <CashCustodyPanel/>: "Cash Holdings" table · "Cash vs Liabilities" · "Partners Summary" table
```
**Tables (9).** Receivables `Client | Opening Balance | Invoiced | Withholding | Received | Outstanding | Actions (Statement · Record Payment · WHT · History)`. Payables `Vendor | Category | Client | Amount Due | Expense Date | Due Date | Status (Pending/Overdue/Paid) | Actions (Mark Paid · Revert)`. Banks `Bank Name | Account Number | Type | Owner | Account Balance | Cheque Balance | Total Balance | Actions`. Cheques `Cheque # | Type | Bank | Date | Recipient / Payer | Amount | Used / Linked | Status (pending/cleared/bounced) | Actions`. Cash Deposits `Slip # | Bank | Date | Amount | Deposited By | Reference / Notes | Actions`. Transaction log `Date | Kind | Account | Δ | Before → After | Description`. Client statement `Date | Entry | Reference | Account / Instrument | Invoiced | Received | Withholding | Balance` + invoices `Invoice # | Date | Amount | Received | Outstanding | Attachment`. Custody: `Location | Type | Holder | Opening | Held Cash | Status | Actions`; partners `Partner | Allocated | Contributed | Drawn | Net Balance | Cash Impact`; custody log `Date | Kind | Custodian | Δ | Before → After | Description`.
**Modals (21).** New Cheque / Record Deposit Cheque [md] · Bounce cheque #n [sm] · Cheque #n [lg] (detail + linked items table) · Add / Edit Bank Account [md] · Cash Deposit [md] (custodian source → bank; `AmountInWords`; deposit slip PDF) · Withdraw to Cash [md] (bank → custodian) · Wire Transfer [md] · Client Statement [lg] (5 stat cards `grid-cols-2 sm:grid-cols-5` + 2 tables) · Record Withholding Tax [md] · Edit Opening Balance [md] · Set Opening Cash Balance [sm] · Record Payment [md] · Mark Payable as Paid [md] · Export Bank Statement [sm] · Transaction Log [lg] · Receivables History [lg] · Payables History [lg] · Custody: Transaction Log [lg], Add/Edit Custodian [md], Record Custody Transfer [sm].
**Patterns.** 33 `ThemedSelect`s, 51 inputs, 106 `useState`s; raw `violet/emerald/indigo/teal/purple` chips for cheque kinds; `window.confirm` ×3; custodian selectors show "— holds PKR n".
**Mobile today.** Tables scroll only. Densest page in the app.

### Accounting Core — `AccountingCore.tsx` → tabs Opening Balances | Chart of Accounts | Trial Balance | Journal — `coa.view`
- **Opening Balances** (`OpeningBalances.tsx`, 455): "New batch" card (description, date, region) → lines table `Account | Region | Debit | Credit` with inline inputs → totals → Post. 1 non-bp grid.
- **Chart of Accounts** (`ChartOfAccounts.tsx`, 815): Header [Export · + Account] → filters (search, type, period `ThemedSelect`) → tree table `Code | Account (indented) | Debit | Credit | Net | (control/system chips, Edit)`. Modal "Edit {code}" [md].
- **Trial Balance** (`TrialBalance.tsx`, 360): period/branch `ThemedSelect` (`min-w-[200px]`), hide-zero toggle, Export → table `Code | Account | Debit | Credit` with **footer totals computed in the browser (deliberate, see CLAUDE.md)**.
- **Journal** (`JournalView.tsx`, 750): filters (source type chips: Invoice, Payslip, Payslip disbursement, Expense, Advance, Cheque, Custody transfer, Partner entry, Opening balance; account/client/partner `ThemedSelect`s `min-w-[180px]/[220px]`; date range) → entries table (date, entry, source link → `?focus=` deep link, account, debit, credit) → Export. Modal "Manual Journal Entry" [md] (line rows).

### Expenses & Advances — `Expenses.tsx` (4,805) — `expenses.view|edit` (+ `expenses.approve`, `banks.view` for balances)
**Layout.**
```
Header "Expenses" [Export · Manage Vendors · Categories · + Add Expense / + Add Advance (tab-dependent)]
scroller
  [warning banner]
  tab strip: flex gap-2 overflow-x-auto (shrink-0 whitespace-nowrap pills) → Expenses | Fixed Expenses (n pending) | Advances | Deferred (n open)
  [expenses]  grid grid-cols-1 lg:grid-cols-3 → "By category" list card (max-h-64 scroll) | lg:col-span-2 recharts pie card (280px)
              list card: toolbar (search, category/mode/expense-by ThemedSelects, ClientFilterSelect, month) → MobileCardList → hidden md:block overflow-auto max-h-[480px] table (sticky thead)
              "Category Management" card: grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 of category chips (edit/delete)
  [deferred]  "Deferred expenses" table
  [fixed]     card: filters → grid md:grid-cols-3 stat cards Awaiting Decision (warning) · Approved (posted) (success) · Denied (slate) → instances table
              "Recurring Definitions" card → table
  [advances]  card: toolbar (5 ThemedSelects) → MobileCardList → hidden md:block table
```
**Tables.** Expenses `Date | Category | Client | Description | Amount | Mode (Cash/Bank/Cheque/Payable chip) | Expense By | Actions (View · Edit · Approve · Delete)`. Fixed instances `☐ | Description | Category | Client / Vendor | Mode | Amount | Status | Actions`. Definitions `Description | Category | Client / Vendor | Mode | Paid By | Amount | Runs | Actions`. Advances `Date | Employee | Client | Amount | Mode | Paid By | Notes | Actions`. Deferred: schedule per prepaid expense.
**Modals (11).** Add / Edit Expense [lg] (date, category `CategoryPicker`, client (`ClientFilterSelect`, "Office (no client)"), vendor, description, amount + `AmountInWords`, mode → Cash: custodian select w/ balance & over-balance `confirm`; Bank: bank select; Cheque; Payable: due date; nature Cost of Services / Operating Expense; coverage: all-in-month / service period / prepaid schedule; receipts upload) · Add / Edit Advance [md] (employee search, amount, mode, custodian) · Add / Edit Fixed Expense [lg] · Edit {month} instance [md] · Approve / Deny fixed expense [md] · `ExpenseApprovalModal` Approve/Unapprove expense [md] · Expense Details [lg] (`sm:grid-cols-2` fields + receipts) · Manage Vendors [md] · Add / Edit Category [sm].
**Patterns.** 28 `ThemedSelect`s; `window.confirm` ×6; `min-w-[220px] max-w-[220px]` cell; 5 non-bp grids.

### Financial Reports — `FinancialReports.tsx` (1,385) + `CashFlow.tsx` (1,190) + `RegionalPerformance.tsx` (430) + `ContractedVsDeployed.tsx` (180) — `reports.view`
**Layout.**
```
Header title = "Financial Reports" + segmented toggle Revenue Basis | Cash Basis (Cash Basis needs cashflow.view) [Export]
scroller
  [Cash Basis] <Cashflow embedded/> — kept mounted after first open
  [Revenue Basis] main card
    header p-4 md:p-6 border-b overflow-x-auto → solid-pill tabs (min-w-max, whitespace-nowrap): Profit & Loss | Regional Performance | Client Statements | Contracted vs Deployed
    [pl]        p-6: "Profit & Loss Statement" + month/range ThemedSelects → sections Revenue / Cost of Services / Operating Expenses as line lists with totals
    [regional]  <RegionalPerformance/>: table `Region | Revenue | Own cost | HO allocated | Total cost | Net` + "Head office pool", "HO excluded", "Own cost by category" panels
    [clients]   grid grid-cols-2 md:grid-cols-6 stat cards → table `Client | Total Invoiced | Payroll Expense | Direct Expenses | Regional Overhead | Total Income | Actions (Statement)`
    [cover]     <ContractedVsDeployed/>: table `Client | Contracted | Deployed | Gap | Cost (PKR)` + Export (no responsive classes)
    [partnership — standalone page only] partner table `Partner | Profit Share | Actions` + <PartnershipPolicyPanel/> + PartnerFormModal / PartnerDetailModal
```
**Cash Flow (`Cashflow`).** Own Header when standalone; tabs Revenue | Payroll | Expenses | Advances | Cash Flow | Client Statements; tables `Date | Mode | Amount` and `Client | Cash Received | Payroll Paid | Direct Expenses | Regional Overhead | Net Cash | Actions`; "Cash Flow Statement" sections incl. Non-Operating Cash Movements.
**Modals.** "Full Client Statement" [lg] / "Full Client Statement (Cash Basis)" [lg]: 5 stat cards `grid-cols-2 sm:grid-cols-3|5` + invoices table. `PartnerDetailModal` "{partner}" [lg] (client shares table `Client | Share | Amount`, ledger `Date | Particulars | Cash Paid | Remuneration | Balance`, nested "Record payment" [sm]). `PartnerFormModal` [md].

### Partnership Run — `PartnershipRun.tsx` (550) — posting needs `partnership.post`
Header → month `ThemedSelect` + Draft / Post / Reverse buttons → blocker banner → "What this run pays" table `Partner | Kind | Share | Base | Amount | Net position` → "Live but never billed" list. `window.confirm` ×2.

### Period Close — `PeriodClose.tsx` (440) — `period_close.manage`
Header → table `Month | Invoices | Payments | Expenses | Payslips | Advances | Cheques | Status | Action (Close / Reopen)`. Modal "Close {month}" / "Reopen {month}" [md] with typed confirmation.

### Hidden-from-nav finance pages (routes still resolve)
- **Treasury & Regional Finance** (`Treasury.tsx`, 420): six tables — 13-week cash forecast `Week | Opening | Inflow | Outflow | Closing`; Cash entitlement `Region | Entitlement | Restricted reserve | Free | Inter-region net`; Regional P&L `Month | Region | Revenue | Direct cost | Allocated HO | Net profit`; Reserves `Reserve | Balance | Target | Shortfall | Fund`; Partner capital `Partner | Region | Capital balance`; Cash sub-ledgers `Location | Region | Balance`; plus "Request inter-region funding" form.
- **Partner Accounts** (`Partners.tsx`, 990): tables `Name | Scope | Method | Profit Share % | Status | Actions`; ledger `Date | Type | Particulars | Method | Drawing (Out) | Allocation (In) | Contribution (In) | Balance`; RMD Statements `Partner | Scope | Opening | Profit share | Holding for co. | Paid out | Net owed`. Modals Add/Edit Partner [md], Record Drawing / Contribution / Profit Allocation [sm].
- **Project Financing** (`ProjectFinancing.tsx`, 735): three tables (investors per project, investors, ledger); 4 modals; 13 `ThemedSelect`s.
- **Regional Operating Expenses** (`RegionalScorecard.tsx`, 1,070): region tiles + tables with **`min-w-[620px]`/`min-w-[640px]`**; raw `amber/indigo` bars.

---

## Compliance

### Compliance Calendar — `ComplianceHub.tsx` → tabs Compliance Calendar | Licenses & Renewals | Contract Renewals — `compliance.view|edit`
- **Calendar** (`Compliance.tsx`, 1,630): Header [+ Add Important Date · + Add Recurring Alert] → "Guard data coverage" card (vetting counts: Police verification, NADRA Verisys, CNIC number, CNIC expiry) → "Raised Alerts" list → "Calendar View" (`grid grid-cols-7 gap-2 max-w-2xl` month grid) → "Upcoming" → inner tabs Important Dates | Recurring Alerts → `MobileCardList` + table. Tables: `Title | Date | Category | Days Remaining | Advance Notice | Priority | Actions` and `Name | Category | Frequency | Trigger Day | Advance Notice | Status | Actions`. Modals: Add/Edit Important Date [md], Add/Edit Recurring Alert [md]. `min-w-[140px]/[220px]` inputs.
- **Licenses & Renewals** (`Licences.tsx`, 405): filter chips Expired / <30 days / <90 days / >90 days + category `ThemedSelect` + search → `MobileCardList` + table `Item | Category | Expiry Date | (days) | Status | Action`.
- **Contract Renewals** (`ContractRenewals.tsx`, 105): table `Client | Expected close | Stage` with inline add.

### Compliance Cases — `ComplianceCases.tsx` (300) — hidden route
Three cards with inline "New case" / "New filing" forms (3 non-bp grids) and tables `Case | Jurisdiction | Authority | Target | Stage | Advance`, `Type | Period | Due | Amount | Status | Action`; "Government visits" list.

### Documents — `Documents.tsx` (655) — `documents.view|edit` — hidden route
Header → search (`min-w-[240px]`) + `ClientFilterSelect` → table `Employee ID | Name | Phone | Location | Client | Shift | Documents (count chips, raw indigo) | Last Updated | Actions`. Modals "Employee Documents" [lg] (Drive file list, open/delete), "Upload Documents" [md].

---

## Admin

### Access & Governance — `AccessGovernance.tsx` → tabs Users & Permissions | Governance — **role** super_admin/SSA
- **Users & Permissions** (`UserManagement.tsx`, 890): Header [+ Create User] → search → `MobileCardList` + table (**`min-w-[720px]`**) `Name | Email | Title | Branch | Permissions (count / chips) | Actions (Edit · Reset password · Delete)`. Modals "Create User" [lg] / "Edit {email}" [lg]: identity fields (`sm:grid-cols-2`), role `ThemedSelect` (SSA-only for Super Admin), branch pin, employee link, **Permissions**: `PERMISSION_GROUPS` rendered as group cards with checkbox rows; "Reset Password" [sm].
- **Governance** (`Governance.tsx`, 155): three cards — Pending requests (approve/deny), Decision log, Action thresholds (department default permissions).

### Audit Log — `AuditLog.tsx` (615) — role super_admin/SSA
Header → filter card (table/action/user `ThemedSelect`s, UUID trace input, field search, date range) → table `When | User | Action | Table | Record (max-w-[180px]) | Fields changed` with expandable before/after JSON rows. 1 non-bp grid.

### Settings — `Settings.tsx` (1,085) — `settings.view|edit`
Header "Settings" → stacked cards: **Company Profile** (logo upload, display company name, your name/email; `md:grid-cols-2`) · **Regional Management** (branches list with inline edit rows, HO-exclusion toggle, Add Region) · **Appearance** (SA/SSA: three palette swatches Amber / Emerald / Steel Blue, `sm:grid-cols-3`) · **Dashboard Widgets** (checkbox grid `sm:grid-cols-2`) · **Notifications** (SA/SSA: alert email, toggles, test button; `md:grid-cols-2`). Modals "Add Region" [sm], "Re-include {region}" / HO-exclusion confirm [md].

### Plan & Billing — `Billing.tsx` (415) — `settings.view|edit`
No `Header` component; two cards `md:grid-cols-2`: plan (status badge Active/Trial/Payment failed/Unpaid/Cancelled/Incomplete; Monthly · Guards covered · Renews) and AI credit (Available now · Monthly allowance · Top-up balance · Buy more). Buy/manage buttons hidden on native (`canSellInApp`).

### Alerts — `Alerts.tsx` (110) — hidden route
Three list cards: Open alerts (blocking / warning) with Acknowledge, Live warnings, Dashboard summary.

---

## Super-Super-Admin

### Companies — `super-super-admin/Companies.tsx` (505)
No `Header`; page-level heading + "Add Company" card (form `md:grid-cols-2`) → table (**`min-w-[880px]`**) `Company | Contact | Users | Employees | Subscription | Status | Actions (View as · Detail · Deactivate · Payments)` → "Payment History" table `Date | Amount | Days | Notes`. Raw `amber` warning banner.

### Company Detail — `CompanyDetail.tsx` (280)
Company card + users table (**`min-w-[640px]`**) `Name | Email | Title | Actions`; modal "Reset Password" [sm].

---

## Public

### Login — `pages/Login.tsx` (235)
`grid min-h-dvh lg:grid-cols-[45%_55%]`: left brand panel `hidden lg:flex` (gradient blobs `h-96 w-96`, feature bullets); right `flex flex-col items-center justify-center px-6 py-12` with small brand mark (`lg:hidden`), email/password inputs, warning banner for stale session, "Built by TechxServe". `ThemeToggle` present. Form column is `w-full max-w-sm`; the `w-96`/`w-72` values are the decorative blobs.

### Signup / Signup Complete
Stripe plan picker and return page; desktop marketing copy; not shipped in the native app.
