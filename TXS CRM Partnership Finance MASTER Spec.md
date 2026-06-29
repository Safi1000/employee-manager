# TechxServe CRM — Master Specification
## Partnership, Profit Distribution, Cash Custody & Project Financing

**Audience:** Engineering (no accounting background required)
**Module:** Accounting & Finance (extends Partnership, Banks & Transactions, Clients/Contracts, Branches)
**Status:** Ready to build
**Currency:** PKR throughout
**Supersedes:** the earlier "Partner Accounts and Cash Custody" spec — this document contains everything.

---

## 0. Read this first (the whole picture)

The system today can only record money going *out* as an **expense** or a **salary**, and it has no idea *who physically holds cash* or *how owners and investors split profit*. That breaks four real things this business does:

1. **Paying partners their profit share.** It's not a cost — it's owners taking their own money out. Booking it as an expense understates profit, and since shares are *calculated from* profit, it corrupts itself in a loop.
2. **Tracking who holds the cash.** Most cash collected goes to the CEO, who spends, tops up with his own money, and keeps leftovers. The total is known; the *ownership* of it isn't.
3. **Splitting profit fairly across a multi-branch partnership** where the owner shares the whole company, regional partners share only their branch, specific clients have custom splits, and one branch can owe another branch's partner a referral cut.
4. **Financing specific projects with raised investment**, where investors get either a share of that project's profit (by how much they put in) or fixed finance costs, and their capital is repaid over time.

This spec adds four linked features that fix all of it. They share one core idea — **a running ledger per person** — so the parts fit together cleanly.

| Feature | What it does |
|---|---|
| **1 — Partner Accounts & Distribution** | A running ledger per partner; a proper "pay a partner" event that never hits profit. |
| **2 — Cash Custody** | Cash "locations" owned by named people, so held cash is tracked; CEO float handled. |
| **3 — Multi-tier Allocation** | Computes each partner's share: owner = whole company, regional partners = their branch (fixed %), client overrides, cross-branch referral cuts, optional company-retained slice. |
| **4 — Project Investment & Financing** | Per-project investor ledgers; profit-share or fixed-finance returns; capital tracked and repaid; payouts gated by cashflow. |

---

## 1. Glossary (plain English)

| Term | Meaning |
|---|---|
| **Partner** | An owner of the business entitled to a share of profit. |
| **Owner partner** | Has a share of the **whole company's** profit. |
| **Regional / branch partner** | Has a **fixed %** of **their own branch's** profit only. |
| **Partner Account** | A running tab per partner: money owed *to* them vs money they've *taken*. The Nauman spreadsheet is one of these. |
| **Profit Allocation** | A partner's profit share for a period, added to their tab. (Spreadsheet: "Remuneration".) |
| **Drawing** | Money paid *out* to a partner (cash/bank/fuel card). Reduces their tab. **Never an expense.** |
| **Contribution** | A partner's *own* money put *into* the company. Increases their tab. |
| **Undrawn entitlement** | Profit allocated to a partner that they've chosen not to take yet — sits as a positive tab and as extra cash in the bank that is *owed to them*. |
| **Cash Location** | A place money physically sits: a bank account *or* cash held by a named person. |
| **Custody Transfer** | Moving company cash between locations. Changes *where* money is, not *whose* it is. |
| **Investor** | Someone who funds a specific project. May be a partner or an arms-length third party. |
| **Reserved profit %** | The slice of a project's profit set aside for its profit-share investors. |
| **Finance cost** | A fixed return paid to a third-party investor (like interest). A real **expense**. |
| **Cash basis** | Profit measured as cash actually received minus cash actually paid. We distribute on this basis. |
| **Retained / company share** | Profit deliberately kept by the company, owned by no partner. Currently 0; configurable. |

---

## 2. The mental model (read once, everything follows)

**Two separate ideas, kept apart:**

