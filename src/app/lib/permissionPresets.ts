import { PERMISSION_GROUPS } from "./supabase";

/**
 * PERMISSION PRESETS (3 Nov 2026, Shayan: "select some already set permissions
 * like accountant can view and edit majority things other than approval of
 * payroll run and expenses … still editable").
 *
 * A preset only fills the ticks; what is saved is the list of keys, exactly as
 * before — nothing in the database knows a preset existed, so editing after
 * applying one is free, and changing a preset here never changes anyone's
 * access. Every key below must exist in PERMISSION_GROUPS (checked at load).
 *
 * APPROVALS are the keys that sign something off — the second pair of eyes.
 * No preset except CEO carries them; they are granted one by one, on purpose.
 */
export const APPROVAL_KEYS = new Set([
  "payroll.approve", "expenses.approve", "employees.finance_approve", "employees.ops_verify", "attendance.ops_verify",
  "receivables.write_off_approve", "period_close.manage", "partnership.post", "reversals.execute", "users.manage",
  "field.money_approve", "warnings.approve", "performance.approve", "clearance.finance",
]);

const ALL = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));
const viewOnly = ALL.filter((k) => /\.(view|run_view)$/.test(k));

export type Preset = { key: string; label: string; what: string; keys: string[] };

export const PRESETS: Preset[] = [
  {
    key: "accountant", label: "Accountant",
    what: "Views and edits money — invoices, receipts, expenses, banks, payroll figures, the books and reports. No approvals.",
    keys: [
      "invoices.view", "invoices.edit", "receivables.view", "receivables.follow_up", "payables.view", "banks.view", "accounting.edit",
      "expenses.view", "expenses.edit", "payroll.view", "payroll.edit", "payroll.adjust", "assignments.view", "assignments.accounts",
      "reports.view", "accountant.view", "planning.view", "planning.edit", "cashflow.view", "coa.view",
      "clients.view", "contracts.view", "employees.view", "attendance.view", "attendance.run_view", "inventory.view", "compliance.view", "compliance.filings", "audit_log.view",
    ],
  },
  {
    key: "finance_manager", label: "Finance manager",
    what: "Everything the accountant has, plus approving expenses, payroll and write-offs, and closing a month.",
    keys: [] as string[], // filled below from accountant + approvals
  },
  {
    key: "hr_officer", label: "HR officer",
    what: "Employees, attendance marking, leave and documents. No pay figures, no approvals.",
    keys: [
      "employees.view", "employees.edit", "attendance.view", "attendance.edit", "attendance.bulk_mark", "attendance.hr_verify", "attendance.run_view",
      "assignments.view", "assignments.hr", "documents.view", "documents.edit", "compliance.view", "inventory.view", "clients.view", "contracts.view",
    ],
  },
  {
    key: "hr_manager", label: "HR manager",
    what: "HR officer plus warnings, backdating attendance, field-app reviews and employee updates.",
    keys: [] as string[], // filled below
  },
  {
    key: "ops_manager", label: "Operations manager",
    what: "Daily reports, incidents, attendance, field app and payment follow-up (no figures). Verifies attendance for Ops.",
    keys: [
      "roster.view", "roster.edit", "incidents.view", "incidents.edit", "attendance.view", "attendance.run_view", "attendance.ops_verify", "attendance.field_review",
      "employees.view", "clients.view", "contracts.view", "receivables.follow_up", "inventory.view", "clearance.ops", "compliance.view",
    ],
  },
  {
    key: "followup", label: "Payment follow-up (ops)",
    what: "Only the follow-up list — who to chase and what they said. No amounts.",
    keys: ["receivables.follow_up"],
  },
  {
    key: "ceo", label: "CEO",
    what: "Sees everything, the CEO dashboard included, and holds the main approvals. Not user management.",
    keys: [] as string[], // filled below
  },
  {
    key: "viewer", label: "Viewer (read-only)",
    what: "Can open every screen it is allowed to see and change nothing.",
    keys: viewOnly,
  },
];

const by = (k: string) => PRESETS.find((p) => p.key === k)!;
by("finance_manager").keys = [...by("accountant").keys, "expenses.approve", "payroll.approve", "receivables.write_off_approve", "period_close.manage", "clearance.finance", "employees.finance_approve"];
by("hr_manager").keys = [...by("hr_officer").keys, "attendance.backdate", "warnings.approve", "attendance.field_review", "field.employees"];
by("ceo").keys = [...viewOnly, "dashboard.ceo", "payroll.approve", "expenses.approve", "receivables.write_off_approve", "partnership.post", "employees.finance_approve"];

// A key a preset names but the grant screen doesn't offer would be silently dropped — refuse loudly in development.
for (const p of PRESETS) {
  p.keys = [...new Set(p.keys)];
  const missing = p.keys.filter((k) => !ALL.includes(k));
  if (missing.length && import.meta.env.DEV) console.error(`Preset ${p.label} names unknown permission keys: ${missing.join(", ")}`);
  p.keys = p.keys.filter((k) => ALL.includes(k));
}

/** Which preset these ticks came from, and how far they've moved: added/removed against the closest preset. */
export function nearestPreset(selected: Set<string>): { preset: Preset; added: number; removed: number } | null {
  let best: { preset: Preset; added: number; removed: number } | null = null;
  for (const p of PRESETS) {
    const set = new Set(p.keys);
    const added = [...selected].filter((k) => !set.has(k)).length;
    const removed = p.keys.filter((k) => !selected.has(k)).length;
    if (!best || added + removed < best.added + best.removed) best = { preset: p, added, removed };
  }
  return best && best.added + best.removed < Math.max(6, best.preset.keys.length / 3) ? best : null;
}
