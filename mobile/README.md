# GGS Field — Bastion mobile

The phone app for the Bastion guard-workforce web app (`Safi1000/employee-manager`).
Expo SDK 57 · React Native 0.86 · Expo Router · TypeScript · supabase-js.

It's a separate repo, as the build brief asks, and it covers **every page of the web app**, not only
field ops. Field ops (Today, Attendance, People, Reports) get the bottom tabs. Every other page
is in **Menu**, grouped the same way as the web sidebar and filtered by the same permission keys.

```bash
npm install
npx expo start          # press i / a, or scan with Expo Go
npm run typecheck       # tsc --noEmit
npm run lint            # expo lint
```

## Demo mode vs live mode

With no `.env`, the app runs on **local fixtures** (`src/data/seed.ts`) and makes no network calls.
The login screen lists demo personas (Super Admin, Ops Supervisor, Accounts, HR, a deactivated
Finance Director, and the platform owner). Each one has a different permission set, so you can
check that pages, tabs, columns and buttons appear and disappear the way they do on web.

To sign in with real accounts, copy `.env.example` to `.env` and fill in the anon key. Auth,
profile loading and `can()` then run against Supabase (`src/lib/supabase.ts`, `src/lib/auth.tsx`),
exactly as the brief describes.

### What live mode does (as of 2026-09-28)

Every screen still reads through one seam, `src/data/store.tsx` (`useDB()`). In live mode:

- **Reads.** `src/data/live.ts` `loadLive()` reads the real tables after sign-in and maps them into
  the fixture shapes, so screens render production data unchanged. `db` starts **empty**, never
  the fixtures. Loaded: company, branches, clients, sites (with contracted strength from contract
  lines), contracts and lines, employees (posted site and shift from today's deployment), attendance and
  confirmations for this month and the two before it, daily notes, incidents, invoices with payments,
  payslips (6 months), expenses, advances, banks, cheques, chart of accounts, tasks, important dates,
  recurring alerts, users, periods, and open vacancies.
- **Deliberately empty.** These figures come from a ledger fold the web computes and this file
  does not reproduce: custodian cash held, partner balances, the journal, leave ledger, inventory and
  kit, fixed and deferred expenses, payroll scopes, audit log, and the platform companies list. They
  show as empty rather than as a plausible wrong number.
- **Writes that work.** Two writes: **site-shift confirmation** (`confirmShift`) and the **daily
  client note** (`saveDailyNote`). Each is a port of the web screen that makes it (AttendanceBoard
  confirm, FieldOps saveOne).
- **Every other write is refused.** `commit()` shows "Not saved — use the web app" and suppresses
  the screen's own success toast. Wire the next one by adding its function to `live.ts` and calling
  it instead of `commit()`, as SiteDrill and DailyReports do.

### Wiring the next write (the brief's rules, applied)

1. **Port, don't approximate.** Read the web screen that makes the write and copy its exact
   payload, conflict key and pre-clearing. Attendance feeds payroll.
2. **Writes only through existing RPCs.** Every `commit()` that touches money (payments,
   disbursements, deposits, transfers, advances, expenses, partner entries) must call the
   RPC the web app uses (`disburse_payslip`, `record_expense`, `record_cash_deposit`, …).
   Never write a balance column directly. If a write has no safe RPC, stop and ask the owner.
3. Test the first real write against a throwaway employee/site the owner has approved, never a real guard.

## Mobile design decisions

- **Same tokens as web.** The warm paper and obsidian neutrals, the amber, emerald, rust and steel accents,
  and the Bricolage, Hanken and JetBrains Mono fonts all come from `theme.css`. Light, dark and system
  modes are supported. The per-company brand palette (amber, emerald, steel) is set in Settings → Appearance.
- **Tables become record cards.** Each card shows a title, a mono code, a status badge, and a
  two-column field grid (the web's `MobileCardList`, made native). Actions sit in the card footer,
  and each keeps the permission check it has on web.
- **Modals become bottom sheets** with a pinned footer. Only the body scrolls.
- **Toasts replace inline banners**, so you see the result of an action even if you're
  far down a list (handoff gap #10). Destructive confirms use an in-app sheet instead of
  `window.confirm`. Period close/reopen needs you to type the month to confirm.
- **One tab style:** a scrollable pill strip, plus a segmented track for 2–3 options.
- **Monthly Board** (handoff A4, flagged as needing a product decision): on the phone it's a
  list with one card per guard, showing the month as a wrapping strip of P/A/L/DD/X day cells plus totals. It uses the same data
  and marks as the web board, with no frozen 402px column block.
- **The strength meter** (one filled cell per contracted slot: green on post, amber exception,
  dashed rust unfilled, steel over-strength) is the attendance board's signature.
- **Site drill** treats everyone as present by default. You tap only the exceptions: absence reason, reliever cover,
  a backdate reason past the cutoff, then *Report* or *Confirm*.
- Custodian pickers show "holds PKR n" **only with `banks.view`** (handoff A5).
- Trial Balance footer is summed from the rows on screen (web `CLAUDE.md`, "Reading versus computing").

## Map

| Tab / group | Screens |
|---|---|
| Today | Dashboard (attendance today, stat grid, 7-day trend, banks, top clients, expenses, activity, compliance, contracts ending, incidents, period close, attachments) |
| Attendance | Daily board · Vacancies · Shift management → Site drill, Monthly board, Bulk mark, Timesheet |
| People | Employees → Profile / History, Add · Edit · Hire, Rehire, change client / category / shift, transfer, warnings, fire |
| Reports | Daily reports (one note per client per day, PDF export history) |
| Menu → Overview | Tasks, My Profile |
| Clients & Contracts | Clients (+ detail), Contracts (+ detail, editor, renew, cycles), Invoices (+ detail, record payment, generate) |
| Workforce | Assignments & Pay, Payroll (Payslips / Adjustments / Leave → salary calculation), Payroll Run, Relievers (+ reliever payroll), Performance |
| Operations | Incidents (+ client complaints), Assets & Issuance (Store / Issuance / Clearance / Register) |
| Finance | Banks & Ledgers (+ client statement), Accounting Core, Expenses & Advances, Financial Reports, Partnership Report, Partnership Run, Period Close, Cash Flow, Treasury, Regional Scorecard, Partner Accounts, Project Financing |
| Compliance | Compliance (Calendar / Licences / Contract renewals), Compliance Cases, Documents, Alerts |
| Admin | Access & Governance, Audit Log, Settings, Plan & Billing |
| Platform | Companies (+ detail), for the platform owner only |

Route gates live in `src/navigation/registry.ts` and mirror `routes.tsx` on web.

## Layout

```
src/app/            Expo Router routes (thin: each wraps a screen in its permission gate)
src/screens/        one folder per web sidebar group
src/components/     Screen, Sheet/Select/Toast, record cards, stats, tabs, charts, month grid
src/data/           seed fixtures + the store seam
src/lib/            supabase client, auth + can(), region, permissions, formatters
src/theme/          tokens + provider
```