- **Whose money is it?** Every partner and every investor has a **running tab** with the company. Earning profit, or putting their own money in, makes the tab go **up** (company owes them). Taking money out makes it go **down**. Positive tab = company owes them. Negative tab = they've taken more than earned.
- **Where is the money?** Cash sits in **locations** (banks and people). Moving it between locations changes *where* it is, never *whose* it is.

**The profit waterfall (top to bottom), all on a cash basis:**

```
PROJECT (= a client) cash profit
  └─ minus third-party FINANCE COSTS (an expense)
  └─ minus RESERVED INVESTOR SHARE  → split among profit-share investors by (their contribution ÷ total required)
  └─ remaining project profit drops into ↓
BRANCH pool (sum of its clients' leftover profit)
  └─ minus REFERRAL CUTS owed to other branches' partners (off the top)
  └─ split by fixed % between OWNER(s), REGIONAL PARTNERS, and optional COMPANY-RETAINED
        └─ each partner's slice is posted to their PARTNER ACCOUNT (Feature 1)
```

Everything below is the detail of those boxes.

---

# FEATURE 1 — Partner Accounts & Profit Distribution

## 1.1 Data model

### `partners`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `name` | string | e.g. "Col. (R) Nauman" |
| `scope` | enum | `COMPANY` (owner) or `BRANCH` (regional partner) |
| `branch_id` | uuid, nullable | required if `scope = BRANCH` |
| `allocation_method` | enum | `FIXED_PCT` (auto) or `MANUAL` (typed each period). Owner usually `MANUAL`; regional partners `FIXED_PCT`. |
| `default_share_pct` | decimal(5,2), nullable | used by the engine / as a suggestion |
| `linked_user_id` | uuid, nullable | |
| `opening_balance` | decimal(14,2) | starting tab; locked after first save |
| `opening_balance_date` | date | |
| `is_active` | bool | |

### `partner_account_entries` (the running ledger — append-only)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `partner_id` | uuid | |
| `date` | date | |
| `type` | enum | `OPENING`, `PROFIT_ALLOCATION`, `DRAWING`, `CONTRIBUTION` |
| `description` | string | |
| `amount` | decimal(14,2) | stored positive; `PROFIT_ALLOCATION` may be negative (loss share) |
| `payment_method` | enum, nullable | `CASH`, `BANK_TRANSFER`, `FUEL_CARD`, `CHEQUE` (drawings/contributions) |
| `cash_location_id` | uuid, nullable | required for `DRAWING`/`CONTRIBUTION` |
| `linked_transaction_id` | uuid, nullable | the matching cash movement (Feature 2) |
| `period_month` | date, nullable | for `PROFIT_ALLOCATION` |
| `is_locked` | bool | true once its month is closed |
| `created_by`, `created_at` | | |

> **Balance is derived.** Order entries by `date` then `created_at`; apply §1.2.

## 1.2 The four entry types

| Type | Partner tab | Cash | Hits P&L? |
|---|---|---|---|
| `OPENING` | sets start | — | no |
| `PROFIT_ALLOCATION` | **+ amount** (may be negative) | — | **no** |
| `CONTRIBUTION` | **+ amount** | location **↑** | **no** |
| `DRAWING` | **− amount** | location **↓** | **no** |

```
balance_after = balance_before
              + (PROFIT_ALLOCATION ? signed_amount : 0)
              + (CONTRIBUTION       ? amount        : 0)
              - (DRAWING            ? amount        : 0)
```

> **Critical:** none of these write to Expenses or Payroll. That separation is the core bug fix.

## 1.3 Adding a partner
Capture `opening_balance` + date → creates the `OPENING` entry. Opening balance locks after first save (same pattern as employee "Opening Leaves").

## 1.4 Recording a Drawing (paying a partner)
Fields: date, amount, payment_method, `cash_location_id` (source), description. On save: create a `DRAWING` entry **and** the matching cash-out transaction (Feature 2), linked. No Expense/Payroll row. **Overdrawing is allowed** (the real ledger runs deep negative); show the negative balance in red with a non-blocking note.

