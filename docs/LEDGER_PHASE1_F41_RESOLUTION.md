# F4.1 re-derived against production, and what F4 inherits

Re-derivation of `docs/LEDGER_PHASE1_F41_DEFECT_RECORD.md` against the
`partnership_allocation` that is actually deployed on `crm-design`
(`mmkfpnshxjcyijhuydgr`), now that 0232 has landed there.

**One of three is fixed. Two survive, and both belong to F4 as specified
requirements rather than as bugs to fix in `regional_pl_range`, which Phase 1
retires.**

| Defect | Status on prod | Magnitude |
|---|---|---|
| **D1** — basis mixed by construction | **DEAD** | n/a |
| **D2** — revenue keyed on `invoice_date`, not service month | **SURVIVES** | **4,292,000** across 8 invoices |
| **D3** — `per_client` row set driven by `cs_rev` | **SURVIVES** | **810,000** across 5 payments |

Verified against the deployed function, not the repo file.

---

## D1 — dead, and dead in the right way

```
single cfg source        : true    -- cfg as (select partner_basis_for_report(...))
reads partners.basis     : false
partners.basis column    : dropped
```

Both halves of the number now come from one company setting, and
`partner_basis_for_report` **raises** if the report is drawn on a basis the
company does not use. The §5.2 guard shipped with the §5.1 hoist, which is what
made this a fix rather than a narrowing.

Nothing for F4 to carry.

---

## D2 — revenue is recognised in the month the invoice was raised

```
regional_pl_range keys revenue on : i.invoice_date between ...
mentions period_start             : false
```

Policy **A4** is settled: revenue is recognised at the **service month**
(`period_start`). `regional_pl_range` does not reference `period_start` at all.

### Magnitude: 4,292,000 over 8 invoices

Every invoice on production whose invoice month differs from its service month:

| Invoice | Raised | Service | Amount |
|---|---|---|---:|
| STS-26-CTD-06 | 2026-08-28 | 2026-06-01 | 1,050,000 |
| STS-26-CTD-07 | 2026-08-28 | 2026-07-01 | 1,050,000 |
| STS-26-DPA-06 | 2026-08-28 | 2026-06-01 | 784,000 |
| STS-26-DPA-07 | 2026-08-28 | 2026-07-01 | 784,000 |
| STS-26-VTX-07 | 2026-08-28 | 2026-07-01 | 244,000 |
| STS-26-IRN-06 | 2026-08-28 | 2026-06-01 | 90,000 |
| STS-26-IRN-07 | 2026-08-28 | 2026-07-01 | 90,000 |
| FIX-SEP-CROSS | 2026-10-05 | 2026-09-01 | 200,000 |
| **Total** | | | **4,292,000** |

**Every one of them is misplaced by one to two months**, and six of the eight
were raised in a single August batch covering June and July service. A regional
P&L drawn today puts 4.29m of June/July revenue into August.

Note what this is *not*: the GL itself is correct. 0225 reposted the invoice
journal entries to the service month and `T26 revenue_at_service_month` passes.
The defect is confined to `regional_pl_range`, which reads `invoices` directly
rather than the ledger — which is precisely why Phase 1 is retiring it.

### Scope caveat, stated plainly

All 9 invoices on production belong to **SANDBOX TESTING ORG**. The two live
companies — GUARDS AND GUIDES (550 employees) and guards n guides (527) — have
**zero** invoices, payslips and journal entries. So 4,292,000 is the magnitude
in the only data that exists, not a live misstatement. It becomes one the moment
real invoicing starts, and the batch shape above is exactly what real invoicing
will look like.

---

## D3 — a cash-basis partner loses any client who paid but was not invoiced

```
per_client join : csc.client_id = csr.client_id   -- cs_rev drives the row set
full outer join : false
```

`per_client` left-joins `cs_cash` onto `cs_rev`. Under a **cash** basis the
amount comes from `csc.net`, but the row set still comes from `cs_rev`. A client
who **paid** in the period without being **invoiced** in it contributes no row,
so their receipt never reaches the partner's share.

### Magnitude: 810,000 over 5 payments

Five of production's six `invoice_payments` are from clients with no invoice in
the month of payment. Under a cash basis those receipts are invisible to
`partnership_allocation` — 810,000 of 960,000 total receipts, so **the defect
drops about 84% of cash receipts by value**.

This is the more dangerous of the two. D2 misplaces revenue between periods and
nets out over a year. D3 **omits** it, and the omission is silent: the report
returns a smaller number with no indication anything is missing.

It is also the one that fires under the basis the company actually uses —
policy A9 puts regional partners on **cash**.

---

## What F4 inherits

Both are requirements on the replacement, not repairs to the current function.
`regional_pl_range` and `partnership_allocation` are being retired; fixing them
would be work thrown away, and the earlier decision not to fix
`regional_pl_range`'s mixed basis was right for the same reason.

**R1 — recognise revenue at the service month.** The replacement reads the
**ledger**, not `invoices`. `journal_entries.posting_period` is already correct
(0225 reposted it, T26 asserts it), so sourcing from the GL satisfies A4 by
construction rather than by remembering to use the right column. That is the
stronger form: a report built on the ledger cannot key revenue on
`invoice_date`, because the ledger does not store one.

**R2 — the row set must be the union of invoiced and paid clients.** Under any
basis, a client appears if they have activity of the kind the basis measures. A
`full outer join` between the two statements, or a per-basis row set, rather
than one basis's row set silently governing the other's amounts.

**R3 — the replacement must be able to fail on both.** Two assertions, on the
same discipline as everything else this month:
  * a client invoiced in month M and paid in M+1 appears in M's revenue-basis
    figure and M+1's cash-basis figure, in the right amount for each;
  * a client paid in M with no invoice in M appears in M's **cash** figure —
    the assertion D3 would fail today.

Both need a fixture that is a shape the application produces.
`supabase/tests/fixtures_period_split.sql` already builds the period-split case
(A: service and raise coincide; B: they cross; C: a receipt with no invoice) and
is the natural home. Its invoices still carry a NULL `contract_id`, which
`uq_invoice_contract_month` does not constrain — F6 in the fixture audit, not
yet remediated.
