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
- **Built** — Command palette (⌘K): jump to any client, guard, invoice or
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
- **Built** — Payday alert a week before the salary run when cash plus
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
- **Built** — When a page is company-level, the band says so ("Company-wide —
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

## Round 2 (2026-10-21) — what was asked and what changed

- **Built** — Scrolling on Employees and Assignments & Pay is smooth: the band
  folds in one step (no height animation re-laying out 400 rows per frame),
  folds and unfolds at two thresholds so it cannot flicker, the scroll memory
  saves after scrolling stops, the sticky Actions column is only sticky on
  narrower screens, and off-screen client cards are skipped until near.
- **Built** — Banks & Ledgers, all four tabs:
  - Receivables: no more red/green flooded rows. Status edge, initials,
    a collected meter per client, All / Owing / Settled with counts, most
    owed first. The band adds a collection meter and "who holds the
    outstanding" (tap a client to filter).
  - Payables: status tabs, paid meter per vendor, "due in N days / N days
    late", a "Due in 7 days" tile; the duplicate totals strip is gone.
  - Bank accounts: one card per account (balance, cheques in transit, share
    of the company's bank money, actions); cheques and deposits as tabs.
  - Cash custody: neutral reconciliation rows, free company cash on ink.
  - Everywhere: rounder corners, pill statuses, the new column headings.
- **Built** — Expenses & Advances: bands for Advances (amount, guards, repeat
  takers, biggest client, by-client bar and by-mode split that filter),
  Fixed (raised, waiting, approved, denied) and Deferred (still to release,
  stuck, months released); the styling pass on the whole page.
- **Built** — Client profit: summary strip (losing money, under 10%, best and
  weakest margin among clients with payroll, net per contracted guard),
  margin and change on last month per client, "where every 100 rupees went"
  bar per client, filters and sorts, and a Cards view.
- **Built** — Accountant: salary lines in any bank or cash ledger fold into
  one row per client and pay month — "Emaar DHA ISB — 73 payslips paid from
  Askari Bank" — that opens to the payslips.
- **Built** — Dashboard: billing is by service month (September: 25 of 25
  contracted clients invoiced, PKR 20.57M); a contract that starts later
  (Regent 1) is not expected to have last month's invoice; guards on leave
  count toward strength; the cash waterfall reads the ledger; payday cover
  uses last month's full payroll; new Payroll and Workforce panels.
- **Fixed** — 13 classes the colour sweep had broken (`bg-muted/50/60`);
  the colour check now refuses that shape too.
- **Needs data / your decision** — Bank and cash opening balances from before
  the ledger began are not posted: the ledger holds PKR 0.6M on bank and cash
  accounts against PKR 7.7M recorded (Bank of AJK 0 vs 2.37M, Askari 0.29M vs
  3.82M). Client opening balances (PKR 37.9M) are likewise outside invoices,
  so Banks & Ledgers shows PKR 25.0M owed while open invoices total 13.0M.
- **Needs data** — `client_cover` counts a contract as live in months before
  it started (Regent 1 in September); the Dashboard works round it.
- **Needs data** — Nova Group shows PKR 52K payroll on PKR 1.9M revenue in
  September (90.7% margin): its guards' payroll may sit on another client.
- **Built** — Receivables: an ageing column per client (0–30, 31–60, 61–90,
  90+) and a "send statement" action.
- **Idea** — Bank cards: a 30-day balance sparkline per account from the
  ledger, once openings are posted.
- **Built** — Client profit: a 6-month net trend per client, and a "what if"
  (rate +5%, one guard fewer) on a client card.

## Round 3 (2026-10-21) — the ideas, built

- **Built** — Client receivables moved to Invoices and Accounts payable to
  Expenses & Advances (the same code, embedded); Banks & Ledgers keeps bank
  accounts and cash custody; old links forward with their focus.
- **Built** — Receivables: an age bar per client (0–30, 31–60, 61–90, 90+
  days on open invoices) with the 90+ amount called out.
- **Built** — ⌘K "Do" actions: new expense, new advance, new invoice, record
  a receipt, generate invoices, new task, mark attendance, add an employee —
  each opens its form directly (`?new=…`), offered only where you have access.
- **Built** — Counts on the rail: open alerts on Home, last month's unpaid
  payslips on Workforce, fixed expenses awaiting a decision on Finance,
  expired guard documents on Comply. Refresh every five minutes.
- **Built** — Dashboard is its own Home icon (and the Bastion mark goes
  there); Tasks has its own icon; the Overview section is gone.
- **Built** — Client profit: a six-month profit strip per client, and a
  "what if" on each card (rate +5%, one guard fewer), labelled as a what-if.
- **Built** — Contract Renewals: owner and next step on each card (the
  table already had owner_id and notes), and a "Nd idle" flag after 14 days
  without a change.
- **Built** — Chart of Accounts: "Unused for a year" — active, never posted
  to, set up over a year ago — candidates to switch off.
- **Built** — Partnership Run: the year as a strip of months (posted,
  drafted, reversed, not started), tap one to open it.
- **Built** — Companies: renewals lapsed or ending in 30 days, each with
  "record payment".
- **Built** — Expenses: "Paid every month, not set up as fixed" — the same
  payee in each of the last three months with no fixed template.
- **Built** — Dashboard: a "short for the salary run" chip in Needs attention
  when payday is a week out and cash plus receivables under 30 days fall short.
- **Built** — The band's fold animation is back, on a softer curve, at a full
  60 frames a second through the fold on Employees.
- **Applied 2026-10-21** — 0527 on named approval: client_cover counts a contract only
  from the month it starts (Regent 1 out of September, in from October).
- **Applied 2026-10-21** — 0528 on named approval: cash_plan and budget_lines, with
  planning.view / planning.edit (grantable in Access & Governance).
- **Built** — Accountant ▸ Planning: the month's plan (add, mark done with the
  actual, drop, delete), plan against actual by kind from the ledger, and the
  next 30 days' cash run with its low point; earlier months' items still
  expected are called out.
- **Built** — Financial Reports ▸ P&L: "vs budget" — the budget column and the
  variance per line, typed in place by planning.edit for a single month.
- **Was waiting on approval** — Accountant planning (needs new tables); importing an opening trial balance
  from Excel and bank balance sparklines (both wait on the cutover).
- **Waiting on the cutover** — Opening balances: the cutover (0519/0523) posts
  them; it waits on the Lahore roster → Lahore August backfill → redraft the
  opening batch → cutover.

## Round 4 (2026-10-21)

- **Built** — My Profile: payslip PDF per month; leave banked / taken / unpaid.
  Fixed: the warnings list asked for columns that do not exist and always
  read "a clean record".
- **Built** — Employee record ▸ Timeline: joined, postings, pay changes,
  advances, warnings, code and state changes.
- **Built** — Client cards: health score out of 100 (pays on time, staffed to
  contract, complaints, margin), breakdown on hover.
- **Built** — Contract Renewals: a Renewed card opens the contract's renew form.
- **Built** — P&L: By region, every region's statement side by side.
- **Built** — Dashboard: billing against contract value, clients billed more
  than 10% off contract; free relievers on a short client's sheet.
- **Built** — Audit Log: Reverse on undoable rows; Access & Governance: Review
  access, exportable.
- **Built** — Plain-language database errors everywhere (duplicate, still in
  use, missing link, required field, value not allowed, wrong format).
- **Built** — "N changes since you last looked" on record pages (admins).
- **Fixed** — Dashboard figures follow permissions and are not fetched
  without them; Shift Management no longer sticks inside Attendance.
- **Applied** — 0529: advances' write gates were permissive (open to every
  member); now restrictive.
