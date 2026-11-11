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
- **In progress (2026-10-22)** — Every figure clickable by default: a figure
  that is a sum opens the rows behind it in a DetailSheet. **Built:** Expenses
  band (spent by category, largest entries, head-office share, biggest
  category; Advances by client, by guard, repeat takers) and the Payroll band
  (total, disbursed, still to pay, advances — each by client), Invoices
  (invoiced, received, outstanding by client; collected % least first),
  Financial Reports ▸ Overview (red controls and findings jump to their
  panels; head office and cover open their tabs), Clearance (each count
  lists its guards), Clients (no live contract, guards by client, owed by
  client, concentration), Attendance board (unconfirmed, on ground, exceptions,
  not started — each register by client, site and shift), Contracts (value by
  contract, posted against committed shortest first, ending in 60 days).
  Assets, Store and Kit issuance tiles are left until
  those tables hold rows.
- **DECIDED 2026-10-22: not wanted** — Saved views per user (named filter
  sets and share links). Built and removed the same day at Shayan's word
  ("not required"); pages keep remembering their own state for the session.
- **Idea** — "What changed since you last looked" chip on each page (new
  invoices, new incidents, edits by others) using the audit log.
- **Idea** — Plain-language errors: every database error mapped to a sentence
  that says what happened and what to do, with the technical text behind a
  "details" disclosure.
- **Built** — Empty states that teach: each empty table says what belongs there
  and names the button that creates the first one (swept 2026-10-22, Round 5).

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

## Round 5 (2026-10-21 → 22) — the September reconciliation and what it needed

- **Built** — Banks & Ledgers ▸ Bank accounts: **Security deposits** (bid,
  performance, rent — company money held elsewhere, 1170, never an expense)
  and **Bank reconciliation** (reconcile a bank on a date; what came after
  shows; a "tallied on …" line on each bank card and a Banks tallied tile on
  the Dashboard). Migrations 0533, 0534.
- **Built** — Invoices ▸ Withholding tax: every WHT receipt is a claim until it
  is seen deposited (certificate / CPR number), with an overdue flag at 45
  days. 0536; 0543 stops a user verifying another region's receipt.
- **Built** — Partnership: Lahore outside the partnership from September with a
  declared monthly profit; Partnership Run ▸ By region; the equity share per
  region. 0537, 0538.
- **Built** — Accountant ▸ Tie-out: one month, every rupee in and out reached
  two independent ways, and "money with nowhere to land" with the fix for
  each item. 0539. September ties out on every line.
- **Built** — Assignments & Pay: the base-salary pencil opens **Pay** —
  monthly or per day at the man's own daily rate (relievers). 0540.
- **Built** — Payroll: a payslip paid in parts shows each part and the channel
  it went through; each part posts and reverses where it left. 0541.
- **Built** — Accounting ▸ **Fuel cards**: company float cards (load, bill,
  Attock balance, reverse a load) and allowance cards; "Fuel card" as a payroll
  payment mode. The Attock portal figure is a nightly check. 0542.
- **Needs data** — no fuel card is registered yet; until each float card has an
  Attock balance entered it reads red, on purpose.
- **Needs data** — Anjum Sharafat (reliever) has no rate of any kind.
- **Idea** — Fuel cards: a monthly Attock statement import instead of one typed
  balance, matching each bill line by date and amount.
- **Idea** — Payroll: a "split this payslip" button that pays the allowance to
  the card and the rest to the bank in one confirmation, instead of two
  disbursements.
- **Built** — Dashboard ▸ Partner shares: each partner's share of the month
  so far (cash basis, from `partnership_allocation`), each region's part in the
  sheet, and a note while a region outside the partnership has not declared.
- **Built** — Empty states that teach, on the screens that are empty on
  production today: Incidents (none logged is no longer "no matches for the
  filters"), Performance (bonus pools, appraisals, guard bonuses — what each
  is and which button starts it). The rest of the list screens already said
  what belongs there and how to add the first one; Kit issuance, Planning,
  Fixed expenses, Recurring alerts and Vehicles were checked and left.

## Transaction logs (2026-10-22)