## 1.5 Recording a Contribution (partner's own money in)
Fields: date, amount, payment_method, `cash_location_id` (destination), description. On save: `CONTRIBUTION` entry + matching cash-in transaction, linked. No Revenue row.

## 1.6 Profit Allocation
The *amounts* are computed by Feature 3 (or typed in for `MANUAL` partners) and posted here as `PROFIT_ALLOCATION` entries, normally at month-end. See Feature 3.

## 1.7 Partner Statement (replaces the spreadsheet)
Table: Date · Particulars · Drawing(out) · Allocation(in) · Contribution(in) · **Balance** (running). Negatives in red. Date filter + Excel export. Header strip: Allocated / Drawn / Contributed / **Net** ("Company owes partner" or "Partner overdrawn").

## 1.8 Partners Summary
One row per partner: Allocated to date · Contributed to date · Drawn to date · **Net balance**. The fairness check across everyone.

---

# FEATURE 2 — Cash Custody (who holds the cash)

## 2.1 Idea
Money lives only in bank accounts today. Cash is also physically held by people (mostly the CEO). A **cash location** is the same shape as a bank account (balance + history); it just has a type and an optional holder.

## 2.2 Data model

### `cash_locations`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `name` | string | "Meezan Bank", "CEO Cash (Col. Nauman)" |
| `location_type` | enum | `BANK`, `PETTY_CASH`, `CUSTODIAN` |
| `custodian_partner_id` / `custodian_user_id` | uuid, nullable | who holds it |
| `opening_balance` | decimal(14,2) | |
| `branch_id` | uuid, nullable | |
| `is_active` | bool | |

> Migration: existing bank accounts → `cash_locations` with `location_type = BANK`. No change to current bank handling.

### `cash_transactions`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `date` | date | |
| `direction` | enum | `IN`, `OUT`, `TRANSFER` |
| `amount` | decimal(14,2) | positive |
| `from_location_id` / `to_location_id` | uuid, nullable | per direction |
| `category` | enum/string | `CLIENT_RECEIPT`, `SALARY`, `EXPENSE`, `VENDOR`, `PARTNER_DRAWING`, `PARTNER_CONTRIBUTION`, `CUSTODY_TRANSFER`, `INVESTOR_CAPITAL_IN`, `INVESTOR_CAPITAL_REPAYMENT`, `INVESTOR_RETURN_PAYOUT`, `FINANCE_COST_PAYMENT` |
| `linked_partner_entry_id` / `linked_investor_entry_id` | uuid, nullable | |
| `reference`, `notes` | | |

Location balance = opening + Σ(IN) − Σ(OUT) + Σ(TRANSFER in) − Σ(TRANSFER out).

## 2.3 Custody Transfer
Move cash between two locations (e.g. cash handed to the CEO, or CEO returns it to the bank). Touches nothing else — no profit, no tab, no expense.

## 2.4 Receipts & payments choose a location
- **Client receipt** → destination is any location (bank *or* a custodian).
- **Salary/expense/vendor payment** → source is any location (this is how the CEO pays salaries from cash he holds; the expense books normally).

## 2.5 Cash Position by Holder
Screen + dashboard widget listing every location, its holder, and balance, totalling to today's overall cash figure.

## 2.6 Cash vs Liabilities reconciliation (the "inflated balance" view)
Because an owner can leave profit **undrawn** to ease cashflow (§3.7), extra cash in the bank may actually be **owed to a partner**, not free. This view shows:

```
Total cash (all locations)
 − Σ positive partner balances (undrawn entitlements owed to partners)
 − Σ investor return balances owed but not yet paid
 − Σ investor capital outstanding (to be repaid)
 = Free company cash (truly unencumbered)
```

So if an owner leaves PKR 500,000 of his share in, the bank shows +500,000 but this view attributes it to him and keeps "free company cash" honest.

---

# FEATURE 3 — Multi-tier profit allocation

