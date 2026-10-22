# Ledger work queue — cutover and statutory pass

Opened 2026-10-17, updated the same day. Each item is owed, not done. Every
prod write named here still needs its own named authorisation (CLAUDE.md).
Numbers are claimed against the migration ledger AT APPLY TIME — another
session applies to this database too.

## Applied

| Migration | When | Red set (scoped) |
|---|---|---|
| `0518_a_prepaid_release_follows_its_expense` | 2026-10-17, recorded 20261016225202 | GGS 17 → 18, SHAYAN_A 5 → 5. `prepaid_released_matches_schedule` new, red 7 at GGS, green at SHAYAN_A; `no_stale_prepaid_balance` 6 → 5 at GGS; `checks_evaluated` 44 → 45 at both. `migration_ledger_matches_repo` 5 → 6 at both until 0518 is pushed and fetched. GGS was 17 before, not 18: `no_advance_booked_as_expense` had gone green since the 16 Oct record. |

All applied 2026-10-17, each authorised by name, recorded SQL = file for each.
Red sets are scoped AND timestamped (PKT, the database's clock):

| Migration | Recorded | Before | After | Moved |
|---|---|---|---|---|
| `0519_the_ledger_cutover_date_is_a_setting` | 20261017004035 | 05:39:56 GGS 18, SHAYAN_A 5 | 05:40:50 GGS 18, SHAYAN_A 5 | drift 6 → 7 (both) |
| `0520_a_statutory_liability_is_remitted_not_expensed` | 20261017004152 | 05:40:50 | 05:42:58 GGS 19, SHAYAN_A 5 | `no_statutory_remittance_booked_as_cost` NEW: GGS red 5, SHAYAN_A green 0; drift 7 → 8 |
| `0521_an_opening_batch_line_carries_its_party` | 20261017004325 | 05:42:58 | 05:43:36 GGS 19, SHAYAN_A 5 | drift 8 → 9 |
| `0522_a_pre_cutover_cost_entered_late_adjusts_the_opening` | 20261017004402 | 05:43:36 | 05:44:47 GGS 19, SHAYAN_A 5 | drift 9 → 10 |
| `0523_the_cutover_archive_operational_cash_the_askari_correction_and_the_close` | 20261017004527 | 05:44:47 | 05:46:21 GGS 19, SHAYAN_A 5 | GGS `bank_control_equals_bank_accounts` −7,357,119.23 → −7,383,119.23 (the Askari +26,000; still red); drift 10 → 11 |
| `0524_employer_eobi_is_accrued_at_payroll` | 20261017004655 | 05:46:21 | 05:47:14 GGS 19, SHAYAN_A 5 | drift 11 → 12 |

"drift" = `migration_ledger_matches_repo`, both companies; it clears once
0518–0524 are pushed and the nightly manifest fetch sees them.

**0524 REFUSES while the employer amount is unset** (DECIDED 2026-10-17): a
payslip that withholds employee EOBI cannot be created or have its EOBI
changed until `payroll_statutory_settings.eobi_employer_amount` is set.
Disbursing, notes and other edits are unaffected. **The October payroll cannot
be generated for any guard with EOBI withheld until the amount is supplied.**

**The batch's Cr 1160 359,419.53 line is OUT** of
`2026-08-31-cutover-batch-proposed.csv` (2026-10-17, after 0522 applied). The
batch is now 656 lines; Opening Balance Equity 28,613,746.23 (it was
28,254,326.70 with the line).

## Dated

| When | Item |
|---|---|
| ~~before 2026-11-01 02:20~~ | "till september 43,000": **met by 0519 + 0522 (applied).** The 1 Nov run carries July and August to 3200 dated 15 Oct and releases September; nothing posts on or before 31 Aug. Check the run's output on 1 Nov anyway. |

## AN ORDERING CONFLICT — the Lahore backfill and the cutover

The Lahore backfill is exactly the case 0522 does not cover: August payslips
entered late. Their accruals post dated in August (the payslip's own month).

- If the backfill lands **after the cutover**, its entries itemise August in
  the GL — the very thing the cutover removes — and once July/August are
  closed, the period lock refuses them outright.
- Closing August "later" is not enough: the problem is the cutover's archive,
  not only the close.

**Recommendation: the Lahore August backfill lands BEFORE the cutover is
drafted.** Then the cutover archives Lahore's August entries with the rest
and the opening carries them: Lahore's unpaid August salaries in 2100, by
guard, computed from the GL like every other line. Order:
**Lahore roster → Lahore backfill → redraft the batch from the GL → cutover.**

If the roster cannot arrive in time, the alternative is an exception built
for it: a payslip for a pre-cutover month posts its cost to 3200 and its
liability to 2100 dated after the cutover — the 0522 rule extended to
`post_payslip_accrual`, which has many authors and is the payroll's own
posting. Recommended only if the cutover cannot wait.

**So the cutover now waits on the Lahore roster (Shayan's).**

**Bank openings went in ahead of the cutover (0544, 2026-10-22, asked for by
Shayan).** The four banks' balances from before the ledger began are posted
as an opening batch dated 1 August (Askari 3,645,821 — its 31 Aug 3,619,821
plus the 26,000 August advance already in the GL; BOAJK 2,368,041; Allied
707,902; Soneri 775,855.23; Cr 3200 7,497,619.23). The cutover archives it
with the rest of August and its redraft, drawn from the GL, carries the banks
at their 31 August balances. **The redraft must not add bank openings again.**
`2026-08-31-cutover-batch-proposed.csv` still has them and is superseded on
that point; the draft batch 9d90fee2 had its four bank lines taken out by
0544 (now 24,712,229: receivables and Gul Rehman's 890).

## Prepared, waiting on the user

### Employer EOBI amount (for 0524)
- **Needed:** the employer EOBI amount per insured guard per month.
- **Evidence:** the September challan decomposes exactly: 244,200 = 100 guards × 2,442 = 6% of 40,700 → 407 employee + **2,035 employer**. August does not decompose exactly (266,500 / 109 = 2,444.95).
- **Where it lives (0524, APPLIED, empty):** one company setting (`payroll_statutory_settings.eobi_employer_amount`), not a contract field — the employer contribution is statutory and the same for every insured guard.
- **BUT** "insured" is read as "payroll withholds employee EOBI", and that set (190 in September) is not the challan's set (100). Until the gap below is resolved, filling the amount would accrue employer EOBI for 190 guards while 100 are paid for.

### The 189-vs-109 / 190-vs-100 gap — money withheld from guards' pay
Every guard is listed OUTSIDE git, in `Desktop/bastion-private/` (2026-eobi-deductions-aug-sep-WITH-CNIC.csv and a copy without CNICs; 379 rows: code, name, client, amount withheld, status, joining date). DECIDED 2026-10-17: guard-level EOBI lists and anything carrying CNICs stay out of git (.gitignore).
- **No employee has an EOBI registration number recorded**, so the system cannot tell who is insured; the challan is the only list.
- **September:** withheld 76,611 from 190 guards — HMC Taxila 113 × 407, Emaar DHA ISB 71 × 400, Wusat-Emaar 6 × 370. The challan pays 100 × 407 = 40,700 of employee share. **35,911 withheld from 90 guards' pay is not on that challan.**
- **August:** withheld 73,290 from 189 guards — 112 × 400 (Emaar DHA ISB, HMC Taxila), 77 × 370 (Emaar DHA ISB, Wusat-Emaar). The challan names 109. If its employee share is 400 a head, **at least 29,690 withheld from at least 80 guards is not on it.**
- **Together: at least 65,601 withheld and not shown remitted.**
- **Second finding:** 77 deductions in Sep (Emaar 400, Wusat 370) are below the statutory 407; the challan pays 407 regardless, so the difference is company cost.
- **The precise question for the challans:** which CNICs are on the August (109) and September (100) challans, and were the other 80 / 90 guards' deductions paid on another challan, or held?

### Conversions (one authorisation each once the challans arrive)
Each is one transaction: unapprove the expense, `delete_expense` (which reverses its GL and restores its money, 0366/0381), then `remit_statutory_liability` with the same date, mode and account. Expected effect: `no_statutory_remittance_booked_as_cost` falls by one per converted row.

| Expense | Paid | Through the action | Against liability | Remainder | Waits on |
|---|---|---|--:|--:|---|
| Eobi 109 guards, 266,500 | 14 Sep, Cash | EOBI, August | 73,290 (2300) | 193,210 → 3200 (pre-cutover) | August challan month |
| Eobi paid for 100 guards, 244,200 | 2 Oct, Bank | EOBI, September | 76,611 (2300) | 167,589 → 5100, or 0 if employer EOBI is backfilled for September first | September challan month; the employer amount |
| FBR Taxes, 41,923 | 15 Sep, Cash | salary tax, August, **3,080 only** | 3,080 (2450) | 38,843 — not salary tax; the action refuses it | FBR challan breakdown |
| FBR Tax paid, 27,013 | 15 Oct, Bank | salary tax, September, **2,962 only** | 2,962 (2450) | 24,051 — as above | FBR challan breakdown |
| PRA Tax paid, 15,346 | 15 Sep, Cash | — | — | — | whether PRA applies |
| PESSI Taxila Jul–Aug, 132,000 | 5 Oct, Cash | PESSI, July/August | 0 (2350 empty) | 132,000 → 3200 (pre-cutover) | nothing; ready |
| PESSI Taxila Sep, 60,025 | 5 Oct, Cash | PESSI, September | 0 | 60,025 → 5100 (unchanged account) | nothing; optional |

The 1 Nov release run will first release 244,200 to 5100 and 27,013 to 7000
for September (both carry a service period); converting either afterwards
reverses its release automatically (0518).

## A column a user cannot fill

- **Settling a payable that names no supplier.** Zafar Iqbal's assumed 9,900
  (2000 Accounts Payable, tagged EMP-0182) has no screen that repays it:
  payable payments run through an expense's vendor. His repayment needs a
  manual journal (Dr 2000 tagged EMP-0182 / Cr cash or bank) until a screen
  exists. Queued here so it is not discovered when he asks for his money.

## The user's to answer

- The FBR challan breakdown for the 62,894: 68,936 paid, less 6,042 of salary
  tax withheld.
- Whether PRA applies to these clients at all. The invoices carry no sales tax
  (the tax-added total is 0 for Sep and Oct), and the user's own rule says
  sales tax is a liability.
- That the two EOBI challans cover the month before each payment, and which
  guards (CNICs) are on each — see the gap above.
- The employer EOBI amount per guard per month (2,035 if the September challan
  is representative).

## Also open, no owner yet

- Which month "Pessi paid" 60,000 (1 Oct) and IESSI 51,282 (15 Oct) cover.
  Neither description says.
- 0522 does not cover a payslip for a pre-cutover month created later (the
  Lahore backfill): once July and August are closed, the period lock refuses it.
  It needs its own decision when the backfill comes.
- The cutover set is now **444** GGS entries dated on or before 31 Aug, not 442:
  0518's Nova correction added a reversal and a re-release dated 31 Aug.
- The batch's Cr 1160 359,419.53 line comes OUT under 0522: those August
  releases become carries when the cutover archives them.
