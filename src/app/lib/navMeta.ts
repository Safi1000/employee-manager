/**
 * Which sidebar section a route belongs to, for the kicker line in each page's
 * band ("FINANCE · GUARDS AND GUIDES"). Keyed by the first path segment after
 * the role prefix (/app/<key>/…). Mirrors the groups SuperAdminLayout
 * builds; a route missing here simply shows the company name alone.
 */
const SECTION_OF: Record<string, string> = {
  "": "Overview",
  tasks: "Overview",
  alerts: "Overview",
  "my-profile": "Me",

  clients: "Clients & Contracts",
  contracts: "Clients & Contracts",
  invoices: "Clients & Contracts",
  "sites-strength": "Clients & Contracts",
  "client-relationships": "Clients & Contracts",

  employees: "Workforce",
  assignments: "Workforce",
  attendance: "Workforce",
  "attendance-run": "Workforce",
  payroll: "Workforce",
  "payroll-run": "Workforce",
  performance: "Workforce",
  relievers: "Workforce",

  "daily-reports": "Operations",
  incidents: "Operations",
  "assets-issuance": "Operations",

  accounting: "Finance",
  "accounting-core": "Finance",
  expenses: "Finance",
  reports: "Finance",
  accountant: "Finance",
  "partnership": "Finance",
  "partnership-report": "Finance",
  "partnership-run": "Finance",
  "period-close": "Finance",
  cashflow: "Finance",
  treasury: "Finance",
  partners: "Finance",
  "project-financing": "Finance",
  "regional-scorecard": "Finance",

  compliance: "Compliance",
  "compliance-cases": "Compliance",
  documents: "Compliance",

  "access-governance": "Admin",
  "audit-log": "Admin",
  reversals: "Admin",
  settings: "Admin",
  billing: "Admin",
};

export function sectionOf(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "super-super-admin") return parts[1] === "companies" ? "Companies" : "Platform";
  const key = parts[1] ?? "";
  return SECTION_OF[key] ?? null;
}

/**
 * Pages whose figures belong to the company as a whole, so the region bar
 * does not change them: month locks, the audit trail, partner and investor
 * accounts, access, settings, the accountant's bank and cash ledgers. The top
 * bar says so on these pages instead of promising "ISB/RWP only".
 */
const COMPANY_WIDE = new Set([
  "tasks", "accountant", "partnership", "partnership-run", "period-close", "treasury", "partners",
  "project-financing", "access-governance", "users", "governance", "audit-log",
  "reversals", "settings", "billing", "my-profile",
]);

export function isCompanyWide(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "super-admin" && COMPANY_WIDE.has(parts[1] ?? "");
}