- **Needs your decision (database)** — invoices, invoice_payments,
  bank_accounts and the ledger are readable by every company member; the
  audit log too (with every before/after, salaries included), and its insert
  policy is open. Fixing reads needs the custodian-cash and bank-picker
  screens moved onto functions first.
- **Needs data** — Emaar DHA ISB billed 203% of its contract value for
  September (4.78M against 2.36M).
- **Left** — Empty-state sweep, and checking the green and steel accent
  themes on every screen (needs a signed-in browser).

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
- **Built** — Recurring expense detector: flag a payee paid every month that is
  not set up as a fixed expense.

## Contract Renewals

- **Built** — A renewal board: one column per stage, cards move forward or
  back with one tap. The band counts each stage (tap to filter the board) and
  shows the share of decided renewals that were kept.
- **Built** — "Ending in 90 days, not in the pipeline": live contracts close
  to their end that nobody has started on, one tap to add them with the
  contract's end date as the close date. Follows the region.
- **Built** — Owner and next step on each card (who is calling, what was
  agreed), and a reminder when a card has not moved in 14 days.
- **Idea** — On "Renewed", offer to draft the new contract from the old one
  with the agreed increase.

## My Profile

- **Built** — The band says who you are (posting, region, shift, joined) and
  the month: base salary, days present out of the month, net pay with paid or
  owed, cash you hold (custodians) or pay owed to you, and a six-month pay
  strip (green paid, amber not yet).
