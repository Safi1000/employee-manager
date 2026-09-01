# Proposal — the second resolver map: guarding every tenant-scoped id, not just the first

**Proposal only. Nothing implemented.** Same discipline as 0242: the map is
hand-written and reviewed, the generation is mechanical, the verification tests
the property rather than the generation.

---

## 1. The gap

0242's generator guards **exactly one parameter per function** — the first uuid.
`post_manual_journal` carries two guards only because I wrote the second by
hand in 0242b, and then did not generalise it. Same failure mode as the NULL
regression: a pattern applied by hand and lost in the generated path.

**26 guarded functions accept 34 tenant-scoped uuid parameters that are never
checked.**

The exploit shape is the one `post_manual_journal` had: pass your own id in the
guarded position and another company's id in an unguarded one, and the function
writes a cross-tenant reference. Nothing is disclosed; something is *written*
across the boundary, which is worse to unwind.

---

## 2. Severity, worst first

| function | unguarded | what it does with them |
|---|---|---|
| **`fund_region`** | `p_lender`, `p_borrower`, `p_approval_request_id` | **a cross-tenant financial transfer.** Only `p_company_id` is checked; lender and borrower regions are not. The clearest case on the list. |
| `change_client`, `change_category`, `rehire_guard` | `p_new_client_id`, `p_contract_line_id`, `p_site_id` | deploy your guard onto another company's client, contract line and site — three foreign keys, written |
| `record_bank_to_custodian` | `p_custodian_location_id` | moves money to a cash location that need not be yours |
| `pay_bonus_allocation` | `p_payslip_id` | attaches a bonus allocation to a foreign payslip |
| `raise_alert`, `request_approval` | `p_branch_id` | writes a row tagged to another company's branch |
| `post_journal` | `p_region_id` | tags a journal entry with a foreign region — the same defect 0242b fixed in `post_manual_journal`, one level down |
| `generate_bonus_pool`, `avg_deployed_guards`, `branch_revenue_for_month`, `interregion_net_position`, `region_cash_entitlement`, `region_profit`, `region_operating_profit`, `region_operating_profit_range` | `p_branch_id` | reads scoped to a foreign branch |
| `cash_account_for` | `p_location_id` | resolves an account for a foreign cash location |
| `compute_kpi_value` | `p_kpi_definition_id` | computes against a foreign KPI definition |
| `ai_credit_spend` | `p_usage_id` | writes a foreign `ai_usage` id into the credit ledger |
| `seed_document_checklist` | `p_company_id` | **a second company parameter**, unchecked — `[claimed]` shape in the second position, which the generator never looks at |

---

## 3. Proposed map

Hand-written. Every target table verified to exist and carry `company_id`
before proposing it.

| parameter | table | pattern |
|---|---|---|
| `p_new_client_id` | `clients` | resolved |
| `p_client_id` | `clients` | resolved |
| `p_contract_line_id` | `contract_lines` | resolved |
| `p_site_id` | `sites` | resolved |
| `p_branch_id` | `branches` | resolved |
| `p_region_id` | `branches` | resolved |
| `p_lender` | `branches` | resolved |
| `p_borrower` | `branches` | resolved |
| `p_approval_request_id` | `approval_requests` | resolved |
| `p_location_id` | `cash_locations` | resolved |
| `p_custodian_location_id` | `cash_locations` | resolved |
| `p_kpi_definition_id` | `kpi_definitions` | resolved |
| `p_payslip_id` | `payslips` | resolved |
| `p_credit_account_id` | `chart_of_accounts` | resolved |
| `p_bank_account_id` | `bank_accounts` | resolved |
| `p_usage_id` | `ai_usage` | resolved |
| `p_company_id` (2nd position) | — | **claimed**: assert on the parameter directly |

**Every guard is NULL-tolerant from the start this time** —
`if <param> is not null then perform ... end if` — because most of these are
genuinely optional. `p_branch_id` on `raise_alert`, `p_site_id` on
`change_client`, `p_approval_request_id` on `fund_region` are all routinely
NULL, and 0242's omission of this check is what broke every expense insert.

---

## 4. Exemptions, with recorded verdicts

**Polymorphic — cannot be resolved mechanically:**

* `post_journal.p_source_id`, `reverse_journal_for_source.p_source_id` — the
  table is `p_source_table`, a text parameter. Resolving needs a per-source-table
  lookup, the same shape `is_action_approved` needs.
* `raise_alert.p_ref_id`, `request_approval.p_ref_id` — paired with
  `p_ref_table`, same reason.

These get a comment stating the omission is deliberate and why, exactly as
`is_action_approved` did. Not silent.

**Already covered by a hand-written check in the function's own body — do NOT
double-guard:**

| function | parameter | existing check |
|---|---|---|
| `assign_employee_code` | `p_client_id` | `from clients where id = p_client_id and company_id = v_company_id` |
| `record_invoice_payment` | `p_bank_account_id` | `perform 1 from bank_accounts where id = p_bank_account_id and company_id = v_company` |
| `post_manual_journal` | `p_credit_account_id` | validates **both** accounts: `where id in (p_debit_account_id, p_credit_account_id) and company_id = v_company having count(*) = 2` |
| `same_company_branch` | `p_branch_id` | `exists (select 1 from branches where id = p_branch_id and company_id = p_company_id)` — this function **is** the branch validator |

Four of the 34 are already safe. Adding a second guard would be harmless but
would duplicate a check in a different style, and `same_company_branch` is the
helper the `p_branch_id` guards should arguably delegate to.

**Net to change: 30 parameters across 25 functions**, minus the four
polymorphic exemptions = **26 new guards.**

---

## 5. Verification the migration must carry

Not the generation — the property.

1. `tenant_guard_gaps()` extended to flag **any** tenant-scoped uuid parameter
   without a guard, not just the first. That check is what makes this hold for
   the next function somebody writes, and it is currently blind to exactly this
   defect.
2. **Positive control per changed function**: the legitimate call still works
   with its own ids, and with NULL in every optional position. This is the
   control that caught the `xmin` bug and the NULL regression, and it is the one
   a refusal-only suite would skip.
3. **Negative control per changed parameter**: own id in the guarded position,
   foreign id in the newly guarded one, must raise `Row not found`. Testing the
   guarded position alone would pass without the change.
4. Break test: remove one new guard, confirm red, restore.

---

## 6. What I have not resolved

* Whether `p_lender`/`p_borrower` on `fund_region` should additionally be
  required to *differ* from each other, and whether an inter-region loan between
  two regions of the same company is the only legal shape. That is an accounting
  question, not a security one, and it is adjacent to A9.
* Whether the `p_branch_id` guards should call `same_company_branch` rather than
  inline the lookup. Cleaner, one more function call per guard, and it makes the
  branch rule live in one place. Recommend yes; not assumed.

**Awaiting approval of the map before implementing.**
