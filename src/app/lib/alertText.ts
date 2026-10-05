// Plain-English wording for rows of public.alerts.
//
// The alert engine writes machine identifiers into its rows — the category
// (`ledger_check_failed`) and, for ledger checks, the check's own name inside
// the message ("Ledger check no_stale_prepaid_balance is failing: expected 0,
// actual 1 (difference 1)"). Those names are stable keys, which is why the
// database keeps them; they are not something a person should have to read.
// This file is the only place that translates them, so the Compliance Calendar
// and the Alerts page say the same thing.
//
// A check missing from CHECK_TEXT still renders — `humanize` turns its name into
// words — so a check added tomorrow is readable before anyone edits this file.

type CheckText = {
  /** What the check confirms, phrased as the healthy state. */
  title: string;
  /** What a failure means, and where to look. */
  help: string;
  /** How the expected/actual figures are read. Default: inferred. */
  unit?: "count" | "money";
};

const CHECK_TEXT: Record<string, CheckText> = {
  alert_delivery_is_healthy: {
    title: "Alert emails are being delivered",
    help: "The daily alert email failed or did not go out. Alerts are still shown here.",
    unit: "count",
  },
  ar_control_equals_open_invoices: {
    title: "Receivables in the ledger match open invoices",
    help: "The amount clients owe in the books differs from the total of unpaid invoices.",
    unit: "money",
  },
  bank_accounts_equal_transaction_deltas: {
    title: "Bank balances match their transaction history",
    help: "A bank account's balance differs from the sum of its recorded transactions.",
    unit: "money",
  },
  bank_control_equals_bank_accounts: {
    title: "Bank total in the ledger matches the bank accounts",
    help: "The bank figure in the books differs from the balances held on the bank accounts.",
    unit: "money",
  },
  bank_per_account_gl_equals_operational: {
    title: "Each bank account matches its ledger account",
    help: "One or more bank accounts disagree with their own account in the books.",
    unit: "count",
  },
  billing_periods_are_contiguous: {
    title: "Invoices cover every month without gaps or overlaps",
    help: "A contract has a month that was billed twice or skipped.",
    unit: "count",
  },
  cash_control_equals_cash_locations: {
    title: "Cash total in the ledger matches cash on hand",
    help: "The cash figure in the books differs from the balances held at cash locations.",
    unit: "money",
  },
  cash_control_has_no_direct_postings: {
    title: "No manual entries posted straight to the cash total",
    help: "Something was posted directly to the cash control account instead of a cash location.",
    unit: "count",
  },
  cash_entitlements_equal_pool: {
    title: "Partner cash entitlements add up to the pool",
    help: "The partners' shares do not add up to the cash pool being divided.",
    unit: "money",
  },
  cash_forecast_clears_the_floor: {
    title: "Cash forecast stays above the minimum balance",
    help: "Projected cash falls below the minimum the business should hold.",
    unit: "count",
  },
  cash_per_location_gl_equals_operational: {
    title: "Each cash location matches its ledger account",
    help: "One or more cash locations disagree with their own account in the books.",
    unit: "count",
  },
  cash_pl_agrees_with_partnership: {
    title: "Cash profit agrees with the partnership figures",
    help: "Profit on the cash basis differs from the figure used for the partnership split.",
    unit: "count",
  },
  checks_evaluated: {
    title: "All ledger checks ran",
    help: "Fewer checks ran than expected, so some results may be missing.",
    unit: "count",
  },
  client_cost_has_an_invoice: {
    title: "Every client with costs has been invoiced",
    help: "A client had guards or costs in a month but no invoice was raised for it.",
    unit: "count",
  },
  employee_advances_control_not_in_client_ar: {
    title: "Employee advances are kept out of client receivables",
    help: "Staff advances have been mixed into the amounts clients owe.",
    unit: "count",
  },
  every_control_is_invoked: {
    title: "Every built-in safety check is in use",
    help: "Some system safeguards exist but are not being run. Technical — pass to the developer.",
    unit: "count",
  },
  every_demanded_permission_is_grantable: {
    title: "Every required permission can be granted",
    help: "A screen asks for a permission that the Roles screen cannot give anyone. Technical — pass to the developer.",
    unit: "count",
  },
  every_source_row_posted: {
    title: "Every transaction has reached the ledger",
    help: "Some invoices, payments or expenses were recorded but not posted to the books.",
    unit: "count",
  },
  migration_ledger_matches_repo: {
    title: "Database changes match the application code",
    help: "The database and the code disagree about which updates have been applied. Technical — pass to the developer.",
    unit: "count",
  },
  monthly_ledger_run_is_current: {
    title: "Monthly ledger run is up to date",
    help: "Last month's ledger run has not been completed yet.",
    unit: "count",
  },
  no_adjustment_quietly_stops_existing: {
    title: "No recurring adjustment disappeared without a record",
    help: "A recurring pay adjustment stopped without anyone ending it.",
    unit: "count",
  },
  no_billing_clients_on_head_office: {
    title: "No billing client is assigned to Head Office",
    help: "A paying client is filed under Head Office instead of a region.",
    unit: "count",
  },
  no_definer_function_crosses_a_branch: {
    title: "System functions respect branch boundaries",
    help: "Some functions could reach data outside the user's branch. Technical — pass to the developer.",
    unit: "count",
  },
  no_empty_journal_entries: {
    title: "No empty journal entries",
    help: "A journal entry exists with no lines on it.",
    unit: "count",
  },
  no_gate_mode_in_attendance_status: {
    title: "Attendance records use valid statuses",
    help: "Some attendance records hold an old or invalid status value and need correcting.",
    unit: "count",
  },
  no_invoice_time_withholding: {
    title: "Tax is not withheld when an invoice is raised",
    help: "Withholding tax was booked at invoice time instead of when payment was received.",
    unit: "count",
  },
  no_invoker_writes_an_owner_only_table: {
    title: "Protected tables are only changed through approved routes",
    help: "Technical — pass to the developer.",
    unit: "count",
  },
  no_negative_custodian_balance: {
    title: "No cash custodian holds a negative balance",
    help: "A person holding company cash shows less than zero. A payment or deposit is likely missing.",
    unit: "count",
  },
  no_one_sided_entries: {
    title: "Every journal entry balances",
    help: "A journal entry has debits without matching credits, or the other way round.",
    unit: "count",
  },
  no_posting_into_a_closed_period: {
    title: "Nothing posted into a closed month",
    help: "An entry was dated inside a month that has already been closed.",
    unit: "count",
  },
  no_stale_prepaid_balance: {
    title: "Prepaid expenses are being released on time",
    help: "A prepaid expense still has a balance after its coverage period ended.",
    unit: "count",
  },
  payroll_accrual_matches_attendance: {
    title: "Payroll matches attendance",
    help: "Salary costs booked for some guards do not match the days they were marked present.",
    unit: "count",
  },
  profit_allocation_exhausts_pool: {
    title: "Profit allocation uses the whole pool",
    help: "Part of the profit pool was left unallocated, or more than the pool was handed out.",
    unit: "money",
  },
  revenue_recognised_in_service_month: {
    title: "Revenue is booked in the month the service was given",
    help: "Some invoice revenue was booked in the invoice month instead of the service month.",
    unit: "count",
  },
  salaries_payable_equals_undisbursed_net_pay: {
    title: "Salaries owed match unpaid net pay",
    help: "The salaries-payable balance in the books differs from net pay not yet disbursed.",
    unit: "money",
  },
  system_control_accounts_are_top_level: {
    title: "System accounts sit at the top of the chart of accounts",
    help: "A system control account was moved under another account.",
    unit: "count",
  },
  tenant_guard_covers_every_parameter: {
    title: "Company data stays separated",
    help: "Some functions do not check which company the data belongs to. Technical — pass to the developer.",
    unit: "count",
  },
  total_due_not_read_as_a_balance: {
    title: "Invoice totals are not used as balances",
    help: "Technical — pass to the developer.",
    unit: "count",
  },
  trial_balance_debits_equal_credits: {
    title: "Trial balance debits equal credits",
    help: "The books do not balance.",
    unit: "money",
  },
  wht_receivable_equals_deductions_less_cprs: {
    title: "Withholding tax receivable matches deductions",
    help: "Tax withheld by clients, less certificates received (CPRs), differs from the balance in the books.",
    unit: "money",
  },
};

