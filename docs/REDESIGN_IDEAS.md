# Redesign — ideas gathered page by page

Collected while moving every screen onto the command design (dark band,
sidebar, segmented tabs, ledger figures, detail sheets). Nothing here is built
unless the entry says **Built**. Everything else is for discussion.

Status words: **Built** (in this pass) · **Idea** (proposed, not built) ·
**Needs data** (the screen can only do it once something is recorded).

---

## System-wide

- **Built** — Command band on every page: kicker (section · company), display
  title, actions, and — inside a hub — the hub's tabs on the band itself.
- **Built** — Dark sidebar in both modes; active link marked with an amber rail.
- **Built** — One tab control (segmented track) everywhere, one stat tile, one
  panel, one modal, pill badges, `ink` button variant for the final action.
- **Built** — `DetailSheet`: the right-hand sheet any figure can open into
  (figure, how it is made up, a link through to the record).
- **Idea** — Command palette (⌘K): jump to any client, guard, invoice or
  screen; run common actions ("new expense", "mark attendance").
- **Idea** — Every figure clickable by default: a table cell that is a sum
  opens the rows behind it in a DetailSheet, the way Financial Reports does.
- **Idea** — Saved views per user: remember filters, columns and sort per
  table, and let a view be shared with a link.
- **Idea** — "What changed since you last looked" chip on each page (new
  invoices, new incidents, edits by others) using the audit log.
- **Idea** — Plain-language errors: every database error mapped to a sentence
  that says what happened and what to do, with the technical text behind a
  "details" disclosure.
- **Idea** — Empty states that teach: each empty table says what belongs there
  and offers the button that creates the first one.

## Dashboard (home)

- **Built** — Rebuilt from scratch as the command dashboard; the classic layout
  and the three alternate designs (Watchtower, Ledger, Aurora) and their
  floating switcher are gone.
- **Built** — Guards on post ring and post board from the latest marked day,
  against contracted heads (`client_cover`). Clients with no register marked
  that day show as **Not marked** and are left out of the cover figure, so an
  unfilled register is never reported as an uncovered site.
- **Built** — This month's invoicing against last month, with the list of
  clients invoiced last month and not yet this month.
- **Built** — Next salary run cover: cash and bank plus receivables under 30
  days, against last month's payroll.
- **Built** — Cash this month waterfall, client map (revenue × margin, size by
  contracted guards), receivables by age per client, region scorecards with a
  six-month invoicing line, next 30 days timeline, live feed.
- **Built** — The company's "hide dashboard panels" setting now lists the new
  panels. Old hidden keys are ignored (the company sees everything until it
  hides panels again).
- **Needs data** — Lahore clients appear as **Not marked** on the post board:
  no attendance is being marked for them in Bastion.
- **Needs data** — Some attendance is still marked against clients that were
  merged into others ("… (merged into …)"); the merged-into client then shows
  as not marked. Re-pointing those rows, or marking against the live client,
  fixes the board.
- **Idea** — A monthly invoicing target per client (from the contract value) so
  "where the month will land" can compare against what was agreed, not just
  last month.
- **Idea** — Payday alert a week before the salary run when cash plus
  receivables under 30 days will not cover it.
- **Idea** — Post board drill-down by site (not just client) once posts are
  recorded — the `posts` table exists and is empty.
- **Idea** — Partner pot tile (share earned so far this month per partner) once
  the partnership base is settled.

## Region selector

- **Built** — The region bar matches the theme: a one-tap segmented switch when
  there are up to four regions, a themed dropdown beyond that.
- **Built** — Assignments & Pay: the strength band (contracted, enrolled, gaps,
  mismatches) now follows the region. The reconciliation view is company-wide
  and was being read whole.
- **In progress** — A page-by-page check that every figure follows the region.
  About 35 pages never read the region at all; each is being sorted into
  "should follow the region" (fixed) or "company-level by nature" (labelled
  on the band, so it does not look broken).
