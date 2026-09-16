# 01 — Architecture

## 1. Tech stack, and what each piece actually does here

| Layer | Package(s) | How it is really used in this repo |
|---|---|---|
| Build | `vite` 6, `@vitejs/plugin-react`, `@tailwindcss/vite` | `npm run dev` / `npm run build`. `@` aliases `src/`. `vite.config.ts` also writes `dist/build-id.json` so an open tab can detect it is stale (`lib/appUpdate.tsx`). |
| Language | TypeScript 6, `strict: true` | Types for every DB row live in `src/app/lib/supabase.ts` (2,500 lines — it is the schema, the permission catalogue, and the client). |
| UI runtime | React 18.3 | Function components + hooks. No state library; no react-query; no forms library. Every page owns its own `useState`s (Employee Management has 109 of them). |
| Routing | `react-router` 7 (`createBrowserRouter`; `createHashRouter` when native) | Single data-router in `src/app/routes.tsx`. Two authenticated shells, one public group. |
| Styling | **Tailwind CSS v4** (`@import 'tailwindcss'`), `tw-animate-css` | The only styling system in use. Theme tokens declared with `@theme` in `src/styles/theme.css`; no `tailwind.config.js`. Utility classes inline in JSX; a few `const inputCls = "…"` strings per page. |
| UI kit | `@mui/material`, `@mui/icons-material`, `@emotion/*` | **Installed, never imported.** Zero `@mui` imports in `src/`. |
| Primitives | 30 × `@radix-ui/react-*`, `class-variance-authority`, `cmdk`, `vaul`, `sonner`, `react-day-picker`, `embla`, `react-dnd`, `react-hook-form`, `motion`, `next-themes`… | **Installed, never imported by app code.** They are the dependency tail of the shadcn set in `src/app/components/ui/` (48 files), and nothing outside that folder imports from it. Delete-safe from the app's point of view; leave them alone for this task. |
| Icons | `lucide-react` | The only icon set. 113 files import it. Convention: `className="w-4 h-4" strokeWidth={1.5}`. |
| Charts | `recharts` | Two pages only: Dashboard (Pie, Line) and Expenses (category pie). `lib/chart.tsx` holds a shared tooltip. |
| Data | `@supabase/supabase-js` | One client (`lib/supabase.ts`). Pages call `supabase.from(...)`/`.rpc(...)` directly inside `useEffect`s; there is no data layer. Auth via `signInWithPassword`; edge functions via `supabase.functions.invoke`. |
| Files/exports | `xlsx`, `jspdf` | `lib/excel.ts` (all Excel exports), `lib/*Pdf.ts` (invoice, payslip, ID card, attendance sheet, clearance certificate, daily report). `lib/saveFile.ts` picks download vs. native share sheet. |
| Native | `@capacitor/*` 8 | Android + iOS shells wrapping the same `dist/`. Runtime branching through `lib/platform.ts` (`isNative`, `isIOS`, `isAndroid`, `canSellInApp`). CSS scoped to `html.native` in `src/styles/native.css`. See `docs/MOBILE.md`. |
| Fonts | Google Fonts via `<link>` in `index.html` | Bricolage Grotesque (display), Hanken Grotesk (body), JetBrains Mono (ledger figures). |

