/**
 * Which sidebar section a route belongs to, for the kicker line in each page's
 * band ("FINANCE · GUARDS AND GUIDES"). Keyed by the first path segment after
 * the role prefix (/super-admin/<key>/…). Mirrors the groups SuperAdminLayout
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
