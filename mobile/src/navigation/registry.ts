// Every route of the web app's routes.tsx, with its gate. Drives the Menu tab,
// the route Gates, and which bottom tabs a user sees. Items flagged `hiddenOnWeb`
// are route-only on web (not in the sidebar); on the phone they live in the menu
// under their group so no page is unreachable.
import {
  Activity, AlertTriangle, Archive, BadgeCheck, Banknote, BarChart3, Bell, BookOpen, Briefcase, Building2, CalendarCheck,
  CalendarClock, ClipboardList, CreditCard, FileSignature, FileText, FolderOpen, Gauge, Handshake, History, Landmark, LayoutDashboard,
  ListChecks, LucideIcon, Map, NotebookPen, PiggyBank, Receipt, Scale, ScrollText, Settings, ShieldCheck, ShieldAlert, Sparkles,
  UserCircle, UserCog, Users, Wallet, Workflow,
} from "lucide-react-native";

export type NavItem = {
  href: string;
  title: string;
  group: string;
  icon: LucideIcon;
  perms?: string[];
  roles?: string[];
  hiddenOnWeb?: boolean;
  needsEmployeeLink?: boolean;
  blurb: string;
};

export const NAV: NavItem[] = [
  { href: "/", title: "Dashboard", group: "Overview", icon: LayoutDashboard, blurb: "Today at a glance" },
  { href: "/tasks", title: "Tasks", group: "Overview", icon: ListChecks, blurb: "Board & checklist" },
  { href: "/my-profile", title: "My Profile", group: "Me", icon: UserCircle, needsEmployeeLink: true, blurb: "Pay, attendance, documents" },

  { href: "/clients", title: "Clients", group: "Clients & Contracts", icon: Building2, perms: ["clients.view", "clients.edit"], blurb: "Client master records" },
  { href: "/contracts", title: "Contracts", group: "Clients & Contracts", icon: FileSignature, perms: ["contracts.view", "contracts.edit"], blurb: "Lines, addendums, renewals" },
  { href: "/invoices", title: "Invoices", group: "Clients & Contracts", icon: Receipt, perms: ["invoices.view", "invoices.edit"], blurb: "Ledger, payments, generate" },

  { href: "/employees", title: "Employees", group: "Workforce", icon: Users, perms: ["employees.view", "employees.edit"], blurb: "Roster, hire & fire" },
  { href: "/assignments", title: "Assignments & Pay", group: "Workforce", icon: Workflow, perms: ["assignments.view", "employees.edit"], blurb: "Postings by client" },
  { href: "/attendance", title: "Attendance", group: "Workforce", icon: CalendarCheck, perms: ["attendance.view", "attendance.edit"], blurb: "Daily board & vacancies" },
  { href: "/payroll", title: "Payroll", group: "Workforce", icon: Wallet, perms: ["payroll.view", "payroll.edit", "payroll.adjust"], blurb: "Payslips, adjustments, leave" },
  { href: "/payroll-run", title: "Payroll Run", group: "Workforce", icon: BadgeCheck, perms: ["payroll.view", "payroll.edit"], blurb: "Draft → Review → Finance" },
  { href: "/relievers", title: "Relievers", group: "Workforce", icon: Sparkles, perms: ["attendance.view", "attendance.edit"], blurb: "Reliever day marking" },
  { href: "/performance", title: "Performance", group: "Workforce", icon: Gauge, perms: ["payroll.view", "performance.approve"], hiddenOnWeb: true, blurb: "KPIs & appraisals" },

  { href: "/daily-reports", title: "Daily Reports", group: "Operations", icon: NotebookPen, perms: ["roster.view", "roster.edit", "incidents.view", "attendance.view"], blurb: "One note per client per day" },
  { href: "/incidents", title: "Incidents", group: "Operations", icon: ShieldAlert, perms: ["incidents.view", "incidents.edit"], blurb: "Incidents & complaints" },
  { href: "/assets", title: "Assets & Issuance", group: "Operations", icon: Archive, perms: ["inventory.view", "inventory.edit", "banks.view"], blurb: "Store, issuance, clearance" },

  { href: "/accounting", title: "Banks & Ledgers", group: "Finance", icon: Landmark, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"], blurb: "Receivables, payables, banks, cash" },
  { href: "/accounting-core", title: "Accounting Core", group: "Finance", icon: BookOpen, perms: ["coa.view"], blurb: "COA, trial balance, journal" },
  { href: "/expenses", title: "Expenses & Advances", group: "Finance", icon: CreditCard, perms: ["expenses.view", "expenses.edit"], blurb: "Spend, fixed, advances" },
  { href: "/reports", title: "Financial Reports", group: "Finance", icon: BarChart3, perms: ["reports.view"], blurb: "P&L, regional, statements" },
  { href: "/partnership-report", title: "Partnership Report", group: "Finance", icon: Handshake, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"], blurb: "Profit shares" },
  { href: "/partnership-run", title: "Partnership Run", group: "Finance", icon: Scale, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"], blurb: "Monthly partner posting" },
  { href: "/period-close", title: "Period Close", group: "Finance", icon: CalendarClock, perms: ["period_close.manage"], blurb: "Close & reopen months" },
  { href: "/cashflow", title: "Cash Flow", group: "Finance", icon: Banknote, perms: ["cashflow.view"], hiddenOnWeb: true, blurb: "Cash-basis view" },
  { href: "/treasury", title: "Treasury", group: "Finance", icon: PiggyBank, perms: ["banks.view", "reports.view", "cashflow.view"], hiddenOnWeb: true, blurb: "Forecast & reserves" },
  { href: "/regional-scorecard", title: "Regional Scorecard", group: "Finance", icon: Map, perms: ["reports.view", "banks.view"], hiddenOnWeb: true, blurb: "Regional operating spend" },
  { href: "/partners", title: "Partner Accounts", group: "Finance", icon: Briefcase, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"], hiddenOnWeb: true, blurb: "Partner ledgers" },
  { href: "/project-financing", title: "Project Financing", group: "Finance", icon: Activity, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"], hiddenOnWeb: true, blurb: "Investor-funded projects" },

  { href: "/compliance", title: "Compliance Calendar", group: "Compliance", icon: CalendarClock, perms: ["compliance.view", "compliance.edit"], blurb: "Dates, licences, renewals" },
  { href: "/compliance-cases", title: "Compliance Cases", group: "Compliance", icon: ScrollText, perms: ["compliance.view", "compliance.edit"], hiddenOnWeb: true, blurb: "Cases & filings" },
  { href: "/documents", title: "Documents", group: "Compliance", icon: FolderOpen, perms: ["documents.view", "documents.edit"], hiddenOnWeb: true, blurb: "Employee files" },
  { href: "/alerts", title: "Alerts", group: "Compliance", icon: Bell, hiddenOnWeb: true, blurb: "Open & live warnings" },

  { href: "/access-governance", title: "Access & Governance", group: "Admin", icon: UserCog, roles: ["super_admin"], blurb: "Users & approvals" },
  { href: "/audit-log", title: "Audit Log", group: "Admin", icon: History, roles: ["super_admin"], blurb: "Who changed what" },
  { href: "/settings", title: "Settings", group: "Admin", icon: Settings, perms: ["settings.view", "settings.edit"], blurb: "Company, regions, appearance" },
  { href: "/billing", title: "Plan & Billing", group: "Admin", icon: FileText, perms: ["settings.view", "settings.edit"], blurb: "Plan & AI credit" },

  { href: "/companies", title: "Companies", group: "Platform", icon: ShieldCheck, roles: ["super_super_admin"], blurb: "Tenants & subscriptions" },
];

export const GROUP_ORDER = ["Overview", "Me", "Clients & Contracts", "Workforce", "Operations", "Finance", "Compliance", "Admin", "Platform"];

export const navFor = (href: string) => NAV.find((n) => n.href === href)!;

export { AlertTriangle, ClipboardList };