const CATEGORY_TEXT: Record<string, string> = {
  ledger_check_failed: "Accounts check",
  danger_level_disbursement: "Low-cash payment",
};

const TIER_TEXT: Record<string, string> = {
  blocking: "Blocking",
  warning: "Warning",
  dashboard: "Info",
};

/** Abbreviations that should stay upper-case when a name is turned into words. */
const ACRONYMS: Record<string, string> = {
  gl: "GL",
  ar: "AR",
  ap: "AP",
  pl: "P&L",
  wht: "WHT",
  cprs: "CPRs",
  eobi: "EOBI",
  cnic: "CNIC",
  nadra: "NADRA",
  ho: "HO",
  coo: "COO",
};

/** `no_stale_prepaid_balance` → "No stale prepaid balance". */
export function humanize(id: string): string {
  const words = String(id)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.toLowerCase());
  if (words.length === 0) return "";
  const first = words[0];
  words[0] = first === first.toUpperCase() ? first : first[0].toUpperCase() + first.slice(1);
  return words.join(" ");
}

export const alertCategoryLabel = (category: string) =>
  CATEGORY_TEXT[category] ?? humanize(category);

export const alertTierLabel = (tier: string) => TIER_TEXT[tier] ?? humanize(tier);

const money = (n: number) =>
  `PKR ${n.toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const LEDGER_RE =
  /^Ledger check (\w+) is failing: expected (-?[\d.]+), actual (-?[\d.]+) \(difference (-?[\d.]+)\)/;

export type AlertText = {
  /** One line a person can read. */
  title: string;
  /** What it means / what to do. Empty when the message already says it. */
  detail: string;
  /** The figures, in words. Empty when there are none. */
  figures: string;
};

/**
 * Turn an alert row's message into readable text. Messages that are not in a
 * known machine format come back unchanged, with any snake_case identifier
 * inside them replaced by words.
 */
export function describeAlert(a: { category: string; message: string }): AlertText {
  const m = LEDGER_RE.exec(a.message ?? "");
  if (m) {
    const [, name, expS, actS, diffS] = m;
    const known = CHECK_TEXT[name];
    const expected = Number(expS);
    const actual = Number(actS);
    const diff = Number(diffS);
    // A count check expects zero and reports how many rows break the rule. A
    // money check compares two balances; decimals or a non-zero expectation
    // give it away when the dictionary does not say.
    const unit =
      known?.unit ??
      (expected === 0 && Number.isInteger(actual) && !expS.includes(".") ? "count" : "money");
    let figures: string;
    if (unit === "count" && expected === 0) {
      figures = `${actual} item${actual === 1 ? "" : "s"} need${actual === 1 ? "s" : ""} attention`;
    } else if (unit === "count") {
      figures = `Expected ${expected}, found ${actual}`;
    } else {
      figures = `Expected ${money(expected)}, found ${money(actual)} — off by ${money(Math.abs(diff))}`;
    }
    return {
      title: known ? `Failing: ${known.title}` : `Failing check: ${humanize(name)}`,
      detail: known?.help ?? "",
      figures,
    };
  }
  const text = (a.message ?? "").replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, (id) => {
    if (CHECK_TEXT[id]) return CHECK_TEXT[id].title;
    const h = humanize(id);
    // Mid-sentence, so drop the leading capital unless it is an acronym.
    return /^[A-Z&]{2,}\b/.test(h) ? h : h[0].toLowerCase() + h.slice(1);
  });
  return { title: text, detail: "", figures: "" };
}
