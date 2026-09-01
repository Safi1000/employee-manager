# F4.1 — the arithmetic trace

**Trace only. Nothing fixed here.** Read with
[LEDGER_PHASE1_F41_DEFECT_RECORD.md](LEDGER_PHASE1_F41_DEFECT_RECORD.md), which
holds the causes; this holds the numbers.

Environment: `crm-design-dev` (`wlyhbvunvdsropqzlpwx`), SANDBOX TESTING ORG,
read on 2026-09-01. `partnership_allocation()` was called inside a transaction
that raised at the end — it is a `stable` function and writes nothing, but the
call was rolled back regardless.

---

## The headline finding, stated first

**The 135% over-allocation is no longer in `partnership_allocation()`.** The
function on dev is already the nested waterfall: regional shares are deducted
first, and equity partners take the **residual**, not the full profit.

```sql
  pool as (select coalesce(sum(profit - taken), 0) as residual from reg_alloc)
  ...
  select 'EQUITY_PARTNER', ..., round(pool.residual * eq_p.profit_share_percent / 100, 2)
    from eq_p cross join pool
```

Measured on both months, allocation now exhausts the pool **exactly**, to the
cent. The trace below shows that, then shows what the old rule would produce
against the same figures, which is the numerical demonstration of the 135%.

**B8's specific figures cannot be reproduced from today's database, and saying
so is part of the trace.** Three things changed between B8 and now: the basis
mixing is gone (0230/0232 hoisted basis to a company policy and added the §5.2
tripwire, which refuses a run whose report basis disagrees with the company's —
it fired on the first attempt at this trace); HO is nested rather than additive;
and the underlying cash moved when G2 and G3 reposted it. Presenting a
recomputed −1,326,374 would be presenting a different calculation under an old
label.

---

## The partners

| Partner | Scope | Share | Branch |
|---|---|---|---|
| Safi | BRANCH | 15.000% | North Region |
| Shayan | BRANCH | 20.000% | South Region |
| HAMNA | COMPANY | 100.000% | — |

`100 + 15 + 20 = 135`. That is where the headline number comes from: three
shares drawn from three pools that were treated as independent.

## Basis

`partnership_allocation(…, 'revenue')` **refuses to run**:

```
22023  Report basis "revenue" disagrees with this company's partner
       remuneration basis "cash" — one of the two is wrong, and a figure
       mixing them is meaningless
```

That is 0232's §5.2 tripwire doing its job, and it is the first defect in the
record closing itself. All figures below are therefore **cash basis**, which is
the company's policy.

---

## July 2026 — the arithmetic

Region profit, after the nested HO step:

| region | own profit | HO allocated | base |
|---|---|---|---|
| Head Office | −5,000.00 | 0 | −5,000.00 |
| North Region | 0 | 0 | 0 |
| South Region | −126,120.00 | 0 | −126,120.00 |
| Closed Region | 0 | 0 | 0 |
| **total profit** | | | **−131,120.00** |

HO's own −5,000.00 was **not** spread, because the cash-basis revenue base for
non-HO regions is zero in July and the function refuses to divide by it. It
appears as `UNALLOCATED_HO −5,000.00` — visible rather than absorbed by whoever
sorts first.

Regional remuneration, computed per client and summed:

```
  North Region  Safi     15%     0.00
  South Region  Shayan   20%   −25,224.00       (= 20% x −126,120.00)
                                ----------
  total regional take          −25,224.00
```

Residual, and the equity take:

```
  residual = Σ (region profit − region take)
           = (−5,000.00 − 0) + (0 − 0) + (−126,120.00 − (−25,224.00))
           = −5,000.00 + 0 + (−100,896.00)
           = −105,896.00

  HAMNA 100% of residual      = −105,896.00
```

**Exhaustion check:**

```
  regional  −25,224.00
  equity   −105,896.00
           -----------
  total    −131,120.00   =  total profit −131,120.00      ✓  100.000%
```

## August 2026 — the arithmetic