- **Built** — Banks & Ledgers ▸ Transaction Log and Cash Custody ▸
  Transaction Log: payment runs fold into one row — same client, same pay
  month, same account, paid within three days — "HMC Taxila — September 2026
  payroll · 109 payments · −x" that opens to every line. Advances fold the
  same way. The client is read from the guard code in each line's own
  description. A "Group runs" switch gives the flat list back.
- **Built** — A search box (name, code, client, description) and a money in /
  money out / net strip for whatever the filters show, on both logs.
- **Built** — Day headers with each day's net on both logs.
- **Built** — One bank in view: its last reconciliation drawn in the log —
  "Tallied to the statement of …", with lines entered since and any
  suspense noted. (Cash custody has no statement to tally against.)
- **Built** — Expenses from one account or custodian on one day fold into one
  row ("Expenses · 6 expenses").
- **Built** — "Export as shown": the log as displayed — runs as one line,
  opened runs with their lines under them.
- **Built** — A cash withdrawal names the custodian it went to ("To Gul
  Rehman"), on the log, in its search and exports, and in the Bank Statement
  export.
- **Built** — One way to move bank money to a custodian: Withdraw on the bank.
  Cash Custody's transfer is custodian → custodian only (its "From Bank" option
  removed), with a pointer to Withdraw.

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

---

## Full audit — 3 Nov 2026 (every page, live data, read-only)

Walked every page and panel on the live site at laptop size (1366×860), with
phone-size spot checks, looking at what each screen shows, whether its figures
agree with the others, what it makes hard, and what a guarding company needs
that is not there. Nothing was changed while auditing. Everything below is an
**Idea** unless marked otherwise.

### A. Fix first — these are wrong or risky today

1. **Two-factor becomes compulsory on 5 Nov.** Shujaat Mehmood (CEO), Nauman
   Ahmed and Shafqat Ali have not set it up, so they will be locked out in two
   days unless they enrol (Access & Governance shows "Two-factor not set up").
2. **Backups have never run.** Access & Governance: "Backups — No backup yet".
   The weekly encrypted Drive backup is configured but nothing has been saved.
3. **Guard vetting is almost empty.** Compliance Calendar: police verification
   1 of 402 guards, NADRA Verisys 2 of 402, CNIC expiry recorded for 61%. For a
   licensed security company this is the largest exposure in the system.
