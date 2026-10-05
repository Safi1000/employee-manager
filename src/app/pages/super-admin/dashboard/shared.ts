// The dashboard's data, computed once in Dashboard.tsx and handed to whichever
// design is selected. Designs only present — none of them fetches or derives a
// figure the other designs would not also show, so switching design can never
// change a number, only how it is drawn.

import type { FeedItem } from "../../../components/ActivityFeed";

export type BankRow = { id: string; bank_name: string; balance: number };
export type TopClientRow = { id: string; name: string; revenue: number };
export type AttendancePoint = { date: string; label: string; present: number; absent: number; leave: number };
// One row of the compliance alerts panel, straight off compliance_upcoming.
// days_remaining is SIGNED and computed by the view — negative is overdue. It
// is never clamped at zero here: the panel used to render Math.max(0, …), so an
// item three weeks late displayed as "today". See TENANT_GUARD_REPORT.md 9.11.
export type AlertRow = {
  id: string;
  title: string;
  due_date: string;
  category: string;
  priority: string;
  days_remaining: number;
};
export type ExpensePieRow = { name: string; value: number };
export type ContractEndingRow = { id: string; code: string; client_name: string; end_date: string; days_left: number };
export type IncidentRow = { id: string; code: string; severity: string; category: string; occurred_at: string; status: string };
export type RecentPaymentRow = { id: string; client_name: string; amount: number; payment_date: string };

export type DashCan = {
  compliance: boolean;
  employees: boolean;
  attendance: boolean;
  expenses: boolean;
  payroll: boolean;
  accounting: boolean;
  reports: boolean;
  contracts: boolean;
  roster: boolean;
  incidents: boolean;
  coa: boolean;
  periodClose: boolean;
};

export type DashData = {
  can: DashCan;
  /** false when the company has hidden that widget in Settings. */
  show: (key: string) => boolean;
  nothingToShow: boolean;
  branchScopeNote: string | null;
  companyName: string;
  userName: string;

  employeeCount: number;
  attendanceTodayPct: number;
  attendanceYesterdayPct: number;
  expensesMtd: number;
  expensesPrev: number;
  payrollMtd: number;
  payrollPrev: number;
  banks: BankRow[];
  totalBankBalance: number;
  topClients: TopClientRow[];
  attendanceTrend: AttendancePoint[];
  alerts: AlertRow[];
  activeContracts: number;
  openIncidents: number;
  licencesExpiring: number;
  licencesOverdue: number;
  expensesPie: ExpensePieRow[];
  contractsEnding: ContractEndingRow[];
  recentIncidents: IncidentRow[];
  recentPayments: RecentPaymentRow[];
  periodClosedThisMonth: boolean | null;
  lastClosedMonth: string | null;
  feedItems: FeedItem[];
};

export const currency = (n: number) => `PKR ${Math.round(n).toLocaleString("en-PK")}`;
export const compact = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `PKR ${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `PKR ${(n / 1_000).toFixed(0)}K`;
  return `PKR ${Math.round(n).toLocaleString("en-PK")}`;
};
/** compact() without the currency prefix, for designs that set PKR apart. */
export const short = (n: number) => compact(n).replace(/^PKR /, "");

export const monthLabel = (offset: number) => {
  const d = new Date();
  const x = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return x.toLocaleDateString(undefined, { month: "short", year: "numeric" });
};

export const deltaLabel = (curr: number, prev: number): { value: string; positive: boolean } => {
  if (prev === 0 && curr === 0) return { value: "no change", positive: true };
  if (prev === 0) return { value: "new this month", positive: true };
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  const sign = pct >= 0 ? "+" : "";
  return { value: `${sign}${pct.toFixed(0)}% vs ${monthLabel(-1)}`, positive: pct >= 0 };
};

/** Signed percent change, or null when there is no prior figure to compare to. */
export const pctChange = (curr: number, prev: number): number | null =>
  prev === 0 ? null : ((curr - prev) / Math.abs(prev)) * 100;

export const daysLabel = (d: number) =>
  d < 0 ? `${Math.abs(d)}d overdue` : d === 0 ? "today" : `${d}d`;

export const humanize = (s: string) => s.replace(/_/g, " ");

export const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

/**
 * Loads a Google Fonts stylesheet once per page. Designs bring their own type;
 * this keeps those fonts off every other page of the app.
 */
export function ensureFont(id: string, href: string) {
  if (typeof document === "undefined" || document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}
