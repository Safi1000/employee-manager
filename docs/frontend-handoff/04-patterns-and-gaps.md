# 04 — Interactive Patterns to Preserve, and Known Gaps

## Part A — Behaviours that carry logic (do not break these while moving boxes around)

### A1. Permission gating: `hasPermission()` hide-or-disable
- Every page computes booleans once at the top (`const canEdit = hasPermission(profile, "x.edit")`)
  and wraps controls: `{canEdit && <Button…>}`. Some **columns** are conditional too
  (Assignments & Pay pay columns need `assignments.accounts`; Invoices' Status cell is an inline
  `ThemedSelect` for editors and a badge for viewers). Some **tabs** are conditional (Invoices
  "Generate", Attendance "Shift Management", Banks & Ledgers tabs, Financial Reports "Cash Basis").
- When you move a button into a card footer, an overflow menu, or a mobile action bar, move the
  **condition with it**. The DB refuses unauthorised writes anyway, but the result is a red error
  banner the user shouldn't have been able to trigger.
- `RequirePermission` also redirects to `/super-admin` — deep links a user can't open land on the
  Dashboard silently. Don't add client-side redirects on top.

### A2. Payroll Run — single-open accordion with a live embed
- `PayrollRun.tsx` holds `expanded: string | null`. Exactly one client card is open; opening
  another closes the first; a search that hides the open card closes it (effect at ~line 364).
- The open card mounts `<PayrollManagement clientScopeId categoryScope throughNet runInline siteGrouped/>`,
  which reports totals back (`onTotals`, `onRows`) — the two summary cards above the list switch
  from "all Review clients" to "this client" while one is expanded. Keep the accordion single-open;
  the totals logic assumes at most one live embed.
- Inside that embed, `runInline` **portals the salary-calculation panel into a table row** directly
  beneath the selected employee (`createPortal` → `accordionHost`), instead of the desktop side
  drawer. This is already a mobile-friendly shape; reuse it rather than inventing a second one.