Decides **how much** each partner's `PROFIT_ALLOCATION` should be. Does not change the ledger engine.

## 3.1 Partner scopes
Owner = `COMPANY` scope, share of whole-company profit (usually `MANUAL`). Regional partners = `BRANCH` scope, `FIXED_PCT` of their branch's profit. (Fields already on `partners`, §1.1.)

## 3.2 Distribution rules (hierarchical — most specific wins)

### `profit_distribution_rules`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `level` | enum | `COMPANY`, `BRANCH`, `CLIENT`, `CONTRACT` |
| `target_id` | uuid, nullable | the branch/client/contract (null for COMPANY) |
| `effective_from` | date | |

### `profit_distribution_rule_lines`
| Field | Type | Notes |
|---|---|---|
| `rule_id` | uuid | |
| `beneficiary` | enum | `PARTNER` or `RETAINED` |
| `partner_id` | uuid, nullable | |
| `percentage` | decimal(5,2) | |

Resolution per pound of profit: `CONTRACT` → `CLIENT` → `BRANCH` → `COMPANY`. Lines sum ≤ 100%; **the shortfall is the company-retained share** (currently 0 because everything is distributed — see 3.6).

## 3.3 Branch & client cash profit
Cash basis (§ the waterfall in §2), using existing branch attribution and the existing **Client Statement** (which already yields per-client revenue/cost/net → per-client cash profit, enabling client-level rules).

## 3.4 Referral arrangements

### `referral_arrangements`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `referring_partner_id` | uuid | the partner (usually another branch) who gets the cut |
| `source_branch_id` | uuid | the branch that pays it |
| `basis` | enum | `CLIENT_PROFIT` or `BRANCH_PROFIT` |
| `client_id`/`contract_id` | uuid, nullable | if `CLIENT_PROFIT` |
| `percentage` | decimal(5,2) | |
| `funding_method` | enum | `OFF_THE_TOP` (default), `PARTNERS_ONLY`, `CUSTOM_SPLIT` |
| `custom_split_lines` | json, nullable | for `CUSTOM_SPLIT` |
| `is_active` | bool | |

The cut is **credited to the referring partner** and **funded** from the source branch's claimants per `funding_method`.

## 3.5 The allocation engine (per branch, monthly)
1. Compute per-client cash profit for the branch.
2. Clients/contracts with their own rule → allocate that client's profit by its rule.
3. Remaining clients → branch pool.
4. Apply branch referral arrangements: credit referring partner; fund per `funding_method`:
   - `OFF_THE_TOP` — subtract the cut from the pool before splitting, so **everyone currently sharing it** (owners, regional partners, and the company-retained slice if any) bears it pro-rata.
   - `PARTNERS_ONLY` — charge only the active partners (owner + regional), pro-rata to their %, leaving any retained slice untouched.
   - `CUSTOM_SPLIT` — charge specified partners by set amounts/%.
5. Split the remaining pool by the branch rule (owner %, regional %, retained %).
6. Sum each partner's amounts across all branches/clients/referrals → their **suggested** `PROFIT_ALLOCATION`. `MANUAL` partners (the owner) can override. Post as §1.6 entries — no ledger change.

**Default funding rule chosen for this build:** `OFF_THE_TOP` across whoever is actually sharing the profit. Since the company-retained slice is currently 0, the cut today falls entirely on the owner + regional partners pro-rata; if a company margin is switched on later (3.6) it will share the cost automatically.

**Reconciliation assertion:** per branch, `Σ(partner allocations) + retained = branch_cash_profit`. Refuse to post if it doesn't balance.

## 3.6 Company-retained share (currently 0, future-ready)
Today the rule lines sum to 100% (all profit distributed), so retained = 0. Two future paths, both supported now:
- **Flat-rate default:** set a `company_retained_pct` default applied to each project/branch unless overridden — a deliberate margin kept by the company (retained equity, owned by no partner).
- **Owner leaves share in:** see 3.7 — this does **not** create a company-retained slice; it stays the owner's money, just undrawn.