4. **"Owed to us" has three different totals.** Dashboard 23.67M (with "0%
   older than 90 days"), Clients and the Invoices tile 21.08M (invoices only),
   Receivables 31.63M (with opening balances). Client cards go negative
   (AlRabi −597,386, Berger −744,414, Popular Brands −314,683) because they
   ignore opening balances. Every "owed" figure should read the one
   receivables function.
5. **October looks like a record month because payroll isn't posted.**
   Financial Reports: October net profit 10.83M (78.5%), "+1318% on
   September", with guard payroll 6,907 against 11.9M in September. The
   dashboard region tile shows a 93% margin for ISB/RWP for the same reason. An
   incomplete month must say so (or the page should default to the last
   complete month).
6. **The nightly controls can't be read in the app.** Accountant: "Controls red
   … running the nightly controls…" and "Running the checks…" never finish.
   A read-only run of `ledger_checks` today returned 13 red, including
   `ar_control_equals_open_invoices` (the ledger's receivables account against
   the open invoices, apart by about 36.5M), `payroll_accrual_matches_attendance`
   (19), `every_billed_client_carries_cost` (18) and
   `no_payroll_booked_as_expense` (15). The receivables one is confirmed
   straight from the ledger: account 1100 Accounts Receivable stands at
   −4,898,581 (a credit) over 264 lines, while clients owe 31.6M — see F5 for
   why. They should all be visible on the page. The
   Checks tab still labels several of these "Proposed (0516)" although they
   are live and red.
7. **Contracts show dates in US format** (10/01/2026, 09/22/2026, 06/30/2027)
   while the rest of the app is day-first. "10/01/2026" reads as 10 January.
   Bank & Ledgers mixes 20/10/2026 and 2026-10-21 in one row. One format
   everywhere; "3 Nov 2026" cannot be misread.
8. **49 guards have no base salary and 81 no joining date** (Assignments &
   Pay). That is exactly what produced Waqas Ahmed's zero October pay. Payroll
   Run shows "no base salary" chips but still lets the group move on.
9. **Lahore is settled but still live everywhere.** Seven Lahore contracts are
   Active with 0 guards (Berger 0/15, Madison 0/12 …). They produce 39 of the
   44 "understaffed", six of the 13 "missing invoices", six never-finished
   attendance registers, seven daily-report rows and a Lahore block every day.
   Mr Raza Firdous Market still has 5 active guards with no attendance.
   Ending or suspending these contracts clears most of the noise in one go.
10. **Innovative: 2 guards enrolled under a terminated contract** (PKR 64,000
    a month on the roster, nothing billed).
11. **A draft opening-balance batch has sat unposted since 3 September**
    (Accounting Core › Opening Balances). The dashboard's "3.19M between the
    ledger and the recorded balances" paragraph points at this.
12. **No month is locked.** Period Close: 0 of 4. August (cutover) and
    September (reconciled and agreed) can still be edited.

### B. Patterns that repeat across pages

- **Pages open on today, which is always empty in the morning.** Attendance,
  Relievers and Expenses (current month, three days old) open on a day or
  month with nothing in it. Open on the latest day or month that has work
  (usually yesterday).
- **Loading shows zeros.** Assignments & Pay shows "2 groups · 0 employees"
  for about 10 seconds; Payroll shows 0% for a run that is under way. Show a
  skeleton or the pipeline, never a zero that isn't true.
- **Tabs render above the page band on hub pages** (Incidents, Assets &
  Issuance, Relievers, Accounting Core, Payroll, Partnership, Access &
  Governance, Compliance), but inside it everywhere else.
- **Modules built but not used yet:** Incidents (0 ever), Store (0 items),
  Field supervisors (0 active of 54 sites), Task Board (5 tasks ever),
  follow-up contacts (0), client pay days (none set). Each needs an owner
  and a first step, not more features.
- **Paisa on headline tiles** (PKR 14,062,953.42; 2,411,518.5 in the P&L)
  beside rounded rows. Whole rupees on screen; paisa in drill-downs.
- **Internal references shown to users:** "(§4.4)", "Proposed (0516)",
  `daily_client_reports`, record UUIDs in the Audit Log.
- **Alert texts describe old menu paths** ("Operations › Field Supervisors",
  "Access & Governance › Field accounts"). Alerts should link, not describe
  where to click.
- **Delete sits beside View/Edit on every client card**, including HMC (109
  guards, 10M owed). Move it into the record, behind a confirmation that
  says what depends on it, or archive instead.

### C. Page by page

**Dashboard**
- Twelve panels; what needs action is mixed in with deep finance. Lead with
  the action items (expired documents, missing invoices, unpaid salaries,
  attendance not confirmed) and fold the rest.
- "343 / 349 on strength" (dashboard) against "376 deployed, 304 present"
  (Attendance report) for the same day, with no explanation of the difference.
- The Admin badge says "99+ guard documents expired"; the dashboard says 11
  guards. The badge actually counts 305 overdue compliance rows: **294
  uncleared separations** (people who left whose clearance — kit, dues, final
  settlement — was never completed) and 11 expired CNICs. The label is wrong,
  and the 294 is a real backlog worth its own queue. (Corrected 3 Nov.)
- Lower panels render blank while scrolling until they load.
- "What is coming due" is one item across a 30-day chart; "What is happening"
  is mostly payments from 21 Oct. Low value for the space.

**CEO Dashboard**
- Daily tab "Previous tasks" reads only tasks set exactly yesterday; the PDF
  also carries earlier open ones (four on 2 Nov, "Nil" on screen). **Built
  3 Nov** — fixed to match the PDF.

**Tasks**
- Two task systems that never meet: the Task Board (logins) and the Daily
  Report's "Tasks for tomorrow" (office staff). Neither shows the other.
  One list, or daily-report tasks shown on the board.
- Done cards still say "overdue" in red.

**Clients**
- The client record (HMC) has email, phone, NTN, STRN, filer status, WHT,
  signatory and billing address all blank. Invoices and WHT need NTN/STRN.
- Missing from the record: contact people (who in accounts to call), sites,
  the receivable ledger and follow-up history. The record is a small modal; a
  full page with tabs (Overview, Sites & strength, Contracts, Ledger &
  follow-up, Attendance, Complaints, Documents) would fit the business.
- "♥ 93" health score with no explanation; "Share of deployed guards" bar is
  low value. More useful on a card: overdue amount, last payment, contract
  end, contracted vs deployed.

**Contracts**
- The signed contract is not on file for most (Document column says
  "Upload" for Emaar, Bank of AJK, Berger …). A "no signed copy" counter.
- An annual escalation % exists on the contract form but is set on 1 of 32
  live contracts; there is no escalation date or reminder, and nothing
  reacts when the minimum wage changes. (Corrected 3 Nov — the first pass
  said the field didn't exist.)
- Contracted value 20.15M here against 19.94M on the dashboard.

**Invoices**
- Numbers follow the month the generator ran, not the month billed:
  GGS-26-INK-11 bills October, GGS-26-JSONS-11 bills November. Number by
  service month (or a plain sequence) — clients quote these on cheques and
  WHT certificates.
- The Outstanding tile (21.08M, invoices only) sits one tab away from
  Receivables (31.63M). Rename it or show the receivables figure.
- No region column and no due date / payment terms per invoice.
- Receivables: "Over 90 days 0" while 10.9M of opening balances are certainly
  older — fixed once opening balances are dated (waiting on the months).
  Lahore shows a net credit (804,379 CR); each credit needs a decision.
  Former clients (Al Fajar, Spaces by Kaizen, SGC - Guards) are mixed with
  live ones.
- Withholding tax: add the total awaiting (~438K) and the effective rate per
  payment (Emaar 0.47%, CBR 4.2%, MIU 8.3%, Bank of AJK 7.9%) — an odd rate
  is how a wrong entry gets caught.

**Payment Follow-up**
- No client has a usual pay day, though the sheets suggest one for many:
  "accept all suggestions".
- Small former-client balances (4,620 / 5,000 / 12,500 / 44,500) sit among HMC
  and Nova in "Late (23)": group them or send to write-off review.
- Four export buttons on one row: one "Export ▾" menu.
- On a phone the 12-column table needs cards.

**Expenses**
- Category Management sits on the working page; move it behind a button.
- Categories to tidy: "Maintainance", "Stationary" (spelling), "GIFT";
  "Payroll/Salary Expense" invites salaries entered twice beside the payroll
  module (the red `no_payroll_booked_as_expense` check agrees);
  "Lahore partner share" is a distribution, not an expense.

**Payroll / Payroll Run**
- One flow split across two sidebar entries; better as one page with the
  disburse step last.
- Every group in Payroll Run says the same "both halves need HR and Ops
  verification", while Attendance Run knows exactly which half is waiting and
  on whom. Show that per group, hide 0-person groups, and show the salary
  due date.
- The Finance Report surfaced "Sept 2026 salaries still to pay: 1,038,494 to
  52 people": confirm, and mark as paid if paid outside Bastion.

**Bank & Ledgers**
- NET POSITION adds "Owed to us 0" and "We owe 0", both wrong on their face.
  Drop them or feed the real figures.
- The −274,317 custodian opening residual is printed on the headline cash
  tile; move it into the custody detail.
- Cheque numbers like "121", "1212", "sa 789989799": no format check.
- Three levels of tabs on one page.

**Financial Reports / Partnership / Accountant**
- The same month carries three profits (Financial Reports 10.83M, Partnership
  draft 1.83M, dashboard region tile 11.36M), each on a different basis that
  the tile does not name.
- Accountant: 15 columns, three cash holders empty all month; negative
  personal cash (Nauman −17,100 closing, Shayan −11,262 brought forward); an
  "Everything else" row of −2.11M with no breakdown.
- Partnership: October must be posted by 10 Nov; Shujaat has drawn 4.95M
  against a 1.41M share — a "drawn more than earned" flag.

**Accounting Core**
- Opens on Opening Balances (a one-time tool) rather than Trial Balance or
  Journal.

**Employees**
- 363 of 702 records have no CNIC or joining date; profiles 36% complete;
  Bank of AJK and MIU 0%. Only Emaar has an owner and target date.
- "Inactive 300" mixes on-leave with left; split them.
- The profile-completion table fills the first screen; collapse it so the
  roster is visible.

**Attendance / Attendance Run / Relievers**
- Registers for 0-roster clients that can never be completed; the same 30
  clients listed twice (tile grid and list); Bank of AJK needs 29 site
  confirmations a day — "confirm all sites with no exception".
- Attendance Run: collapse finished halves; show the payroll cut-off.
- Relievers: Anjum Sharafat has pay PKR 0.

**Field App**
- Field Review / Field Activity tabs carry no counts; one "Site — all shift
  31 Oct confirmed" item is missing its site name; two screens for one inbox.
- Field Supervisors: 0 active logins, 54 sites with nobody; the only two
  logins are disabled tests. The next step is creating the real supervisors
  and assigning sites.

**Daily Reports**
- 32 rows every day; lead with clients that have something and "mark the
  rest nothing to report". Ops types "Invoice submitted" by hand although the
  delivery tick now records it.

**Incidents**
- 0 incidents ever, while the 2 Nov report flags Regent 1 (urgent): "client
  raised concerns regarding the deployed guards". An urgent note should offer
  "log as complaint" in one click.

**Assets & Issuance**
- Empty. Start the register with weapons (licence, bore, site/guard, rounds,
  licence expiry) — GGS bills weapons rental to three clients.

**Access & Governance / Settings / Audit Log**
- Role counts call the CEO and both RMDs "HR". Shafqat (Lahore, settled)
  holds 30 features, more than the CEO.
- Settings › Company profile edits personal display only; the company's own
  record (legal name, NTN, STRN, address, security licence number, bank for
  invoices) has no screen. Dashboard panels apply to everyone, not per user.
- Audit Log shows UUIDs and table names.

### D. What the business needs that isn't there

- **Vetting drive** — police verification, NADRA, training, licences, with an
  owner and weekly target on the dashboard.
- **Weapons register** with licence expiries and who holds what.
- **Client master data** — NTN/STRN, accounts contact, billing address.
- **Live gross margin per client** — monthly roster pay against monthly
  contract value (HMC 4.29M pay vs 5.09M contract), without waiting for the
  ledger.
- **Contract escalation** — the % field exists (1 of 32 filled); add the
  date, a reminder, and a minimum-wage impact view.
- **Supervisor roll-out** — the field app is approved but nobody is on it.
- **Complaints captured from the daily report**, so each client builds a
  history.

### E. Suggested order

1. This week: two-factor for the three logins; first backup; end the Lahore
   contracts; set the 49 missing salaries; post or delete the September
   opening batch; date the opening balances (needs Shayan's months).
2. Then the figures: one "owed" everywhere; incomplete-month warning on
   Financial Reports; make the controls load on Accountant; one date format.
3. Then the drives: vetting, supervisors on the app, client master data.
4. Then the polish in B and C.

### F. How each process is handled today — measured, 3 Nov 2026

Each process followed end to end, with figures read from the database
(read-only). For each: how it runs now, where it breaks, what would make it
better. **Q** marks a question only Shayan can answer — nothing here assumes
a policy.

**F1. Attendance: supervisor → HR → Ops → payroll**
- *Now:* every one of the 11,306 attendance marks in the last 30 days was
  typed by HR: 55% copied from WhatsApp messages, 43% entered by hand, 2% via
  the field app. "WhatsApp" is only a label HR picks; there is no import.
  Marks land on average 36 hours after the day ends; 834 were entered more
  than three days late. Then HR verifies each half-month, Ops verifies again
  (Attendance Run), then payroll can start.
- *Breaks:* one person retypes ~380 marks a day; the record is a copy of a
  message, not first-hand; a late register holds up the whole payroll; the
  daily report's attendance section is a day behind.
- *Better:* supervisors mark in the field app (built, 0 of 54 sites covered —
  the blocker is creating the supervisor logins and assigning sites); HR's job
  becomes confirming exceptions, not typing. Only 3 of 71 sites have GPS set,
  so geofenced check-in needs the site locations captured first (a supervisor
  can do it on the first visit).
- *Also:* 1,001 leave marks in 30 days (9% of all marks) and 316 double
  duties. Leave against each client's allowed leaves, and whether double duty
  is billed to the client and paid to the guard, deserve their own monthly
  view. **Q:** is double duty billed to clients?

**F2. Payroll: verified attendance → payslips → disbursement**
- *Now:* Draft → Review → Finance Verify → Disburse across two pages.
  September: 341 payslips, 289 paid, **52 still unpaid (1,038,494)**; 86 paid
  in cash, 255 by bank. October: nothing verified yet.
- *Breaks:*
  - **Kashmir salaries bypass payroll.** Bank of AJK's 53 guards are paid as one
    expense line a month (2,080,000 on 2 Sep, 2,120,000 on 1 Oct, category
    "Payroll/Salary Expense"), plus Apex World and Breakout. So there are no
    payslips for them: no per-guard record of what was paid, no EOBI per
    guard, no link from attendance to pay, and Kashmir's client profit can't be
    computed. This is the red `no_payroll_booked_as_expense` check (15).
    (Lahore's salary lines are the agreed 0573 settlement and are separate.)
  - 49 guards without a base salary, 81 without a joining date.
  - Each bank transfer is keyed into the bank portal by hand — there is no
    bulk-transfer file export, though IBANs are validated against the ABL
    format already.
  - Guards never receive a payslip. A per-guard payslip PDF exists but is
    reachable only from My Profile, which only office staff with a login have.
- *Better:* run Kashmir through payroll like ISB/RWP; block Review while any
  guard lacks a salary; export a bank bulk-transfer file per bank (Askari is
  the main payer); send each guard their payslip on WhatsApp from the
  disbursement screen.
- **Q — minimum wage:** 108 active guards have a base salary under 37,000 and
  118 under 40,000 (median 40,000). Some may be part-time or per-day; the rest
  should be checked against the currently notified minimum wage for each
  region.
- **Q — EOBI:** EOBI is deducted from 180 guards, but no guard has an EOBI
  registration number recorded, and the employer share is 0 on every payslip
  (August and September). If the employer share is paid through Statutory
  Payments, fine — but contributions can't be traced to a person without the
  numbers. (Ties to the parked "statutory challan by employee" item.)
- **Q — ages:** 2 active guards have a date of birth under 18 and 10 over 60
  — likely entry errors, but an armed guard under 18 is not allowed.

**F3. Recruitment → vetting → posting → exit**
- *Now:* people are added straight into Employees; a "Waiting list" tab
  exists. The database has a `recruitment_candidates` table and an
  `employee_training_records` table, but **no screen uses either** (both
  empty). Vetting fields exist and are almost empty: police verification
  1/402, NADRA 2/402, guard service licence 0, weapons certified 0,
  orientation 0, photo 0, social security registration 0, group insurance 0.
  168 guards are ex-servicemen — a strength worth recording (army number,
  unit) since clients ask for it.
- *Breaks:* nothing stops a guard being posted before verification; no record
  of training; expiring documents surface only as a count.
- *Better:* one hiring checklist per guard (CNIC + photo → police
  verification → NADRA → orientation/training → appointment letter → ID card
  → kit → posting), shown as progress on the guard's record and as a queue
  for HR; posting warns when the checklist isn't done. The tables are already
  there.
- *Exit:* clearance and the discharge sheet exist and the clearance
  certificate is wired; there is no gratuity / final-settlement calculation
  and no exit reason analysis (exit_reason field exists).

**F4. Billing → delivery → collection → WHT**
- *Now:* October had 19 invoices, 10 generated and 9 made by hand. Invoices go
  out on average 21 days after the service month starts. Payments arrive on
  average 20 days after the invoice. Since September 62 payments: 35 in cash
  (56%), 16 by cheque, 11 by bank transfer; 32 were "on account" (not against
  an invoice). Two cheques have bounced. Delivery is now ticked; follow-up is
  new (0 contacts logged).
- *Breaks:* manual invoices for the biggest clients (HMC, Emaar, MIU) mean the
  generator doesn't know their real billing; cash collection is high-risk
  without a receipt to the client; on-account receipts make per-invoice status
  approximate; numbering follows the run month, not the billed month.
- *Better:* teach the generator the variable invoices (HMC/Emaar) so all are
  "Auto"; give every receipt an official receipt PDF/WhatsApp to the client
  (none exists); month-end client statement sent automatically; usual pay
  days set so lateness is real.
- **Q — sales tax on services:** no invoice in Bastion carries sales tax (0 of
  60 since September), and only 2 clients have a sales-tax authority set.
  Security services are generally a taxable service under the provincial
  sales-tax laws; if GGS is registered and charges it, the invoices are
  understated; if it isn't, that's a decision to record. Either way it should
  be written down (DECIDED/DEFERRED).

**F5. The ledger — why the books and the screens disagree**
- Accounts Receivable (1100) in the ledger: invoices add a net 35.1M,
  receipts take away a net 40.0M, leaving −4.9M. The receipts include money
  against balances that existed before the cutover, but those opening
  balances (about **36.5M**) were never posted — the draft opening batch from
  3 September. That single unposted batch explains: the negative receivables
  account, the red `ar_control_equals_open_invoices`, the dashboard's "3.19M
  between the ledger and the recorded balances", and why the ledger's balance
  sheet can't be trusted yet.
- Kashmir salaries posted as expenses (F2) explain why "Guard payroll" in the
  P&L is near zero in October while "Other cost of services" carries 2.4M.
- *Better:* post the opening balances (one reviewed batch, approved by name),
  move Kashmir onto payroll, then close August and September. After that the
  dashboard, P&L, client profit and partnership all read the same truth.

**F6. Expenses, advances and cash**
- *Now:* 156 expenses entered in the last 30 days; 30 still not approved; **88
  (56%) have no receipt attached**. Since September the largest categories are
  "Payroll/Salary Expense" 6.88M (see F2), "Lahore partner share" 605K,
  "Miscellaneous" 551K across 30 entries (20 with no client), Uniform 410K,
  Fuel 194K across 43 entries. Advances: 622K to 26 guards in 60 days.
- *Better:* require a receipt photo above a threshold (the field app already
  captures photos); retire "Miscellaneous" into real categories; uniform
  purchases should land in the Store so issue-to-guard and recovery on exit
  work (Store is empty); a per-custodian cash limit and a weekly cash count.

**F7. Daily operations reporting**
- *Now:* 21 daily reports exported in the last 30 days; 144 client notes. The
  report is typed, not assembled: ops types "Invoice submitted" per client,
  while the delivery tick already knows it; complaints written in the report
  never reach Complaints (1 complaint in the system, ever).
- *Better:* the report assembles what Bastion already knows (attendance gaps,
  deliveries, payments received, open follow-up steps, field-app site reports)
  and ops adds only judgement. An urgent note becomes a complaint/incident in
  one click.

**F8. Clients and contracts as master data**
- Of 32 live clients: NTN on 6, phone on 7, escalation % on 1 contract, signed
  contract file on a handful. `clients.credit_ceiling` exists with no screen.
  Client service reviews (2 rows) and the **Client Service Report PDF exist but
  are unreachable** — their only page (Client Relationships) now redirects to
  Clients. Per the house rule ("a function nothing calls is the same gap"),
  that's an instance to wire or remove.

**F9. Security and administration**
- Backups never ran; two-factor missing on three logins five days before it's
  compulsory; Drive files from before 29 Oct still public-by-link. The CEO
  and both RMDs are counted as "HR" role. Shafqat (Lahore, settled) holds 30
  features.

### G. Missing features, module by module

Checked against the code and database first; "exists" means it's already in
Bastion somewhere.

**Sales & new business**
- Leads and quotations: none (Gulberg Heights is being contracted from the
  daily report with nothing in Bastion until the contract is signed).
- **Contract costing calculator**: wage + EOBI + PESSI/IESSI + uniform and
  kit amortised + relief cover + supervision + overhead + margin → rate per
  guard per month. The single most useful pricing tool for a guarding company;
  it also answers "which contracts lose money if the minimum wage rises".
- Tender / e-procurement tracking (EPADS registration is in the daily report).

**Clients & contracts**
- Client contacts (name, role, phone — accounts, admin, site in-charge).
- Escalation reminder and minimum-wage impact per contract.
- Post orders / SOP per site, site risk notes, site photos.
- Client satisfaction reviews and the monthly Client Service Report — exist,
  need wiring back.

**Workforce**
- Hiring checklist and recruitment pipeline (tables exist, no screens).
- Training records (table exists, no screen).
- Probation tracking (field exists; nobody on probation is recorded).
- Gratuity / final settlement calculation; exit reasons report.
- Guard ID card exists; appointment letter in "Generate documents".

**Field operations**
- Supervisor roll-out (built; nobody on it).
- Patrol checkpoints (QR at posts, scanned by the supervisor or guard) — none.
- Visit schedule per supervisor with coverage (visits table exists; 0 rows).
- SOS and incidents from the app — exist.

**Payroll**
- Bank bulk-transfer file; payslips to guards on WhatsApp; EOBI numbers and a
  per-employee challan; minimum-wage check on Review; overtime/double-duty
  pay rule.

**Finance**
- Official receipt to the client for every payment (especially cash).
- Monthly client statement, sent automatically.
- Sales tax on invoices (pending the Q above); sales-tax returns screen exists
  (0 returns recorded).
- Credit notes (supplementary invoices exist; no credit note).
- Expense receipt rule and custodian cash limits.

**Compliance**
- Company-level licences and renewals (security company licence, company arms
  licences, APSAA membership, insurance policies). The Licences tab today holds
  only guard CNICs (247), uncleared separations (294), two contract ends and
  two "important dates" — no company licence is recorded.
- Tax calendar (sales-tax return dates, WHT statements, annual return) as
  recurring dates.
- Weapons and ammunition register with licence expiries.

**Communication**
- WhatsApp is how the business runs (attendance, delivery, follow-up), but
  Bastion sends nothing on WhatsApp. Even a "share" button that opens WhatsApp
  with the payslip, invoice, receipt or reminder ready would remove most
  retyping.

### H. Order, if it were mine to choose

1. **Books right:** post the opening balances; move Kashmir salaries onto
   payroll; close August and September. (Fixes F5, half of A, every profit
   figure.)
2. **Safety:** two-factor before 5 Nov, first backup, Drive files private,
   review Lahore access.
3. **Noise out:** end the Lahore contracts; set the 49 salaries; Innovative's
   two guards.
4. **Stop the retyping:** supervisors on the field app (attendance), the daily
   report assembling itself, delivery/receipts shared on WhatsApp.
5. **Vetting drive** using the hiring checklist (tables exist).
6. **Pricing:** contract costing calculator + escalation reminders.
7. Then the page-level polish in B and C.

## Money on phones — the website is the open door (2026-11-08) — DEFERRED

Bastion Field shows no money. But the website renders on a phone browser, so
anyone whose role can see money on a computer can see it on a phone too.
Leaving money out of the app keeps it off the stores and off guards' phones; it
does not stop a person.

**What actually controls money is the permission, not the device.** RLS and
`has_perm()` refuse the same on every screen. A device check (user agent,
screen width) runs in the browser and is beaten by "Request desktop site", so
it can only ever be a nudge.

Options, cheapest first:

1. **Roles are the wall.** Supervisors and field staff hold Field permissions
   only, with no `*.view` on money. Check who holds money keys today; that list
   is the real answer to "who can see money on a phone".
2. **Tighten sessions on touch devices.** Same 2FA, but a 10-minute idle cut
   (instead of 30) when the pointer is coarse. A lost or borrowed phone is the
   actual phone risk. Cheap; lives in `InactivityLogout.tsx`.
3. **Soft block.** On a phone, money pages say "open on a computer", with a
   per-person override for the owners. Bypassable — a nudge, not a control.
4. **Trusted devices (real enforcement).** A new device needs approval before
   money permissions count on it: a `trusted_devices` row checked by
   `has_perm()` against the session. Heavy; only if 1–2 are not enough.

Recommendation: 1 + 2 now, 3 only if wanted, 4 not yet.
If the answer is "nobody sees money on a phone, owners included", that is
option 4, because 3 cannot promise it.

Also stale: `docs/MOBILE.md` describes a Capacitor wrapper of the website
(`android/`, `ios/`, `lib/platform.ts`) that no longer exists in the repo.