**Net effect for you:** the entire visual layer is Tailwind classes on plain HTML elements
(`<div>`, `<table>`, `<button>`, `<input>`), plus the small set of components in §4 of the
design-system doc. There is no theme provider, no `sx` prop, no `cn()` helper in use outside
`components/ui/` (the app's `Button` and `Modal` concatenate class strings by hand).

## 2. Folder structure

```
src/
  main.tsx                 createRoot; imports styles/index.css + styles/native.css; initNativeShell()
  app/
    App.tsx                Provider stack: ModeProvider > AuthProvider > RegionProvider > RouterProvider + AppUpdateBanner
    routes.tsx             THE routing table (see §3)
    layouts/
      SuperAdminLayout.tsx     the shell every tenant user sees (sidebar + top bar + <Outlet/>); builds the nav from permissions
      SuperSuperAdminLayout.tsx platform-owner shell (Companies)
      HRLayout.tsx, AccountsLayout.tsx   legacy, unreferenced by routes (kept; /hr and /accounts redirect)
    pages/
      Login.tsx, Signup.tsx, SignupComplete.tsx, RoleSelection.tsx   public
      super-admin/         every tenant page (57 files). `_TabHub.tsx` and `_BuildPending.tsx` are helpers, not pages.
      super-super-admin/   Companies.tsx, CompanyDetail.tsx
    components/            ~45 in-house components (Header, Modal, Button, StatCard, Badge, Tabs, ThemedSelect,
                           ClientFilterSelect, MobileCardList, ResponsiveTable, Sidebar, TopBar, big feature modals…)
      ui/                  shadcn/Radix set — UNUSED by the app
      figma/               ImageWithFallback — unused leftover
    lib/                   supabase.ts (client + types + PERMISSION_GROUPS), auth.tsx, region.tsx, mode.tsx, theme.ts,
                           tone.ts (semantic colour helper), date.ts, excel.ts, *Pdf.ts, custodian.ts, platform.ts,
                           nativeShell.ts, saveFile.ts, focus.ts (ledger drill-down), validation.ts, billing.ts…
    landing/               public marketing page in a Shadow DOM (bastion.html/css as ?raw strings). Not part of the app UI.
  styles/
    index.css              @import fonts → tailwind → theme → mobile (order matters; mobile.css last)
    tailwind.css           @import 'tailwindcss' source(none); @source '../**/*.{js,ts,jsx,tsx}'
    theme.css              ALL design tokens; light + .dark palettes; base element styles (select chevron, h1–h4, scrollbars)
    mobile.css             root font-size 85% below 768px; 16px inputs on phones (iOS zoom guard)
    native.css             html.native only: safe areas, 44px touch targets, overscroll, dvh shell
    fonts.css              empty
```

**Conventions worth knowing**

- One page = one file, often very large (Employees 6,000 lines, Banks & Ledgers 5,400, Expenses 4,800,
  Payroll 4,200, Assignments 3,500). Sub-modals are frequently *inner functions in the same file*
  (`RehireModal`, `BulkGenerateModal`, `EditRulesModal`, `RowEditModal`, `AssignEmployeesModal`,
  `TransferModal`, `VacancyQueue`, `ShiftDrillModal`…). Searching for a modal title string is the
  fastest way to find one.
- "Hub" pages are thin `TabHub` wrappers that mount previously-separate pages as tabs
  (`ComplianceHub`, `AssetsIssuance`, `IncidentsHub`, `AccountingCore`, `AccessGovernance`,
  `DailyReports`). Each child keeps its own sticky `<Header>`.
- Several pages are **embedded inside other pages** with props: `PayrollManagement` renders inside
  `PayrollRun` (`runInline siteGrouped throughNet`), `Cashflow embedded` inside `FinancialReports`,
  `CashCustodyPanel` inside `Accounting`, `ShiftManagement` inside `AttendanceBoard`,
  `ContractedVsDeployed` and `RegionalPerformance` inside `FinancialReports`. A layout change to
  one of these lands in two places.
- Class strings are inline. Where a page repeats an input style it declares
  `const inputCls = "w-full px-3 py-2 border border-slate-200 rounded-md text-sm"` near the top.
- Permission checks are `hasPermission(profile, "x.y")` calls at the top of the component,
  assigned to `canX` booleans, then `{canX && <Button…>}` in JSX (see §5).

## 3. Routing — every route, its component, and its gate

Source: `src/app/routes.tsx`. `guard(perms, el)` = `<RequirePermission any={perms}>`: the user
needs **any one** of the listed keys; `super_admin` and `super_super_admin` always pass.
`RequireAuth roles={[…]}` is a **role** check (used where a permission check would let a user
widen their own access).

### Public (wrapped in `<PublicAnalytics/>`, GA only fires here)

| Path | Component | Notes |
|---|---|---|
| `/` | `RoleSelection` | Renders the marketing landing (`BastionLanding`) for logged-out visitors. Native builds redirect to `/login`. |
| `/login` | `Login` | Two-column at `lg:` (`grid lg:grid-cols-[45%_55%]`); left brand panel is `hidden lg:flex`. |
| `/signup`, `/signup/complete` | `Signup`, `SignupComplete` | Stripe checkout flow. Redirect to `/login` on native (`canSellInApp === false`). |

### `/super-super-admin` — `RequireAuth roles=["super_super_admin"]` → `SuperSuperAdminLayout`

| Path | Component |
|---|---|
| (index) | `Companies` |
| `companies/:id` | `CompanyDetail` |

### `/super-admin` — `RequireAuth roles=[super_admin, hr, accounting, ops_manager, ops_director, finance_director]` → `SuperAdminLayout`

All tenant users share this one shell; the sidebar filters items per user.

| Path | Component | Gate (any of) | Sidebar group / label |
|---|---|---|---|
| (index) | `Dashboard` | — (auth only) | Overview ▸ Dashboard |
| `tasks` | `Tasks` | — | Overview ▸ Tasks |
| `my-profile` | `MyProfile` | auth only; page is meaningful only when `profile.employee_id` is set | Me ▸ My Profile (shown only if linked) |
| `clients` | `Clients` | `clients.view`, `clients.edit` | Clients & Contracts ▸ Clients |
| `contracts` | `Contracts` | `contracts.view`, `contracts.edit` | ▸ Contracts |
| `invoices` | `Invoices` | `invoices.view`, `invoices.edit` | ▸ Invoices |
| `employees` | `EmployeeManagement` | `employees.view`, `employees.edit` | Workforce ▸ Employees |
| `assignments` | `EmployeeAssignments` | `assignments.view`, `employees.edit` | ▸ Assignments & Pay |
| `attendance` | `AttendanceBoard` | `attendance.view`, `attendance.edit` | ▸ Attendance |
| `attendance/timesheet` | `AttendanceManagement` | `attendance.view`, `attendance.edit` | (not in nav — reached from a guard's History tab) |
| `payroll` | `TabHub` → Payslips (`PayrollManagement siteGrouped`) / Adjustments (`PayrollAdjustments`) / Leave (`LeaveBalances`) | `payroll.view`, `payroll.edit`, `payroll.adjust` | ▸ Payroll |
| `payroll-run` | `PayrollRun` | `payroll.view`, `payroll.edit` | ▸ Payroll Run |
| `relievers` | `AttendanceManagement relieversOnly` | `attendance.view`, `attendance.edit` | ▸ Relievers |
| `relievers/payroll` | `PayrollManagement relieversOnly` | `payroll.view`, `payroll.edit` | (not in nav) |
| `performance` | `Performance` | `payroll.view`, `performance.approve` | (route only, hidden from nav) |
| `daily-reports` | `DailyReports` → `FieldOps` | `roster.view`, `roster.edit`, `incidents.view`, `attendance.view` | Operations ▸ Daily Reports |
| `incidents` | `IncidentsHub` → Incidents / Client Complaints | `incidents.view`, `incidents.edit` | ▸ Incidents |
| `assets-issuance` | `AssetsIssuance` → Store / Issuance / Clearance / Register | `inventory.view`, `inventory.edit`, `banks.view` | ▸ Assets & Issuance |
| `accounting` | `Accounting` ("Banks & Ledgers": Receivables / Payables / Bank Accounts / Cash Custody) | `banks.view`, `receivables.view`, `payables.view`, `accounting.edit` | Finance ▸ Bank & Ledgers |
| `accounting-core` | `AccountingCore` → Opening Balances / Chart of Accounts / Trial Balance / Journal | `coa.view` | ▸ Accounting Core |
| `expenses` | `Expenses` | `expenses.view`, `expenses.edit` | ▸ Expenses & Advances |
| `reports` | `FinancialReports key="reports"` | `reports.view` | ▸ Financial Reports |
| `partnership-report` | `FinancialReports standalone="partnership"` | banks/receivables/payables.view, `accounting.edit` | ▸ Partnership Report |
| `partnership-run` | `PartnershipRun` | same four | ▸ Partnership Run |
| `period-close` | `PeriodClose` | `period_close.manage` | ▸ Period Close |
| `cashflow` | `Cashflow` | `cashflow.view` | (route only; lives as "Cash Basis" toggle inside Financial Reports) |
| `treasury` | `Treasury` | `banks.view`, `reports.view`, `cashflow.view` | (hidden group "Profit-Share") |
| `regional-scorecard` | `RegionalScorecard` | `reports.view`, `banks.view` | (hidden by request) |
| `partners` | `Partners` | banks/receivables/payables.view, `accounting.edit` | (hidden group) |
| `project-financing` | `ProjectFinancing` | same four | (hidden group) |
| `compliance` | `ComplianceHub` → Calendar / Licenses & Renewals / Contract Renewals | `compliance.view`, `compliance.edit` | Compliance ▸ Compliance Calendar |
| `compliance-cases` | `ComplianceCases` | `compliance.view`, `compliance.edit` | (hidden) |
| `documents` | `Documents` | `documents.view`, `documents.edit` | (hidden) |
| `alerts` | `Alerts` | — | (hidden) |
| `access-governance` | `AccessGovernance` → Users & Permissions / Governance | **role**: `super_admin`, `super_super_admin` | Admin ▸ Access & Governance |
| `audit-log` | `AuditLog` | **role**: `super_admin`, `super_super_admin` | ▸ Audit Log |
| `settings` | `Settings` | `settings.view`, `settings.edit` | ▸ Settings |
| `billing` | `Billing` | `settings.view`, `settings.edit` | ▸ Plan & Billing |

**Redirects** (old URLs, kept so bookmarks resolve): `users`→access-governance?tab=users ·
`deployment`, `sites-strength`, `roster`→assignments · `licences`→compliance?tab=licences ·
`chart-of-accounts`/`trial-balance`/`journal`/`general-ledger`/`opening-balances`→accounting-core?tab=… ·
`payroll-runs`→payroll · `recruitment`→employees · `relievers/attendance`→relievers ·
`receivables`, `cash-custody`→accounting?tab=… · `client-relationships`→clients · `field-ops`→daily-reports ·
`assets`, `inventory`→assets-issuance?tab=… · `governance`→access-governance?tab=governance ·
`/hr/*`, `/accounts/*`→`/super-admin` · `*`→`/login`.

Dead page files still in the tree (imported by `routes.tsx` but no route renders them, or not
imported at all): `ProfitDistribution.tsx` (route removed deliberately, see comment in
routes.tsx), `SitesStrength.tsx`, `Roster.tsx`, `ClientRelationships.tsx`, `Receivables.tsx`
(the live Receivables is the tab inside `Accounting.tsx`), `_BuildPending.tsx`. Skip them.

## 4. Global providers and contexts

Order in `App.tsx`: `ModeProvider` → `AuthProvider` → `RegionProvider` → `RouterProvider` (+ `AppUpdateBanner` outside the router).

| Context | File | Exposes | Notes |
|---|---|---|---|
| **Mode** (light/dark) | `lib/mode.tsx` | `mode`, `toggle`, `setMode` | Toggles `.dark` on `<html>`, persists to `localStorage["txs.mode"]`. An inline script in `index.html` applies it pre-paint. Toggle button = `ThemeToggle` in `TopBar`. |
| **Auth** | `lib/auth.tsx` | `session`, `profile`, `company`, `loading`, `signIn`, `signOut`, `refreshProfile`, `setViewAsCompany` | Loads `profiles` row then `companies` row. Applies the company's brand palette via `applyTheme(company.theme)` (`lib/theme.ts`: amber/green/steel — overrides `--color-brand-500/600/700` on `<html>`). Also exports `hasPermission`, `hasAnyPermission`, `ROLE_HOMES`. SSA "view as company" is `profile.view_as_company`. |
| **Region** | `lib/region.tsx` | `regionId` (null = all), `setRegionId`, `regions`, `region`, `locked`, `loading` | Regions = `branches` table. `locked` when `profile.branch_id` is set (user pinned to one region). Persisted per user+company in localStorage. Rendered by `RegionSelector` in the top bar only when `locked || regions.length > 1`. Most finance/ops pages read `useRegion()` and filter queries by it. |
| **Billing** (hook, not provider) | `lib/billing.ts` `useBilling()` | plan summary, guard cap | Used by `GuardCapBanner` (Employees) and `Billing` page. |

No global toast system is wired (sonner is installed but unused); pages show inline
success/error banners at the top of their scroll area, and modals show errors via `Modal`'s
`error` prop. `window.confirm()` is used for destructive confirmations in 27 files.

## 5. The layout shell (what wraps every authenticated page)

`SuperAdminLayout.tsx`:

```
<div class="app-shell flex h-dvh bg-slate-50">
  <Sidebar title=… links=…/>                     ← desktop: <aside class="hidden md:flex w-64|w-16 …">
                                                   mobile:  <aside class="md:hidden fixed inset-y-0 left-0 z-50 w-72 … translate-x">
                                                            + <div class="md:hidden fixed inset-0 z-40 bg-black/40"> backdrop
  <div class="flex-1 flex flex-col overflow-hidden">
    [SSA "Viewing: X" amber banner]
    <TopBar>                                       ← min-h-12; hamburger (md:hidden, 44px) | RegionSelector + scope sentence (hidden lg:inline) | ThemeToggle
    <Outlet/>                                      ← the page. Convention: <Header/> (sticky) + <div class="flex-1 overflow-y-auto px-3 py-4 md:p-8">
  </div>
  <AiChatWidget/>                                  ← fixed bottom-right FAB (w-14 h-14) + panel w-[min(420px,calc(100vw-2rem))]
  <InactivityLogout/>                              ← fixed inset-0 z-[200] countdown dialog
</div>
```

- The page is the scroller, not the window: `h-dvh` shell → `overflow-hidden` column → page's own
  `flex-1 overflow-y-auto`. Anything `position: sticky` inside a page sticks to *that* scroller.
  `TabHub` deliberately preserves this chain (`flex-1 flex flex-col min-h-0`).
- The desktop sidebar has a collapsed 64px icon rail (`localStorage["sidebar.collapsed.v1"]`).
  Section groups (WORKFORCE, FINANCE…) are collapsible; state persists.
- The mobile hamburger dispatches `window.dispatchEvent(new CustomEvent("sidebar:open"))`; the
  Sidebar listens. Android back (`native:back` event) closes drawer/modals first.
- `Header` (`components/Header.tsx`): `sticky top-0 z-20`, opaque on mobile / frosted at `md:`,
  `flex-col md:flex-row`, `h2` title `text-lg md:text-xl`, actions `flex flex-wrap gap-2`.

## 6. Permission model as it reaches the UI

- `profile.permissions: string[]` holds keys like `payroll.edit`. Catalogue = `PERMISSION_GROUPS`
  in `lib/supabase.ts` (14 groups, ~60 keys) — this is what the grant screen renders and what
  the DB mirrors in `public.permission_keys`.
- `hasPermission(profile, key)` → true for `super_admin`/`super_super_admin` always, else array
  membership. `hasAnyPermission` for lists.
- **Three layers, all present:** route gate (`RequirePermission`), sidebar filtering (same keys,
  in `SuperAdminLayout`), and in-page `canX &&` around buttons/columns/tabs. The DB enforces
  independently (RLS + `require_perm()`), so a hidden button is UX, not security — but a
  *visible* button the user cannot use produces a `42501` error that `friendlyDbError` turns
  into "You don't have permission…". Keep the in-page gates when restructuring; do not move a
  gated button into a place where the gate no longer wraps it.
- Examples of column/tab-level gating you will meet: Assignments & Pay shows Base/Per day/
  Allowance/Joined columns only with `assignments.accounts`; Payroll hides custodian balances
  without `banks.view`; Financial Reports hides the "Cash Basis" toggle without `cashflow.view`;
  Attendance's "Shift Management" tab needs `assignments.hr`/`employees.edit`.