## 3.7 An owner leaving his share in (cashflow support)
When an owner decides to keep part of his profit in the company to ease cashflow:
- He is still **allocated his full share** (a normal `PROFIT_ALLOCATION` to his tab).
- He simply **does not draw it** (no `DRAWING` recorded).
- Result: his partner tab stays **positive** (the company owes him), and the bank balance is higher by that amount.
- The **Cash vs Liabilities view (§2.6)** attributes that extra bank cash to him, so it isn't mistaken for free company money.

No special transaction type is needed — it's the deliberate absence of a drawing, made visible. Optionally tag the undrawn profit with a note like "left in for cashflow" for reporting clarity.

## 3.8 Permissions/settings
Manage rules + referral arrangements under **Partners & Distributions → Edit** (referral creation gated to owner/Super Admin). Regional partners see only their branch's rules and figures.

---

# FEATURE 4 — Project Investment & Financing

Some projects are funded by raised investment. Each reserves a slice of *that project's* profit for its profit-share investors; arms-length third parties instead get fixed finance costs. All capital is tracked and repaid.

## 4.1 What a "project" is
A project is normally **a whole client** (occasionally a contract). Project cash profit = that client's cash profit (from the Client Statement / §3.3).

## 4.2 Data model

### `projects`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `name` | string | |
| `client_id` / `contract_id` | uuid | what the project maps to |
| `total_required` | decimal(14,2) | total investment the project needs |
| `reserved_profit_pct` | decimal(5,2) | slice of project profit reserved for **profit-share** investors |
| `payout_gate` | enum | `COMPANY_CASHFLOW` or `PROJECT_CASHFLOW` — what must have cash before returns are paid |
| `status` | enum | `Raising`, `Active`, `Completed` |

### `investors`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `name` | string | |
| `type` | enum | `PARTNER` or `THIRD_PARTY` |
| `linked_partner_id` | uuid, nullable | if `PARTNER` (rolls up into their partner view) |
| `is_bank_connected` | bool | false for arms-length third parties |

### `project_investments`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `project_id` | uuid | |
| `investor_id` | uuid | |
| `return_type` | enum | `PROFIT_SHARE` or `FIXED_FINANCE` |
| `committed_amount` | decimal(14,2) | how much they agreed to fund |
| `fixed_cost_amount` / `fixed_schedule` | nullable | for `FIXED_FINANCE`: total finance cost and/or an installment schedule |

### `investor_ledger_entries` (two derived balances: **capital outstanding** and **return balance**)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `investor_id` | uuid | |
| `project_id` | uuid | |
| `date` | date | dated, for proper tracking |
| `type` | enum | `CAPITAL_IN`, `CAPITAL_REPAYMENT`, `RETURN_ALLOCATION`, `RETURN_PAYOUT`, `FINANCE_COST_ACCRUAL`, `FINANCE_COST_PAYMENT` |
| `amount` | decimal(14,2) | |
| `cash_location_id` | uuid, nullable | where money moved |
| `linked_transaction_id` | uuid, nullable | |
| `is_locked` | bool | |

**Capital outstanding** = Σ `CAPITAL_IN` − Σ `CAPITAL_REPAYMENT`.
**Return balance** (owed but not yet paid) = Σ `RETURN_ALLOCATION` − Σ `RETURN_PAYOUT` (+ accrued unpaid finance cost for fixed investors).

## 4.3 Profit-share investor returns
At allocation time, for each project:
1. Project cash profit is computed **after** deducting any third-party finance costs (4.4 — those are expenses).
2. Reserved investor pool = `reserved_profit_pct × project_profit`.
3. Each profit-share investor's share = `(committed_amount ÷ total_required) × reserved_pool`. Posted as a `RETURN_ALLOCATION` to their investor ledger (not an expense).
4. Any part of the reserved pool not claimed by profit-share investors (because the rest was funded by fixed-finance or by the company filling a gap — §4.6) **stays with the company**.
5. The remaining `(1 − reserved_profit_pct) × project_profit` drops into the branch pool for Feature 3.

