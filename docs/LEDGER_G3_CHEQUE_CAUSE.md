# G3 — why the three cheques have no journal entry

Report before the rewrite, per instruction. A lifecycle that happens to fix
these without explaining them leaves the cause live.

Environment: `crm-design-dev` (`wlyhbvunvdsropqzlpwx`), SANDBOX TESTING ORG.
Every figure below was read on 2026-09-01.

---

## The three

| # | cheque | type | status | amount | entries |
|---|---|---|---|---|---|
| 1 | 1234 · Bilal Ahmad | cash | cleared | 5,000.00 | 0 |
| 2 | 222333 · Kiran Shah | cash | cleared | 5,000.00 | 0 |
| 3 | 4454 | payment | pending | 50,000.00 | 0 |

They are the **only** unposted rows in the entire database. The sweep across
`cheques`, `expenses`, `invoice_payments`, `advances`, `invoices`,
`custody_transfers`, `partner_account_entries` and `cash_deposits` returns these
two cash cheques and nothing else — every other source row posted at the instant
it was created.

## Cheques 1 and 2 — the posting path did not exist when they cleared

Not a logic defect. The current code is correct, and it was proved correct
rather than read as correct: the same row, re-inserted `pending` and updated to
`cleared` inside a rolled-back transaction with a sandbox JWT set so
`current_company_id()` resolves, produces **1 journal entry**.

```
REPLAY uid=5eed0000-…-5a01  after insert(pending): 0  |  after clear: 1
```

So the function works today. What failed is timing, and the mechanism is the
trigger's shape:

```sql
CREATE TRIGGER trg_yyy_cheques_journal
  AFTER DELETE OR UPDATE ON public.cheques   -- no INSERT
```

`journal_on_cheque` (0221) posts on the `pending → cleared` transition only.
Both cheques made that transition once, at 05:52:21 and 05:52:48 on 2026-08-28,
and 0221 was not yet applied. Nothing has updated them since and nothing will,
so the transition that would post them is spent.

**This is the general shape, not a cheque quirk:** a posting rule installed
after the data, on a trigger keyed to a state change rather than to state,
silently orphans every row whose change already happened. `0221` shipped without
a backfill. It got away with it on every other table only because those tables
had no qualifying rows yet — an accident of the sandbox's timeline, not a
property of the design.

Amount stranded: **10,000.00**, held as company cash with no GL record.

## Cheque 3 — no defect, and that is the problem

Two independent reasons it has no entry, both intended:

1. `journal_on_cheque` returns early on `new.cheque_type <> 'cash'`. Payment
   cheques are excluded by design — the assumption is that whatever the cheque
   pays (an expense, a payslip, an advance) posts itself.
2. The trigger fires on clearing, and this cheque is still pending.

Meanwhile `cheque_apply_balance` reduces `bank_accounts.balance` by the full
amount **on INSERT**, for every outgoing cheque of every type:

```sql
IF TG_OP = 'INSERT' THEN … UPDATE public.bank_accounts
   SET balance = balance - NEW.amount …
```

So the moment a cheque is written, the operational bank balance falls and the
GL does not move. For a cash cheque the two converge again at clearing. For a
pending payment cheque they never converge, because the GL never records the
issuance at all.

That gap — money committed, bank reduced operationally, ledger silent — is
exactly what the unpresented-cheque lifecycle exists to close, and it is what
T16 references.

---

## The bank divergence, decomposed exactly

`bank_control_equals_bank_accounts` is red by **948,467.00** (GL subtree
6,781,645.00 vs operational 5,833,178.00). It decomposes with no residue:

| component | amount | kind of defect |
|---|---|---|
| United Bank Ltd balance moved with no transaction at all | 800,000.00 | operational-only — never reached even the transaction log |
| 29 payslips where `amount_paid` exceeds `net_salary` | 88,467.00 | GL posts `net_salary`, the bank paid `amount_paid` |
| the three cheques above | 60,000.00 | 10,000 orphaned + 50,000 unpresented |
| **total** | **948,467.00** | |

The earlier reading of ~740,000 predates the reposts; this is the current
composition and it is arithmetically closed.

Two of the three are not cheque work:

- **The 800,000** is what `bank_accounts_equal_transaction_deltas` is red by
  (−800,000.00), and that check earns its place here: it compares operational
  balance movement to the operational transaction log, so it is the only one of
  the three that can see a balance edited behind the log's back. UBL: opening
  800,000.00, current 0.00, transaction rows 0.
- **The 88,467** is a policy question, not a bug to pick a fix for.
  `post_payslip_disbursement` relieves Salaries Payable and credits bank by
  `net_salary`; the disbursement actually paid `amount_paid`, which was higher
  on 29 of the disbursed bank payslips and lower on none. The excess is real
  money out of a real bank account with no ledger line. What it *is* — a bonus,
  an advance, a recoverable overpayment — is A-series policy and is not for me
  to choose. **Raised, not resolved.**

## Also visible while measuring

- **`payslips.cash_location_id` still exists.** 0267 dropped the dead column
  from `expenses`, `invoice_payments` and `advances`; `payslips` was not in that
  list because 0263 was adding `custodian_location_id` to it in the same series.
  The table now carries both. The old one should go the same way, once its
  readers are confirmed dead by the same method 0267 used.
- **Per-bank-account GL movement is zero across every account** — each bank
  sub-account holds exactly its opening balance and nothing else. Bank postings
  land on the undifferentiated `bank` control account, which is the same
  misrouting shape as the cash defect G2 closed. The subtree check cannot see it
  because misrouting between a parent and its children cancels inside the
  subtree. A per-bank-account check is the bank-side twin of
  `custodian_held_operational()`, and nothing currently measures it.