- **Built** — Attendance as a real calendar, each date under its weekday, with
  unmarked days shown as unmarked rather than missing.
- **Idea** — A downloadable payslip PDF per month, and leave balance (taken
  and left) beside attendance.

## Accounting Core (Chart of Accounts, Opening Balances)

- **Built** — Chart of Accounts: one tile per account type (accounts and how
  many have postings; tap to jump to that part of the tree), the share of the
  chart in use, and an "Only accounts with postings" filter that keeps each
  match's parents. Counts only — balances stay in the tree, from the ledger.
- **Built** — Opening Balances: the batch's debit, credit and balance on the
  band (from `opening_batch_totals`), and the four steps a batch passes
  (create, add lines, balance, post) with the current one lit.
- **Built** — Chart of Accounts: show unused accounts older than a year as
  candidates to switch off.
- **Idea** — Opening Balances: import a trial balance from Excel straight into
  a draft batch.

## Partnership Run

- **Built** — The month picker, status and actions move onto the band. The
  month shows as four gates (ready to draft, drafted, reviewed, posted), each
  answered by the database (the blocker, the run, the review, the deadline),
  with the run's own totals: profit to divide, regional and equity shares.
- **Built** — A month-by-month strip of the year: which months are posted,
  drafted, late or not started.

## Sign-up

- **Built** — The price summary sits on the dark band with the monthly total
  shown large; the brand mark matches the rail.
- (Login already had the new look; Role Selection only routes to the landing
  page.)

## Platform (Companies, Company Detail)

- **Built** — Companies gets the command band: companies (active / switched
  off), employees and users across every tenant, and subscriptions lapsed or
  ending within 14 days.
- **Built** — Company Detail: status, users by role, super admins (amber when
  there are none), and subscription days left, with back and Add Super Admin
  on the band.
- **Built** — A renewal list on Companies: tenants whose subscription ends this
  month, with "record payment" one tap away.

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
- **Built** — Palette actions that start work: "New expense", "Record receipt",
  "Mark attendance", opening the right form directly.
- **Built** — Badges on rail icons (open alerts on Overview, payslips waiting on
  Workforce, red controls on Finance).

## One colour system everywhere

- **Built 2026-10-21** (asked for the same day). Every screen now reads the
  theme's named colours:
  - ~4,700 grey/white classes moved to `bg-card`, `bg-muted`,
    `border-border`, `text-foreground`, `text-muted-foreground`.
  - 63 stock colours (amber, emerald, indigo, violet, teal, purple) moved to
    warning / success / info.
  - ~180 shade numbers the theme never defined (e.g. `warning-800`, which
    showed no colour at all) moved to the nearest real shade, readable in dark
    mode.
  - 153 raw colour codes became named fixed tones in `theme.css`: `on-fill`,
    `on-brand`, `ink`, `ink-foreground`, `up`, `down`, `heed`, `settled`,
    `calm`, `rest`.
- **Built** — `scripts/check-colors.mjs` runs before every `npm run build` and
  fails it if an old colour comes back (`npm run check:colors` runs it alone).
- **Not covered, on purpose** — hex values handed to charts, PDFs and Excel
  exports, which cannot read CSS variables; and the separate `mobile/` app.
- **Idea** — now that every screen reads tokens, the accent themes in Settings
  (amber, green, steel) can recolour every screen; worth a check of each.