- **Idea** — When a page is company-level, the band says so ("Company-wide —
  the region does not apply here") instead of silently ignoring the switch.

## Financial Reports

- **Built** — Profit & loss on revenue basis (the GL) and cash basis (the client
  statement), against previous month, same month last year or year to date.
- **Built** — Change and % columns, "where every 100 rupees went", biggest
  movers, a GL drill on every line, export.
- **Built** — Client profit follows the band's basis; Head office is its own tab
  (the pool and each region's Yes/No).
- **Built** — The working tools (checks, accrual-to-cash bridge, ledgers,
  scenarios, contracted vs deployed) moved to the Accountant page.
- **Idea** — A budget column once a monthly plan exists (see Accountant
  planning).
- **Idea** — Region columns side by side on the P&L (ISB/RWP · Kashmir · Lahore
  · HO · Total) instead of one region at a time.

## Accountant

- **Built** — New page, granted person by person (`accountant.view` in Access &
  Governance). Migration 0526 adds the key to the catalogue — **not applied**,
  waiting on your go-ahead.
- **Built** — Accounts: the income & withdrawal state from the ledger, every
  bank and cash holder as a column, with a check row per account.
- **Built** — Controls red and month open/closed on the band; one search for
  any client, guard, invoice or expense.
- **Idea** — Planning: expected receipts and payments with dates, then plan
  against actual each month. Needs new tables.
- **Idea** — A Checks tab that ties the grid to the trial balance, payroll to
  disbursements, and receipts to bank statements, each with a tick-off.

## Clients, Contracts, Invoices

- **Built** — Clients: band with clients, guards, owed and largest client's
  share; card grid by default (table still one tap away).
- **Built** — Contracts: live book value, posted vs committed, ending in 60
  days, a renewal runway and a "needs renewal" filter.
- **Built** — Invoices: tabs and a Collected % tile on the band.
- **Idea** — Client health score per card (paying on time, staffed to
  contract, complaints, margin) with the reason for the score.
- **Idea** — One-tap renewal draft from a contract nearing its end, carrying
  the lines and the agreed increase.
- **Idea** — Invoice run for the month: every client due, one review screen,
  generate all.

## Workforce

- **Built** — Employees: six filter tiles (incomplete, expired cards, duplicate
  CNIC, joined this month…), a workforce category bar, a completeness meter and
  rebuilt rows.
- **Built** — Assignments & Pay: strength ratio, understaffed/over, mismatched
  filter, monthly pay with missing data, a gaps chart, quick filters, sort, a
  staffing meter per client and two-line rows. Gaps were fixed: the
  reconciliation view undercounts contracted heads; committed heads now come
  from the contract lines.
- **Built** — Attendance: confirmation ring on the band, register tiles, client
  progress bars.
- **Built** — Payroll: paid-out meter and progress per client. A PKR 0 payslip
  (e.g. a guard who left) now counts as settled — this was the "1 unpaid" at HMC.
- **Built** — Payroll Run and Attendance Run: the pipeline stages on the band.
- **Needs data** — Lahore attendance and payroll are not in Bastion yet, so
  Lahore clients read as understaffed (5 enrolled against 44 contracted).
- **Idea** — Reliever suggestions: when a site is short today, list the nearest
  free relievers.
- **Idea** — Guard timeline on the employee record: joined, postings, warnings,
  pay changes, leave, in one line.

## Operations

- **Built** — Daily Reports: notes progress (written / nothing to report /
  blank).
- **Built** — Incidents: 12-week trend and category mix on the band.
- **Built** — Store, Issuance, Clearance: the figures on the band.
- **Idea** — Kit due back: guards who left with kit still out, by value.
- **Idea** — Incident heat by site, to show which sites need a supervisor visit.

## Finance (other)

- **Built** — Banks & Ledgers: net position and ledger tabs on the band.
- **Built** — Expenses: tabs with counts, spent / entries / office share /
  biggest category, and a "where it went" bar that filters the list.
- **Built** — Trial Balance (balanced / off by), Journal (entries, moved,
  manual, reversals, sources), Period Close (months locked, oldest open, close
  runway), Partnership Report (equity pool bar and partner cards).
- **Needs data** — August has no GL (cutover was September), so comparisons
  against August read empty.
- **Idea** — Recurring expense detector: flag a payee paid every month that is
  not set up as a fixed expense.

## Compliance and Admin

- **Built** — Compliance: priority tiles and guard-data coverage meters.
  Licences: a 6-month expiry runway.
- **Built** — Tasks board band, Alerts rebuilt with a severity rail, Audit Log
  (action mix, most-changed tables, busiest people), Access & Governance (roles,
  scoped users, who has Accountant access), Billing (guard-limit meter),
  Settings (section navigator), Reversals (figures on the band).
- **Idea** — Access review once a quarter: a list of who can see what, to
  confirm or revoke in one pass.
- **Idea** — Audit log "undo" link straight to Reversals for actions that can
  be reversed.

## Sidebar → section rail

- **Built** — The 256px sidebar and its broken collapse toggle are gone. A 76px
  rail holds one icon per section; hover or tap opens a flyout with that
  section's pages, floating over the page so pages keep their full width.
- **Built** — ⌘K / Ctrl+K palette (also the search button on the rail): any
  page, client, guard or invoice; light/dark, change password, sign out.
  Clients and guards open their list already searched; invoices open focused.
- **Built** — Pinned pages (pin icon in a flyout or the palette) sit on the
  rail; the last pages opened show at the foot of every flyout and at the top
  of the empty palette. Stored per browser.
- **Built** — Phones keep the drawer, now with search and pinned at the top.
- **Idea** — Palette actions that start work: "New expense", "Record receipt",
  "Mark attendance", opening the right form directly.
- **Idea** — Badges on rail icons (open alerts on Overview, payslips waiting on
  Workforce, red controls on Finance).

## TO DO LATER — one colour system everywhere

**Asked for 2026-10-21, to be worked on later.** Many panels still use the old
colours (cool grey "slate" shades, plain white cards, fixed hex values) instead
of the theme's warm tokens, so they look out of place next to the redesigned
pages and often do not follow dark mode.

Measured 2026-10-21: about **4,900** old colour classes in **83 files**.
Heaviest first:

| File | Old classes |
|---|---|
| Banks & Ledgers (`Accounting.tsx`) | 444 |
| Expenses & Advances | 383 |
| Employees | 293 |
| Payroll | 203 |
| Contract editor (modal) | 134 |
| Partner Accounts | 117 |
| Cash Custody | 109 |
| Project Financing | 106 |
| Clients | 104 |
| Partnership Report, Compliance Calendar | 91 each |
| Invoices | 90 |
| Cash Flow | 88 |
| Invoice generator | 73 |
| Users & Permissions | 70 |
| Roster, Profit Distribution, Attendance, Incidents, Documents, Settings, Treasury… | 50–70 each |

The plan when we pick it up:

- **One mapping, applied by script, checked by eye.** Old shade → theme
  token: white/`slate-50` cards → `bg-card`; `slate-50/100` fills →
  `bg-muted`; `slate-200/300` lines → `border-border`; `slate-400/500` text →
  `text-muted-foreground`; `slate-700/800/900` text → `text-foreground`;
  `blue-*` accents → `brand-*`; red/green/amber status → `danger/success/
  warning-*`. Fixed hex values become tokens or move into `theme.css`.
- **Modals, forms and tables first**, since they appear on every page (the
  contract editor, invoice generator, partner modal, every data table).
- **Then page by page**, heaviest first (table above), with a light and a
  dark screenshot of each before pushing.
- **A guard so it does not come back:** a check in the build that fails on a
  new `slate-*`, `gray-*`, `bg-white` or hex colour outside `theme.css`.
- **Idea** — once everything reads tokens, the three accent themes (amber,
  green, steel) in Settings work on every screen, not only the redesigned ones.
