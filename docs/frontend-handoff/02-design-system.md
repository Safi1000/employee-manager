# 02 — Design System

Everything in this file comes from `src/styles/theme.css`, `src/styles/mobile.css`,
`src/app/lib/tone.ts`, and the components in `src/app/components/`. Where a value is "what most
pages do" rather than a token, it is marked **(convention)** and the count behind it is given.

## 1. Colour

### 1.1 How the palette is wired (read this first)

The app was written with stock Tailwind `slate-*` neutrals and `bg-white`. `theme.css` then
**remaps those names to CSS variables** and inverts the neutral ramp under `.dark`:

```css
@theme inline {
  --color-white:     var(--surface-1);   /* bg-white follows the theme */
  --color-slate-50:  var(--n-50); … --color-slate-900: var(--n-900);
  --color-gray-*:    same ramp
}
```

So `bg-white`, `text-slate-900`, `border-slate-200` are **theme-aware** and correct in dark mode.
Two vocabularies therefore coexist in the JSX and mean the same thing:

| Older pages say | Newer pages say | Resolves to |
|---|---|---|
| `bg-white` | `bg-card` | `--surface-1` / `--card` (#fdfaf3 light, #1b1e17 dark) |
| `bg-slate-50` | `bg-background` (page) / `bg-muted` | warm paper (#f6f2e9 / #f3eee2) |
| `border-slate-200` | `border-border` | #e3dcc9 light, #2e3125 dark |
| `text-slate-900` | `text-foreground` | #191a10 / #ece6d6 |
| `text-slate-500` | `text-muted-foreground` | #837c67 / #8a8b76 |

Don't "fix" one into the other; both are fine. What is **not** theme-aware: raw Tailwind colours
like `bg-amber-50`, `text-emerald-700`, `bg-violet-50`, `text-indigo-700` — a handful survive
(Accounting cheque-type chips, Attendance shift chips, a few warning banners in Companies /
Employees / Partners / Cash Custody). They look wrong in dark mode; leave them unless you are
already in that block.

### 1.2 Semantic accents

Declared in `@theme` as 500/600/700; the 50/100/200 tints are generated with `color-mix` into the
current surface so they auto-darken.

| Token | 500 | 600 | 700 | Meaning (from `tone.ts`) |
|---|---|---|---|---|
| `brand` | `#e9a73c` amber | `#cf8f28` | `#9a6414` | identity, primary button, active tab/nav, focus ring. **Overridable per company** to green or steel via Settings → Appearance (`lib/theme.ts`). |
| `success` | `#4faa84` emerald | `#3f8e6d` | `#2f6f55` | cleared, disbursed, paid, received, present, active |
| `danger` | `#d4674a` rust | `#bb5238` | `#97402b` | overdue, failed, absent, expired, fired, destructive |
| `warning` | `#e9a73c` (= brand) | `#cf8f28` | `#9a6414` | pending, due soon, draft-ish, attention |
| `info` | `#5f86a8` steel | `#4d6f8d` | `#3c5670` | draft, scheduled, neutral status, double duty |

Tints: `-50` = 14% mix, `-100` = 26%, `-200` = 42%. Text on a tint is `-700` in light and
`-500` in dark (`text-success-700 dark:text-success-500`).

Solid brand/warning surfaces use **dark text** `text-[#241a06]`; the other solids use `text-[#fff]`.

### 1.3 Surfaces, neutrals, misc (light → dark)

| Var | Light | Dark |
|---|---|---|
| `--background` (page) | `#f3eee2` | `#0e100b` |
| `--card` / `--surface-1` / `--popover` | `#fdfaf3` | `#1b1e17` |
| `--secondary` / `--muted` / `--accent` (hover fills) | `#efe8d9` | `#23261d` |
| `--border` / `--input` | `#e3dcc9` | `#2e3125` |
| `--input-background` | `#fbf7ec` | `#14160f` |
| `--sidebar` | `#fbf6ea` | `#14160f` |
| `--ring` | `#e9a73c` | same |
| neutral ramp `--n-50…950` | #f6f2e9 → #0e0f08 | inverted #17190f → #f5f0e3 |
| chart-1..5 | amber, emerald, steel, rust, olive (#a98b45) | brighter variants |

### 1.4 Status → colour, as actually used

The canonical mapping is `toneOfStatus()` in `lib/tone.ts` (used by `<Badge status=…>`):

- **success**: cleared, paid, disbursed, received, active, completed, done, present
- **danger**: overdue, failed, rejected, absent, expired, critical
- **warning**: pending, due, leave, partial, in_progress, warning, high
- **info**: draft, todo, info, scheduled, medium
- **neutral**: everything else

Pages that hand-roll badges follow the same colours (spot-checked): Invoices Paid/Overdue/else →
success/danger/warning; Employees Active/On Leave/Inactive/Fired → success/warning/secondary/danger
(dot + pill); Contracts (`ContractStatusBadge`) active/expired/terminated/draft →
success/slate/danger/warning; Incidents severity low/medium/high/critical → slate/warning/danger/**solid
danger-600**; Tasks columns todo/in_progress/done → info/warning/success top borders; Payroll
fully-disbursed client card → `bg-success-50 border-success-300`; Attendance marks P/A/L/DD/X →
success/danger/warning/info/muted.

### 1.5 The left-accent summary card

The pattern you asked about. Two implementations, same look:

```
<div class="bg-card border border-border border-l-4 border-l-success-500 rounded-xl p-5">
  <p class="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Total Disbursed</p>
  <p class="text-2xl font-semibold tabular-nums text-success-700 dark:text-success-500" style="font-family:var(--font-display)">PKR 1,234,000</p>
  <p class="text-xs text-muted-foreground mt-1">12 payslips</p>
</div>
```

- `StatCard` component (Dashboard): `tone.<t>.statCard` = `bg-card border border-border border-l-4 border-l-<t>-500 rounded-xl`, `p-5 md:p-6`, 11px uppercase label, `text-3xl` display-font value, optional trend line, 44px icon tile on the right, hover lift.
- Inline copies (Invoices, Accounting, Payroll, Expenses, Financial Reports, Attendance detail, Client Statement…): older ones use `bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-<tone>-500` with `text-[11px] uppercase tracking-wide text-slate-500` label and `text-2xl` value. Accent colours in use: `brand`, `success`, `warning`, `danger`, `slate-400` (neutral/opening).
- A **compact inline tile** variant (Attendance board, Assignments & Pay, Employees counts): `inline-flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-card` with icon + `text-xs uppercase` label + `text-base font-semibold tabular-nums` value, laid out with `flex flex-wrap gap-2`. Employees uses a `grid grid-cols-2 md:grid-cols-4 gap-3` of `bg-card border rounded-xl px-4 py-3` count tiles, one of which is a clickable filter (`ring-2 ring-danger-500/30` when active).

## 2. Typography

| Role | Face | Size / weight | Where set |
|---|---|---|---|
| Body | **Hanken Grotesk** (`--font-sans`) | root 16px; `-webkit-font-smoothing: antialiased` | `body` in theme.css |
| Display / headings | **Bricolage Grotesque** (`--font-display`) | `h1` 2xl, `h2` xl, `h3` lg, `h4` base; weight 700, `letter-spacing: -0.02em`, `line-height: 1.15` | `h1–h4` base rule; also applied via inline `style={{fontFamily:"var(--font-display)"}}` on big numbers |
| Ledger figures | **JetBrains Mono** (`--font-mono`) | `.font-ledger` utility; `td, th { font-variant-numeric: tabular-nums }` globally | theme.css |
| Page title | `Header` h2 | `text-lg md:text-xl font-bold tracking-tight` | Header.tsx |
| Page subtitle | `text-xs text-muted-foreground truncate` | | Header.tsx |
| Section heading inside a card **(convention)** | `<h3 class="text-base text-slate-900">` (Dashboard, Settings, Financial Reports) or `text-base font-bold text-foreground` (newer) | | |
| Table header **(convention, 152×)** | `<th class="text-left px-6 py-3 text-sm text-slate-500">` (older) · 53× `px-4 py-3 text-xs text-slate-500 uppercase` · newer `text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground` | | |
| Table cell **(convention)** | `px-6 py-3.5 text-sm text-slate-900` (older) / `px-3 py-2 text-sm` (dense) | | |
| Form label **(convention, 334×)** | `<label class="block text-sm text-slate-700 mb-1">` | | |
| Read-only field label (`Field`) | `text-xs text-slate-500 uppercase tracking-wide` + `text-slate-900` value | Field.tsx |
| Card metric label | `text-[11px] uppercase tracking-[0.12em] text-muted-foreground` | StatCard |
| Badge | `text-xs font-medium` (or `text-[11px]`) | tone.ts |
| Helper / hint | `text-xs text-muted-foreground` or `text-[11px]` | |
| Amount in words | `text-[11px] italic text-muted-foreground mt-1` | AmountInWords.tsx |
| Base `label` element | `font-size: var(--text-base); font-weight: 600` | theme.css (note: Tailwind classes on the label override this in practice) |
| Base `button` | `font-weight: 600` | theme.css |

**Mobile density:** below 768px `:root { font-size: 85% }` (`mobile.css`). Because every
Tailwind spacing/text/radius value is rem-based, the *whole UI* is 15% smaller on phones —
type, padding, gaps, icons — except `dvh`, `env()` safe areas and hard `px` values. Inputs,
selects and textareas are forced to `16px` on phones so iOS Safari does not zoom on focus.
**Consequence for you:** a `text-sm` cell that is 14px on desktop is ~11.9px on a phone. If you
add explicit phone sizes, remember the root is already scaled.

## 3. Spacing, radius, shadow, layout conventions

| Thing | Value |
|---|---|
| Base radius token | `--radius: 0.75rem` → `rounded-lg` = 12px, `rounded-md` ≈ 10px, `rounded-xl` = 16px |
| Card container **(convention)** | `bg-white rounded-lg border border-slate-200` (older, 17×+) / `bg-card rounded-xl border border-border` (newer). Padding `p-4` or `p-6`; card headers `p-4 border-b border-border` or `p-6 border-b border-slate-200`. |
| Page gutter | `px-3 py-4 md:p-8` (29 pages) · variants `px-4 md:px-8 py-6`, `px-3 py-4 md:p-8 space-y-4` |
| Header bar | `px-3 md:px-8 py-3 md:py-2.5 md:min-h-16` |
| Top bar | `px-2 md:px-8 py-1.5 min-h-12` |
| Sidebar widths | desktop `w-64` (collapsed `w-16`), mobile drawer `w-72`; header row `h-16` |
| Section gap | `mb-6` / `space-y-6` between cards; `md:mb-8` on Dashboard |
| Grid gaps | cards `gap-4 md:gap-6`; forms `gap-3` or `gap-4`; tiles `gap-3` |
| Form grid | `grid grid-cols-1 sm:grid-cols-2 gap-3|4` (dominant); `sm:grid-cols-3` for date/amount trios; `grid-cols-2 sm:grid-cols-5` for stat rows |
| Table density | header `py-3` (older) / `py-2` (dense); rows `py-3.5` / `py-2`; `divide-y divide-slate-200` on `tbody`; row hover `hover:bg-slate-50` or `hover:bg-accent/50` |
| Inputs | `w-full px-3 py-2 border border-slate-200 rounded-md text-sm` (102×) + optional `focus:outline-none focus:ring-2 focus:ring-slate-900` (59×). Newer: `border-border bg-card`. Number spinners hidden globally. |
| Search input | `pl-10` (or `pl-9`) with an absolutely-positioned lucide `Search` icon `left-3 top-1/2 -translate-y-1/2 w-4 h-4`; usually `flex-1 min-w-[200px]` or `w-[220px]` |
| Shadows | cards none; hover `hover:shadow-md`; popovers `shadow-lg`; modal `shadow-lg`; ThemedSelect panel `shadow-xl shadow-black/20` |
| Scrollbar | 10px themed (webkit) |
| z-index ladder | Header sticky `z-20` · dropdown panels `z-30` · mobile backdrop `z-40` / AI FAB `z-40` · mobile drawer & Modal `z-50` · BusyOverlay `z-[100]` · InactivityLogout `z-[200]` · ThemedSelect portal `z-9999` · AppUpdateBanner `z-[9999]` |

## 4. Reusable component patterns (what exists, and its exact shape)

All in `src/app/components/`. These are the only shared visual primitives; everything else is
inline classes.

### 4.1 `Button`
`variant`: `primary` (`bg-brand-500 text-[#241a06] hover:bg-brand-600 shadow-sm`) · `secondary`
(`bg-card border border-border hover:border-brand-500/50 hover:bg-accent`) · `ghost`
(`text-muted-foreground hover:bg-accent`) · `danger` (`bg-danger-600`) · `success` (`bg-success-600`).
`size`: `sm` `px-3 py-1.5 text-sm` · `md` `px-4 py-2 text-sm` · `lg` `px-6 py-2.5 text-base`.
All `rounded-lg font-medium inline-flex gap-2`, focus ring `ring-ring/60`. **Hierarchy in
practice:** one `primary` per header (the "Add X" action), `secondary` for Export / secondary
actions, `ghost` for row actions (View / Edit / Rehire), `danger` for destructive confirms.
417 `<Button>` uses vs 274 raw `<button>`s — the raw ones are tab pills, icon buttons, and
link-style text buttons.

### 4.2 Tabs — four coexisting styles
1. **`Tabs` component** (the declared "canonical" one, used on 3 pages: Attendance board top
   tabs, Employees profile modal, Sites & Strength): outlined pills, `rounded-md border`, active
   `border-brand-500 bg-brand-500/15 text-brand-700`, optional count bubble. `inline-flex flex-wrap`.
2. **Solid brand pill** (TabHub, Banks & Ledgers, Employees Active/Waiting/Terminated,
   Financial Reports, Expenses — 11 pages): `px-4 py-2 rounded-md text-sm`,
   active `bg-brand-600 text-[#fff]`, inactive `text-slate-600 hover:bg-slate-100`. Container is
   `flex gap-2 flex-wrap` or, on Expenses/Financial Reports, `overflow-x-auto` + `whitespace-nowrap`.
3. **Segmented track** (Payroll Run, Financial Reports basis toggle): `inline-flex rounded-lg
   bg-slate-100 p-0.5`, active thumb `bg-card text-brand-700 shadow-sm`.
4. **Underline tabs** (Invoices Invoices/Generate, Clients detail modal, Governance, Compliance
   Cases, Assets register): `flex gap-1 border-b border-slate-200`, buttons `px-4 py-2 text-sm
   -mb-px border-b-2`, active `border-brand-500 text-brand-700 font-medium`, inactive
   `border-transparent text-slate-500`.

### 4.3 `Modal`
`fixed inset-0 z-50 flex items-center justify-center` + backdrop `bg-black/50 backdrop-blur-sm`.
Panel: `bg-white rounded-lg shadow-lg w-full mx-3 md:mx-4 max-h-[90dvh] flex flex-col`, width by
`size`: `sm` `max-w-md` (448px) · `md` `max-w-2xl` (672px) · `lg` `max-w-4xl` (896px). Three
regions: header `p-4 md:p-6 border-b` (title `text-base md:text-lg truncate`, X button), body
`p-4 md:p-6 overflow-y-auto flex-1 min-h-0` (the only scroller; optional inline `error` banner
pinned at top), optional `footer` `px-4 md:px-6 py-3 border-t`. Escape and Android back close it.
Safe-area margins applied. **Not every modal uses `footer`** — many older ones put the button
row at the end of `children` (`flex justify-end gap-2 pt-4`), so it scrolls with the body.
Two modals bypass `Modal` entirely: `AttendanceSheetModal` (own `max-w-[95vw] max-h-[92dvh]`
shell) and `BusyOverlay`.

### 4.4 `Badge` / status pills
`tone.<t>.badge` = `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium
bg-<t>-50 text-<t>-700 dark:text-<t>-500 border border-<t>-200`. Hand-rolled equivalents drop
the border (`inline-flex items-center px-2 py-0.5 rounded text-xs bg-x-50 text-x-700`, 11×+).
Employees adds a 6px status dot. Counts use `min-w-[18px] h-[18px] text-[10px] rounded-full`.

### 4.5 `ThemedSelect`
Drop-in for `<select>`: a `<button>` trigger (`bg-input-background border border-border
rounded-md text-sm`, chevron) that portals a `role=listbox` panel to `document.body` at
`position: fixed; zIndex: 9999`, `max-h-64`, flips upward when short on space. Hidden
`<input required>` mirrors native validation. **130+ uses.** Native `<select>` is almost gone
(1 use) but is globally styled anyway (custom chevron, `appearance: none`).

### 4.6 `ClientFilterSelect`
Searchable combobox: trigger `w-full md:w-56 … border rounded-md text-sm bg-white` with search
icon, label, clear ×, chevron; dropdown `absolute z-30 mt-1 w-full md:w-72 … shadow-lg` with an
autofocused filter input and `max-h-64` list. Used on Employees, Contracts, Invoices, Payroll,
Attendance timesheet, Expenses, Documents, Bulk-mark modal.

### 4.7 `Header`
See architecture §5. `title` may be a node (Financial Reports puts a segmented toggle in it).

### 4.8 `StatCard`, inline stat tiles — §1.5 above.

### 4.9 `MobileCardList` and `ResponsiveTable`
- `MobileCardList` — renders **only** the phone cards (`md:hidden divide-y`), designed to sit
  next to an untouched `<table>` wrapped in `hidden md:block overflow-x-auto`. Props: `title`,
  `subtitle`, `badge`, `fields[]` (2-col `dl`, `full` spans), `tags`, `actions` (footer, click
  doesn't bubble), `onClick`, `accent` (left border colour). Used on 11 page files (10 live + the dead `SitesStrength`), 12 lists (see §5).
- `ResponsiveTable` — one column definition, both renderings (`hidden md:block` table + `md:hidden`
  cards; `primary`, `hideOnMobile` per column). **Exists but currently has zero call sites.**
  It is the intended shape for new tables.

### 4.10 Small things
`Field` (label/value for detail views) · `Alert` (tone banner) · `AmountInWords` · `ExportButton`
(secondary + Download icon) · `BusyOverlay` · `GuardCapBanner` · `ContractStatusBadge` ·
`ThemeToggle` (36px square) · `RegionSelector` (dropdown `w-64`) · `_TabHub` (URL-synced tabs).

### 4.11 Feature components (large, page-like)
`ContractEditorModal` (1,700 lines — contract lines table `Category | Notes | Committed | Rate/month | Line value`, addendums, `w-48` fields) · `InvoiceGenerate` (Generate tab: drafts table + per-draft line editor) · `AttendanceSheetModal` (Monthly Board, see patterns doc) · `BulkMarkByEmployeeModal` (month calendar, 7-col grid, shift chips) · `FireGuardModal` · `DisciplinaryWarningsModal` · `ShiftSplitModal` · `PartnerFormModal` / `PartnerDetailModal` · `ExpenseApprovalModal` · `ExportFieldsModal` · `CategoryPicker` · `CameraCapture` · `DocumentInput` · `PersonalChecklist` (Tasks) · `ActivityFeed`, `DashboardAttachments` (Dashboard) · `AiChatWidget` · `InactivityLogout` · `ProfileModal`, `ChangePasswordModal`, `ForcePasswordChange`.

## 5. Current responsive behaviour — an honest inventory

**Breakpoints in use:** `sm` 640 (198 uses, almost all `grid-cols-1 sm:grid-cols-2` on form
fields), `md` 768 (283 uses — the real mobile/desktop switch), `lg` 1024 (38 uses — Dashboard
2-up grids, Payroll salary drawer, Login split, Expenses 3-col metrics, top-bar scope sentence).
`xl` is never used. There is no container-query or JS-media-query usage except
`components/ui/use-mobile.ts` (unused).

### Already done (works today on a 390px phone)
- **Shell**: sidebar → off-canvas drawer with backdrop; hamburger in the top bar; region scope
  sentence hidden below `lg`; header stacks title/actions (`flex-col md:flex-row`); page gutter
  shrinks to `px-3 py-4`; 85% root font; 16px inputs; safe-area insets; `dvh` everywhere in the shell.
- **Modal**: `mx-3`, `p-4`, `max-h-[90dvh]`, body scrolls, footer pinned (where `footer` prop is used).
- **Forms**: 81 grids are `grid-cols-1 sm:grid-cols-2` (stack on phones).
- **Tables**: 108 of 121 `<table>`s sit in an `overflow-x-auto` (or `overflow-auto`) container, so they
  scroll sideways inside their card instead of the page.
- **Card lists** (`MobileCardList`, `md:hidden` next to `hidden md:block` table): Employees,
  Assignments & Pay (per group), Clients, Contracts, Invoices, Incidents, Licences, Compliance
  Calendar (Important Dates), Sites & Strength (dead page), Expenses (Expenses + Advances tabs),
  Users & Permissions. (`docs/MOBILE.md` lists Assets & Issuance too; the current
  `InventoryStore`/`KitIssuance`/`Clearance` files do **not** use it — that page was rebuilt since.)
- **Sticky action column** on Employees and Assignments tables (`sticky right-0 z-10 bg-card`) so
  View/Edit stay reachable while the row scrolls.
- **Attendance Sheet modal** has a `sm:hidden` compact toolbar row and `hidden sm:flex` desktop one.
- **Header buttons** with `hidden sm:inline` labels (icon-only on phones) in a few places
  (Assignments "Assign employees"/"Edit rules", Attendance "Monthly Board").
- **AI widget** panel width `min(420px, 100vw - 2rem)`, height uses `dvh` and safe areas.

### Not done / only partially done
- **Finance ledgers**: Banks & Ledgers (9 tables, up to 9 columns, 18 modals), Accounting Core
  (Chart of Accounts, Trial Balance, Journal, Opening Balances), Financial Reports, Cash Flow,
  Treasury, Partners, Partnership Run, Regional Scorecard — all scroll-only tables, no card view.
  `RegionalScorecard` has `min-w-[620px]`/`min-w-[640px]` tables. `Companies` (SSA) has
  `min-w-[880px]`, `CompanyDetail` `min-w-[640px]`, `UserManagement` `min-w-[720px]`.
- **Attendance**: daily board is nested cards → per-site `<table>` (7 cols) in `overflow-x-auto`;
  the Monthly Board (`AttendanceSheetModal`) is a frozen-lead-column grid with 4 sticky columns
  totalling **402px** — on a 390px phone the frozen block alone exceeds the viewport (see gaps).
  Timesheet page (`AttendanceManagement`) has two tables + a 7-col calendar.
- **Payroll**: main table + a `lg:w-[400px] lg:sticky` salary drawer that stacks under the table
  below `lg`; toolbar has fixed `w-[220px]`/`w-[240px]` search boxes. Payroll Run's Review
  accordion embeds the same table inline.
- **Modals with side-by-side content**: Employee Profile (2-col `dl`), Employee Edit (5 collapsible
  HR sections, 2/3-col grids — these do stack via `sm:`), Contract Editor (lines table + `w-48`
  fields), Edit Rules (`grid-cols-[1fr_7rem_7rem]` rows, no breakpoint), Client Statement (5 stat
  cards `grid-cols-2 sm:grid-cols-5` + 2 tables), Payslip Preview (`grid-cols-2 sm:grid-cols-5`).
- **Fixed pixel widths** still present: `w-56` filter selects (fine — `md:w-56` mostly),
  `w-[220px]`/`w-[240px]`/`min-w-[180px]` search inputs (Payroll), `w-[400px]` drawer,
  `w-80` date-range popover (Attendance), `w-96`/`w-72` on Login, `min-w-[200px]` search (Employees,
  Trial Balance), `max-w-[160px]`/`max-w-[180px]` truncations, `min-w-[16rem]` (Leave).
- **Non-breakpoint grids** (`grid-cols-2`/`-3` with no `sm:`): ~40 occurrences, mostly inside
  modals and detail panels (Expenses 5, Accounting 4, Payroll 4, Employees 3, InventoryStore 3,
  ComplianceCases 3, Employee Profile `grid-cols-2 gap-x-4` detail list).
- **Tab strips** that wrap onto 2–3 lines on phones (`flex-wrap`) rather than scroll: TabHub,
  Banks & Ledgers, Employees, Financial Reports (this one scrolls), Attendance (`Tabs` wraps).
- **Dense pages with no responsive classes at all**: `ContractedVsDeployed`, `AddendumTable`,
  `ContractViewModal`, `ContractCyclesModal`, `PartnerDetailModal`, `PartnerFormModal`, `ShiftSplitModal`, `FireGuardModal`,
  `ExpenseApprovalModal`, `DisciplinaryWarningsModal` — all small enough that the modal shell
  carries them, but their internal `grid-cols-2`s don't stack.
- **Dashboard** charts: recharts `ResponsiveContainer` with fixed heights (250/260px; Expenses pie 280px); pie +
  legend grid stacks at `md`. Fine on tablets, cramped on phones.
- **Toasts**: none. Success messages are inline banners at the top of the page scroller — on a
  phone the user often can't see them after acting further down. Not a responsive bug, but it
  surfaces as one.