### A3. Payroll Management — salary drawer
- Standalone, the drawer is `w-full lg:w-[400px] lg:sticky lg:top-4 lg:overflow-y-auto` with a
  **measured** `maxHeight` (from the page's scroll container via `scrollRef`), so it fits under
  whatever banners are showing. Below `lg` it already stacks under the table. If you change the
  scroll container, the measurement breaks — keep `scrollRef` on the element that scrolls.
- Selecting a row (`selectedId`) opens the drawer; the X closes it. Payment mode drives which
  selector appears (Cash → custodian, Bank → bank, Cheque → cheque).

### A4. The Monthly Board (`AttendanceSheetModal`) — flag for a separate conversation
- Renders the **exact grid the Excel export produces**: 4 frozen lead columns (Ser. 44px · Name
  210px · Desg. 52px · Emp # 96px = **402px**), then 2×N day columns (one per shift per day, so
  up to ~93 columns for a 3-shift client), then 5 total columns; two sticky header rows
  (measured height, not constant); legend; P/A/L/DD/X marks colour-coded. Sticky is applied
  **per cell**, never on `<thead>`/`<tr>` (there is a long comment explaining why — read it).
- On a 390px phone the frozen block alone is wider than the viewport, so the day grid is unreachable.
  Options are all trade-offs (drop Desg./Emp # below `md`, shrink Name, switch to a per-guard
  vertical list, or accept "landscape/desktop only" with a message). This needs a product
  decision, not a CSS fix. `docs/MOBILE.md` deliberately left it as a scrolling table.
- OPS Verify / Un-verify / Download live in the header; a `sm:hidden` compact toolbar already exists.
- The same shape recurs in `BulkMarkByEmployeeModal` (7-column month calendar with shift chips) and
  the Attendance Timesheet calendar (`grid grid-cols-7`).

### A5. Custodian selectors with live balance
- `lib/custodian.ts` → `loadCustodianOptions(companyId, withBalances)` returns office staff +
  partners with `held` cash. Pages render `<ThemedSelect>` options as
  `"{name} — holds PKR {held}"` **only when** `canViewBanking` (`banks.view`); otherwise the bare
  name. Expenses additionally `window.confirm`s when the amount exceeds the held balance.
- Used in: Invoices Record/Edit Payment (Cash), Expenses Add/Edit (Cash), Fixed-expense approval,
  Advances, Payroll disburse (Cash), Payroll Adjustments settle, Banks & Ledgers Cash Deposit /
  Withdraw to Cash / Record Payment / Cheque (cash type). Any redesign of these selects must keep
  the balance text conditional on the permission — it is a data-exposure rule, not a style choice.

### A6. Amount-in-words, live
- `<AmountInWords value={form.amount}/>` sits directly under an amount `<input>`; it re-renders on
  every keystroke and renders nothing for blank/0/NaN. Present on Invoice payment forms, Expense
  forms, Payroll disbursement, Cash Deposit, Withdraw to Cash, Wire Transfer. Keep it visually
  attached to its input (it reads as the input's helper text).

### A7. `ThemedSelect` is portalled
- The options panel is `position: fixed; z-index: 9999` on `document.body`, positioned from the
  trigger's `getBoundingClientRect`, flips upward when short on space, repositions on scroll/resize.
  It therefore escapes `overflow: hidden` cards and modal bodies — good — but on a phone with the
  keyboard open, `window.innerHeight` shrinks and the panel may flip. A `required` ThemedSelect
  carries a hidden mirror `<input required>` so native form validation still fires.
- `ClientFilterSelect` is **not** portalled (`absolute z-30`), so it can be clipped by an
  `overflow-x-auto` toolbar. Watch for this if you put it inside a horizontally scrolling filter row.

### A8. `Modal` contract
- Body is the only scroller; `footer` is pinned. Android back / Escape close it. Errors go in the
  `error` prop (inline banner at the top of the body), not a page banner. Sizes `sm/md/lg`.
- Many older modals put their button row at the bottom of `children` — on a phone that row can
  be several screens down. Moving those rows to `footer` is a safe, mechanical improvement.
- Modals stack (Modal inside Modal: Partner detail → Record payment; Contract editor → duplicate
  warning; Bank & Ledgers cheque detail → bounce). Both are `z-50`; the later one paints on top by
  DOM order.

### A9. Sticky action column on wide tables
- Employees and Assignments & Pay tables end with `<th/td class="sticky right-0 z-10 bg-card …">`
  so View/Edit remain visible during horizontal scroll. The background **must stay opaque** (see
  the comment at Employees ~line 2364). If you convert these to cards, the sticky column goes away;
  if you keep the table, keep the opacity.

### A10. Deep-link focus (`?focus=<id>&focusType=<table>`)
- `lib/focus.ts`. Journal rows link to Invoices/Payroll/Expenses (and Treasury, which only reads the param) with both params; the
  destination scrolls to and highlights the row, resolving the period first where needed
  (Payroll). Card layouts must keep a stable `id`/ref per record so the scroll-into-view still
  has a target on mobile.

### A11. Header actions and page-level state
- `Header actions` is a `flex flex-wrap gap-2` — with 3 buttons (Employees: Export · Generate
  documents (n) · + Add Employee) it wraps to two lines on phones. Several pages already collapse
  labels with `hidden sm:inline`. An overflow "⋯" menu for secondary actions would fit the
  existing `secondary`/`ghost` hierarchy.
- Tab selection is URL-synced only for `TabHub` (`?tab=`) and Banks & Ledgers (initial `?tab=`).
  Other tabs are local state and reset on navigation.

### A12. Region context
- `useRegion()` filters most finance/ops queries. The selector lives in the top bar and is hidden
  entirely for single-region companies. The explanatory sentence next to it is already
  `hidden lg:inline`. Don't move the selector into a page — pages assume it is global.

### A13. Native shell rules (only when `html.native`)
- 44px minimum tap targets are **injected by CSS** for every `button`/`[role=button]` unless
  `.no-min-target` (which instead gets an invisible 8px hit-area halo). Dense table icon buttons
  rely on `.no-min-target`. Anything `fixed` must offset by `var(--safe-top)`. `h-dvh`, never
  `h-screen`. Wide tables need `overflow-x-auto` (momentum scrolling is attached to that class).

### A14. Trial Balance footer is computed in the browser on purpose
- `CLAUDE.md` §"Reading versus computing": the footer total is the sum of displayed rows so it can
  never disagree with them. Don't replace it with a fetched total, and don't extend the pattern.

---

## Part B — Known gaps / things that will complicate the responsive pass

Ranked roughly by how much they will hurt.

1. **The Monthly Board grid** (A4). Frozen lead columns total 402px; up to ~100 columns. Needs a
   design decision before code.
2. **Banks & Ledgers** (`Accounting.tsx`, 5,400 lines, 9 tables of 6–9 columns, 21 modals, 106
   state variables). No card view anywhere. The tab bar + per-tab filter row is one `flex-wrap`
   card header that becomes 3–4 lines tall on a phone. Cheques and Cash Deposits are a second
   segmented control *inside* the Bank Accounts tab.
3. **Payroll Management** (4,200 lines) — table + measured sticky drawer + portal accordion + 3
   embedding modes (`standalone`, `siteGrouped` shell, `runInline` inside Payroll Run). A layout
   change has to be tested in all three. Toolbar has fixed `w-[220px]`/`w-[240px]` search boxes.
4. **Employee edit modal** — the largest form: Basic · Candidate · Ex-Service · Identity
   Verification · Bank · 5 collapsible HR sections with nested child tables
   (`grid-cols-[1fr_auto_auto_auto]`) · Salary history · Documents. Grids already stack at `sm`,
   but nested tables and the `[lg]` modal (896px) on a 390px screen are cramped, and the button row
   is in `children`, not `footer`.
5. **Hard minimum widths on tables**: `Companies` `min-w-[880px]`, `UserManagement`
   `min-w-[720px]`, `CompanyDetail` `min-w-[640px]`, `RegionalScorecard` `min-w-[620px]/[640px]`.
   These force horizontal scroll regardless of content and defeat any card conversion until removed.
6. **~40 grids with no breakpoint** (`grid grid-cols-2|3` and fixed templates like
   `grid-cols-[1fr_7rem_7rem]`, `grid-cols-[10rem_1fr]`, `grid-cols-2 gap-x-4` in the Client
   detail). Mostly inside modals: Expenses (5), Accounting (4), Payroll (4), Employees (3),
   InventoryStore (3), ComplianceCases (3), Assets (2), Partner modals (5), Contract view (2).
   Mechanical to fix (`grid-cols-1 sm:grid-cols-2`) but each needs a glance for
   label/value pairs that should stay side by side.
7. **Side-by-side stat rows inside modals**: Client Statement (5 cards `grid-cols-2 sm:grid-cols-5`),
   Payslip Preview (`grid-cols-2 sm:grid-cols-5`), Attendance Details (3). Five cards in two
   columns leaves an orphan; consider 1–2 columns below `sm` or a compact list.
8. **Four tab styles** (design-system §4.2). Solid pills wrap onto multiple lines (`flex-wrap`);
   Expenses and Financial Reports already use `overflow-x-auto` + `whitespace-nowrap`, which is
   the better phone behaviour. Standardising on one scrollable strip is a small, high-value change.
9. **Fixed-width controls**: `w-56` filter selects (fine where `md:w-56`/`sm:w-56` — Attendance
   board, Bulk-mark picker; bad where bare `w-56` — Payroll Run search, Payroll Management),
   Contract editor `w-48` inputs, `w-80` date-range popover (Attendance ExportMenu), `w-64` region dropdown,
   `min-w-[16rem]` (Leave), `min-w-[200px]` searches, `max-w-[160px]/[180px]` truncations.
10. **Inline banners instead of toasts**. Success/error messages render at the top of the page
    scroller; after acting far down a long list on a phone, the user never sees them. Modal
    errors are fine (pinned in the modal). Not strictly responsive, but it will be reported as
    "nothing happened" on mobile.
11. **`window.confirm()` in 27 files** for destructive actions — renders as the OS/browser dialog.
    Works everywhere, looks foreign in the native shell. Leave unless asked.
12. **Two coexisting class vocabularies** (`slate-*`/`bg-white` vs `border`/`bg-card`/`foreground`)
    — both resolve to the same tokens; do not "normalise" one into the other as part of this work,
    it doubles the diff for no visual change.
13. **Raw Tailwind colours that ignore dark mode** (`amber/emerald/violet/indigo/teal/purple`) in
    Accounting cheque chips, Attendance DD chip, Companies/Employees/Partners/CashCustody banners,
    RegionalScorecard bars, InvoiceStructure. Cosmetic; fix opportunistically with `tone.*`.
14. **Charts**: `ResponsiveContainer` with fixed heights (250/260/280). Pie legend grid stacks at
    `md`. OK on tablets; on phones the legend list is long. Recharts is only on Dashboard and
    Expenses.
15. **`ResponsiveTable` has zero call sites**; `MobileCardList` is the pattern the codebase
    actually adopted. For consistency, use `MobileCardList` for existing tables and consider
    `ResponsiveTable` only for genuinely new ones (or delete it).
16. **`docs/MOBILE.md` is slightly stale**: it lists Assets & Issuance among `MobileCardList`
    adopters; the rebuilt Store/Issuance/Clearance pages don't use it. Everything else in that
    document checks out against the current tree.
17. **Two legacy layouts** (`HRLayout`, `AccountsLayout`) and five dead pages (see architecture
    §3) still compile. Don't spend time on them.
18. **Sidebar mobile drawer is `w-72` (288px)** — on a 320px device that leaves a 32px backdrop
    strip. Fine on 360px+.
19. **Login**: two-column at `lg` only; below that the brand panel disappears entirely — this is
    already the intended phone layout.
20. **Font scaling**: the 85% root on phones means any `text-[11px]` label becomes ~9.35px and
    `text-[10px]` becomes 8.5px. Those micro-labels (card headings, `dt`s in MobileCardList,
    badge counts) are the first things that become illegible; consider a floor for them.