| region | own profit | HO allocated | base |
|---|---|---|---|
| Head Office | −103,999.87 | +103,999.87 | 0.00 |
| North Region | −542,066.00 | −9,454.53 | −551,520.53 |
| South Region | +1,720.00 | −94,545.34 | −92,825.34 |
| Closed Region | 0 | 0 | 0 |
| **total profit** | | | **−644,345.87** |

August has a non-zero revenue base, so HO's −103,999.87 **is** apportioned —
+103,999.87 leaves HO and −9,454.53 / −94,545.34 arrive in the regions. Note the
split is by revenue, not evenly, and it sums back to zero: `−9,454.5336… +
−94,545.3363… = −103,999.87`. Nested, not additive: HO appears once.

South Region is the case worth pausing on. It made an operating **profit** of
+1,720.00 and, after absorbing its share of head office, carries a **loss** of
−92,825.34. Its partner's 20% is therefore negative.

```
  North Region  Safi    −110,304.11
  South Region  Shayan   −18,565.07
                        -----------
  total regional take   −128,869.18

  residual = −644,345.87 − (−128,869.18) = −515,476.69
  HAMNA 100% of residual                 = −515,476.69
```

**Exhaustion check:**

```
  regional  −128,869.18
  equity    −515,476.69
            -----------
  total     −644,345.87  =  total profit −644,345.87      ✓  100.000%
```

The `UNALLOCATED` row reads `−0.000000000000363600000000` — a float artefact of
the revenue-proportion division, six orders of magnitude below a paisa. It is
not a rounding policy failure; it is the residual line reporting honestly that
it has nothing left.

**Negative shares carry with no floor** (A9), which both months exercise: every
partner take above is negative, and nothing clamps them at zero.

---

## The 135%, demonstrated numerically

The old rule took equity at 100% of the **full** profit while regional partners
took their share of their region's profit from a separate pool. Applying that
rule to the same figures:

| | July | August |
|---|---|---|
| total profit | −131,120.00 | −644,345.87 |
| regional take (unchanged) | −25,224.00 | −128,869.18 |
| equity take, **old rule** = 100% × total profit | −131,120.00 | −644,345.87 |
| **total allocated, old rule** | **−156,344.00** | **−773,215.05** |
| **as a share of profit** | **119.24%** | **120.00%** |
| total allocated, nested rule | −131,120.00 | −644,345.87 |
| as a share of profit | 100.00% | 100.00% |
| **over-allocation removed** | **−25,224.00** | **−128,869.18** |

The over-allocation is exactly the regional take, every time, and that is the
whole defect in one line: **under the old rule the regional share was
distributed twice** — once to the regional partner, and again inside the profit
the equity partner took 100% of.

135% is the **ceiling**, not the realised figure: it is what the factor becomes
when every rupee of profit sits in a region carrying both a 15% and a 20%
partner. The realised factor is `100% + (Σ regional take ÷ total profit)`, which
is 119.24% in July and 120.00% in August. Quoting 135% as the observed
over-allocation would overstate it; quoting 119% as the exposure would
understate the ceiling. Both belong in the record.

---

## What is still open, and is not touched here

The **function** is nested. Nothing else in F4 is done:

- `profit_allocation_runs` exists as a table and holds nothing. There is no
  draft → posted → reversed lifecycle.
- **The allocation posts no journal entry at all.** `journal_entries` has zero
  rows with an allocation source table, and
  `Regional Partner Remuneration` (6400) has a balance of **0.00**. Rows 33, 34
  and 35 of the posting rules are still `BLOCKED`.
- The 135% reconciliation check — the one that must fail before the fix and pass
  after — does not exist. It cannot now be written to fail against the current
  function, which is a real consequence of fixing the function before writing
  its check, and the inverse of the rule 0259 established. The honest form is a
  check that asserts `Σ allocated = total profit` and a fixture that reproduces
  the old rule to prove the check discriminates.
- `client_statement_loaded()` applying a regional pool *and* an HO pool to the
  same client (the A10 note) is not verified here either way.
