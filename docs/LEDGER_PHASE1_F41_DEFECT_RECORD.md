# F4.1 — Partnership allocation: defect record

**Date:** 2026-08-31
**Status:** Record only. Nothing fixed. **Gated on a scope decision — see §5.**

This is a defect record, not an arithmetic trace. The root causes are visible in the
source without needing the B8 figures, and B8 (July remuneration −1,326,374 against P&L
+747,531; August +4,116,869.31 against an operating loss of −642,346) becomes
*confirmation* of them rather than the derivation.

It is written now, before any fix, because the three defects below must be carried onto
whatever report survives §5. If `regional_pl_range` is retired, this record is the
specification for not rebuilding the same joins.

---

## 1. Basis is mixed within one report — by construction

`partnership_allocation(p_start, p_end, p_basis)` decides basis **twice, from two
different sources**:

```sql
-- the partner's take:  branches on the PARTNER's column
partner_take:  case lower(rp.basis)
                 when 'cash'    then coalesce(csc.net, 0)
                 when 'revenue' then coalesce(csr.net, 0)
               end

-- the profit it is shown against:  branches on the REPORT's parameter
pl.profit:     case when lower(p_basis) = 'cash' then r.profit_cash
                                                 else r.profit_accrual end
```

`rp.basis` is `partners.basis`. `p_basis` is the report parameter, defaulting to
`'revenue'`. **Nothing constrains them to agree.**

Current sandbox partners:

| Partner | Scope | Basis | Share | Branch |
|---|---|---|---|---|
| Safi | BRANCH | **cash** | 15% | North Region |
| Shayan | BRANCH | **cash** | 20% | South Region |
| HAMNA | COMPANY | (null) | 100% | — |

So on a default run (`p_basis = 'revenue'`), **remuneration is computed on collections and
displayed against accrual profit.** Locked policy: *never mixed within one report.*

### Why this is a data-model defect, not a default to realign

`partners.basis` is **per partner**; report basis is **per report**. Those are
incompatible shapes. If one partner is cash and another accrual, no value of `p_basis`
renders both correctly in a single report. Two partners on the same period must see the
same basis, or receive two separate statements — a per-partner column guarantees neither.

Basis is a property of *how the report is drawn*, not of *who the partner is*. A partner
agreement specifies a rate and a scope; it should not specify a measurement convention.

**Open question (§5.3): should `partners.basis` exist at all?** This touches commercial
terms, so it is flagged, not decided.

---

## 2. Period basis is `invoice_date`, contradicting A4

```sql
-- regional_pl_range, revenue CTE
where i.company_id = cid.company_id
  and i.invoice_date between p_start and p_end
```

A4 recognises revenue at **service month** (`period_start`). Migration 0225 repointed the
ledger accordingly and reposted seven entries. `regional_pl_range` was not touched and
still keys on `invoice_date`, so **the ledger and this report now disagree by construction
about which month revenue belongs to.**

In the sandbox every invoice carries `invoice_date 2026-08-28` against June/July service
periods, so this function puts *all* revenue in August and none in June or July, while the
ledger (post-0225) splits it correctly.

---

## 3. The cash-basis row set is accrual-shaped

```sql
per_client:
  left join cs_rev  csr on csr.branch_id = rp.branch_id
  left join cs_cash csc on csc.branch_id = rp.branch_id
                       and csc.client_id = csr.client_id
```

The row set is driven by `cs_rev` — the **revenue** statement. `cs_cash` is joined *onto*
it on `csr.client_id`.

For a cash-basis partner, a client who **paid in the period but was not invoiced in it**
produces no `csr` row, so it contributes **nothing** to that partner's take. Catch-up
receipts — precisely the August half of B8's sign flip — are silently dropped.

This is not a slip in the join. It is §1's mixed basis expressed structurally: a cash
question asked through an accrual-shaped row set. Fix the basis properly and this join
does not need patching — it ceases to exist.

---

## 4. What B8's signs then are

Given §1–§3, the reported pattern is what the mismatch produces, not evidence of an
arithmetic error:

- **July** — weak collections against accrual profit. Cash-basis remuneration is small or
  negative while the accrual P&L shows profit.
- **August** — catch-up receipts against an accrual operating loss. Cash-basis
  remuneration spikes positive while the accrual P&L is negative.

Two supporting signals, both consistent:

- The August figure carries decimals (`.31`) while the others are round — one side is
  computed, the other entered or rounded.
- **A negative July share is permitted by design.** The no-floor carry-forward rule (A9)
  makes negative shares correct behaviour, so the sign alone is not evidence of a bug.

**None of this is confirmed against B8 itself** — B8 is not in the Phase 0 discovery
document and its source has not been supplied. The above is the mechanism the code
produces; matching it to B8's exact figures requires the report those numbers came from.

---

## 5. The decisions this is gated on

### 5.1 Does `regional_pl_range` survive?

It builds expenses **solely from `public.expenses`** and never reads `journal_lines`. It is
the union-of-operational-tables artifact Phase 0 flagged as a double-counting source once
the GL carries data — and §2 shows it now contradicts A4 as well.

Fixing its mixed basis makes a doomed function correct. **Answer this before any fix
lands.** Either it is rewritten onto `journal_lines`, or the ledger-derived report replaces
it. Everything downstream branches here, and it is a scope decision, not a code one.

### 5.2 If it is being retired

The only change worth making now is **making it fail loudly**: reject any run where a
selected partner's `basis` differs from `p_basis`. A report that refuses to draw beats one
that silently mixes. One guard clause, no arithmetic. *Not implemented — awaiting 5.1.*

### 5.3 Should `partners.basis` exist?

See §1. Commercial-terms question, flagged not decided.

---

## 6. Why the sandbox cannot currently validate a fix

All seven sandbox invoices share `invoice_date 2026-08-28`. There is **no period split to
get right**, so a corrected function and a broken one produce identical output on this
dataset — testing against the one shape that hides the defect.

A fixture is required before any fix, and is needed on **either** path in §5.1, since the
ledger-derived replacement needs the same coverage:

1. Invoices whose `invoice_date` and service month fall in **different periods**, alongside
   ones where they coincide — so `invoice_date` basis and service-month basis produce
   genuinely different distributions.
2. A client with an **August receipt and no August invoice** — the §3 case.

See `supabase/tests/fixtures_period_split.sql`.