## 4.4 Third-party fixed finance
Arms-length third parties get **fixed installments / finance cost**, not profit. The finance cost is a real **expense** that reduces the project's profit before any split (`FINANCE_COST_ACCRUAL` → hits P&L; `FINANCE_COST_PAYMENT` when paid). Their **principal** is tracked and repaid (`CAPITAL_IN` / `CAPITAL_REPAYMENT`) and is **not** an expense — just returning their money.

## 4.5 Capital repayment & payout timing
- **Capital repayment** is recorded with **dates** as `CAPITAL_REPAYMENT` entries against `capital outstanding`, paid from a chosen cash location.
- **Returns accrue monthly** (`RETURN_ALLOCATION` / `FINANCE_COST_ACCRUAL`) but **pay out only when cashflow allows**, governed by the project's `payout_gate` (company-wide or project-specific cash). A `RETURN_PAYOUT` is the actual payment, reducing the return balance.

## 4.6 Under-funded projects / company gap-fill
Normally raised = required (else the project doesn't proceed). When the company fills a gap from its own pool, record it as a `CAPITAL_IN` by an investor record representing the company; the company then earns that gap's proportional slice of the reserved pool (which simply stays with the company). So `Σ contributions = total_required` always holds.

## 4.7 Partner-investors
If an investor `type = PARTNER`, their investor ledger is linked to their partner record so the partner's overall position (ordinary profit share **plus** project returns **plus** capital outstanding) can be rolled into one view. A partner from another region investing in a project is fully supported.

---

# 5. Worked examples (use as test cases)

### Example A — Col. Nauman, real figures (May–Jun 2026)
Start after 30 Apr 2026 = **(519,981)**.

| Date | Event | Type | Amount | Balance |
|---|---|---|---|---|
| 16.05.26 | Cash paid | DRAWING | 100,000 | (619,981) |
| 22.05.26 | Fuel card | DRAWING | 20,000 | (639,981) |
| 30.05.26 | Bal till 31 May | PROFIT_ALLOCATION | +518,456 | (121,525) |
| 12.06.26 | Cash paid | DRAWING | 110,000 | (231,525) |
| 12.06.26 | Fuel card | DRAWING | 20,000 | (251,525) |

Final **(251,525)** — matches the manual ledger.

### Example B — CEO float, full cycle
Start: CEO Cash = 0; CEO tab = 0.

| Step | Event | CEO Cash | CEO tab |
|---|---|---|---|
| 1 | Custody Transfer Bank→CEO Cash 600,000 | 600,000 | 0 |
| 2 | Contribution by CEO 50,000 → CEO Cash | 650,000 | +50,000 |
| 3 | Pay salaries/expenses 650,000 from CEO Cash | 0 | +50,000 |
| 4 | Custody Transfer Bank→CEO Cash 700,000 | 700,000 | +50,000 |
| 5 | Pay salaries/expenses 500,000 | 200,000 | +50,000 |
| 6 | Profit Allocation to CEO 150,000 | 200,000 | +200,000 |
| 7 | Drawing by CEO 200,000 from CEO Cash | 0 | 0 |

Ends fully reconciled (holds 0 company cash, owed 0). Profit untouched by steps 2/6/7. **Old system:** step 7 would be an "expense" → profit understated 200,000. Fixed.

### Example C — cross-branch referral (funding rule)
Lahore profit 1,000,000. Owner 40%, Mr. A (Lahore) 30%, remainder retained (currently 0 → 30% of 1,000,000 in this illustration sits as retained; with retained=0 the owner/partner %s would be set to absorb 100%). Mr. B (Islamabad) referred a client; cut = 10% of Lahore profit = **100,000** to Mr. B.

`OFF_THE_TOP` (this build's default), pool after cut = 900,000:
| Beneficiary | Calc | Amount |
|---|---|---|
| Mr. B (referral) | 10% × 1,000,000 | 100,000 |
| Owner | 40% × 900,000 | 360,000 |
| Mr. A | 30% × 900,000 | 270,000 |
| Retained | 30% × 900,000 | 270,000 |
| **Total** | | **1,000,000** |

(`PARTNERS_ONLY` alternative: Owner 342,857 / Mr. A 257,143 / Retained 300,000 / Mr. B 100,000.)

### Example D — project investment
Project = Client Z. `total_required` 1,000,000; `reserved_profit_pct` 25%.
Investors: **P** (partner, another region) committed 750,000 `PROFIT_SHARE`; **T** (third party) committed 250,000 `FIXED_FINANCE`, finance cost 25,000 for the period.
Project cash profit **before** finance cost = 1,025,000.

| Step | Calc | Amount |
|---|---|---|
| Less T's finance cost (expense) | | −25,000 |
| Project profit after finance cost | | 1,000,000 |
| Reserved investor pool | 25% × 1,000,000 | 250,000 |
| → P's return | (750,000 ÷ 1,000,000) × 250,000 | 187,500 |
| → unclaimed reserved (T is fixed) stays with company | 25% × 250,000 | 62,500 |
| Remaining profit → branch pool | 75% × 1,000,000 | 750,000 |
| **Check** | 187,500 + 62,500 + 750,000 | **1,000,000** |

Separately: P's capital 750,000 and T's capital 250,000 are tracked and repaid over time with dates; T's 25,000 finance cost is paid as a cost.

### Example E — owner leaves his share in
Owner allocated 400,000 this month but draws only 150,000.
- `PROFIT_ALLOCATION` +400,000; `DRAWING` −150,000 → owner tab **+250,000** (company owes him).
- Bank is 250,000 higher than if he'd drawn it all.
- Cash vs Liabilities view shows: of the cash on hand, 250,000 is owed to the owner → not free company cash.

---

# 6. Impact on existing reports

| Report | Change |
|---|---|
| **Profit & Loss** | Excludes all partner drawings/contributions/allocations and all investor profit-share returns and capital movements. **Includes** third-party finance costs (a real expense). |
| **Cashflow** | Drawings, contributions, investor capital in/out, return payouts, and finance-cost payments appear in a separate **Partner / Financing** section, not operating expenses. Custody transfers net to zero. |
| **Partnership report** | Becomes Partner Statement (§1.7) + Partners Summary (§1.8) + per-project investor statements. |
| **Dashboard** | Bank Account Overview extended to custodian locations; add **Cash by Holder** and **Cash vs Liabilities** widgets. |
| **Period Close** | Locks that month's partner entries, investor entries, and cash transactions; blocks back-dated posting. |
| **Trial Balance** | Add the accounts in Appendix A so it stays balanced. |
| **Audit Log** | Logs all new entry/transaction types. |

---

# 7. Data migration

1. Re-class any partner payouts currently booked as expenses/salaries into `DRAWING`s against the right partner and cash location; remove from Expenses/Payroll (corrects historical profit upward).
2. Seed each partner's `opening_balance` from the latest reconciled spreadsheet balance at the cutover date (for Nauman, the agreed figure on that date).
3. Set up branches, partner scopes, distribution rules, any referral arrangements, and existing projects/investors with their current capital-outstanding as opening figures.

---

# 8. Permissions (extends user guide §19.2)

| Group | Permissions |
|---|---|
| Partners & Distributions | View, Edit, **Allocate Profit** |
| Cash Custody | View, Edit, **Transfer** |
| Projects & Investors | View, Edit, **Manage Capital/Returns** |

Branch-scoped users see only their branch's partners, locations, rules, projects.

---

# 9. Settings
- `distribution_basis`: `CASH` (default) | `ACCRUAL`
- `company_retained_pct` default (currently 0; future flat-rate margin)
- Default `referral funding_method`: `OFF_THE_TOP`
- Manage cash locations/custodians, partners/scopes, projects/investors.

---

# 10. Acceptance criteria

1. Partner running balance reproduces Example A to the rupee.
2. A drawing/contribution creates **no** Expense/Payroll/Revenue row; it only moves a tab and a cash location.
3. Custody transfer changes nothing but two location balances.
4. Allocation engine reproduces Example C (chosen funding rule) and Example D, and asserts per-branch and per-project reconciliation.
5. P&L is unchanged by any partner drawing/allocation/contribution or investor profit-share/capital movement; P&L **is** reduced by third-party finance costs.
6. Investor capital outstanding and return balance track correctly with dates; payouts respect the project's `payout_gate`.
7. Owner-leaves-share-in (Example E) shows a positive owner tab and the Cash vs Liabilities view attributes the extra cash to him.
8. Cash Position by Holder totals equal the overall cash figure.
9. Period close locks all related records and blocks back-dating.
10. Trial balance balances after every new transaction type (Appendix A).

---

# Appendix A — Accounting postings (for correctness / trial balance)

**New accounts:** Asset `Cash in Hand — [Custodian]`; Equity `Partner Current Account — [Partner]`; Equity `Profit & Loss Appropriation`; Liability `Investor Capital — [Investor]`; Equity `Investor Return — [Investor]`; Expense `Finance Costs`; Liability `Finance Cost Payable`.

| Event | Debit | Credit |
|---|---|---|
| Profit allocation (profit) | P&L Appropriation | Partner Current Account |
| Profit allocation (loss) | Partner Current Account | P&L Appropriation |
| Drawing | Partner Current Account | Cash/Bank location |
| Contribution | Cash/Bank location | Partner Current Account |
| Custody transfer | Receiving location | Source location |
| Salary/expense from custodian | (expense/payroll) | Cash in Hand — Custodian |
| Investor capital in | Cash/Bank | Investor Capital |
| Investor capital repayment | Investor Capital | Cash/Bank |
| Investor profit-share allocation | P&L Appropriation | Investor Return |
| Investor return payout | Investor Return | Cash/Bank |
| Third-party finance cost accrued | Finance Costs (P&L) | Finance Cost Payable |
| Finance cost paid | Finance Cost Payable | Cash/Bank |

Key property: **only third-party finance cost touches the P&L** (it's a true cost of borrowing). Every partner/investor profit and capital movement is balance-sheet/appropriation, which is why none of them distort profit.

---

# Appendix B — Confirmed assumptions & open items

1. **Referral funding default = `OFF_THE_TOP`** across whoever currently shares the profit (today: owners + regional partners, since company-retained = 0). Configurable per arrangement. *Confirm this is the intended default.*
2. **Owner = MANUAL allocation** with a %-suggestion; regional partners = `FIXED_PCT`. ✔
3. **Regional partner % applies to gross branch profit** (parallel claimants with the owner). ✔
4. **Company-retained share is currently 0** (all profit distributed); flat-rate margin is future-ready and off by default. ✔
5. **Owner leaving his share in = undrawn entitlement**, still owed to him, surfaced via Cash vs Liabilities — not converted to company equity. ✔ *Confirm he should remain entitled to draw it later (vs permanently gifting it to the company).*
6. **Third-party finance cost = expense (hits P&L); principal = balance sheet; partner/investor profit-share = appropriation (no P&L).** ✔ (standard treatment — flag if you book finance cost differently.)
7. **Reserved investor pool** is shared by profit-share investors via `contribution ÷ total_required`; any unclaimed remainder (fixed-finance or company gap) stays with the company. ✔
8. **Project = a whole client** by default (contract-level supported). ✔
9. **Return payouts gated by cashflow** (`COMPANY_CASHFLOW` or `PROJECT_CASHFLOW` per project); capital repayment tracked with dates. ✔
