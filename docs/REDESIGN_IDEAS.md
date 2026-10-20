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
