import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import Header from "../../components/Header";
import Tabs from "../../components/Tabs";
import FinanceReport from "../../components/FinanceReport";
import StaffChangesPanel from "../../components/StaffChangesPanel";
import PaymentFollowUp from "../../components/PaymentFollowUp";
import ClientReceivables from "../../components/ClientReceivables";
import PeopleActivity, { SPANS, spanStart, type Span } from "../../components/PeopleActivity";
import { hasAnyPermission, useAuth } from "../../lib/auth";
import { usePageState } from "../../lib/pageState";
import { useRegion } from "../../lib/region";
import { loadStaffChanges, staffForRegion, type StaffChanges } from "../../lib/staffChanges";

/**
 * CEO DASHBOARD (0632, DECIDED 2 Nov 2026; key dashboard.ceo). Every report,
 * live, in one place, and what each person with a login did. It reads what the
 * report screens read and adds nothing of its own; viewing here never moves
 * the start of anybody's next report — only exporting from the report's own
 * screen does.
 */
type Tab = "reports" | "finance" | "staff" | "followup" | "receivables" | "people";

// Each report screen with the keys its route asks, so the overview links only
// to what this login can open.
const REPORT_LINKS: { to: string; label: string; what: string; perms: string[] }[] = [
  { to: "/app/daily-reports", label: "Daily Operations Report", what: "Each client's note for the day, tasks, and the previous day's attendance", perms: ["roster.view", "roster.edit", "incidents.view", "attendance.view"] },
  { to: "/app/daily-reports", label: "Attendance Report", what: "Attendance by client, gaps explained by HR, and staff changes since the last report", perms: ["attendance.view", "roster.view"] },
  { to: "/app/finance-report", label: "Finance Report", what: "Received, invoiced, spent, salaries, receivables and what is waiting — since the last report", perms: ["reports.view", "invoices.view", "invoices.edit", "receivables.view", "accounting.edit", "dashboard.ceo"] },
  { to: "/app/payment-follow-up", label: "Payment Follow-up", what: "Who to chase, what they said and the next step", perms: ["receivables.follow_up", "invoices.view", "invoices.edit", "receivables.view", "accounting.edit"] },
  { to: "/app/invoices", label: "Invoices", what: "Delivered or not, made by hand or generated, and clients with no invoice", perms: ["invoices.view", "invoices.edit"] },
  { to: "/app/reports", label: "Financial Reports", what: "Profit and loss, balance sheet, cash flow", perms: ["reports.view"] },
  { to: "/app/accountant", label: "Accountant", what: "Every account from the ledger, and the checks", perms: ["accountant.view"] },
];

export default function CeoDashboard() {
  const { profile } = useAuth();
  const { regionId } = useRegion();
  const [tab, setTab] = usePageState<Tab>("CeoDashboard.tab", "reports");
  const [span, setSpan] = usePageState<Span>("CeoDashboard.span", "7d");
  const [staff, setStaff] = useState<StaffChanges | null>(null);
  useEffect(() => { if (tab === "staff") void loadStaffChanges(spanStart(span)).then(setStaff); }, [tab, span]);

  const canFollowUp = hasAnyPermission(profile, ["receivables.follow_up", "invoices.view", "invoices.edit", "receivables.view", "accounting.edit"]);
  const canReceivables = hasAnyPermission(profile, ["invoices.view", "invoices.edit", "receivables.view", "accounting.edit"]);
  const items = [
    { value: "reports" as Tab, label: "Reports" },
    { value: "finance" as Tab, label: "Finance" },
    { value: "staff" as Tab, label: "Staff changes" },
    ...(canFollowUp ? [{ value: "followup" as Tab, label: "Follow-up" }] : []),
    ...(canReceivables ? [{ value: "receivables" as Tab, label: "Receivables" }] : []),
    { value: "people" as Tab, label: "People" },
  ];
  const spanPicker = (
    <Tabs size="sm" items={SPANS.map(([v, label]) => ({ value: v, label }))} value={span} onChange={setSpan} />
  );

  return (
    <>
      <Header title="CEO Dashboard" subtitle="Every report, live, and what each person did — read from what is already in Bastion" />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4">
        <Tabs items={items} value={items.some((i) => i.value === tab) ? tab : "reports"} onChange={setTab} />

        {tab === "reports" && (
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {REPORT_LINKS.filter((r) => hasAnyPermission(profile, r.perms)).map((r) => (
              <Link key={r.label} to={r.to} className="group border border-border rounded-xl bg-card px-4 py-3 hover:border-brand-500">
                <div className="flex items-center gap-2 font-semibold text-foreground">{r.label}<ArrowRight className="w-4 h-4 ml-auto text-muted-foreground group-hover:text-brand-500" /></div>
                <p className="text-sm text-muted-foreground mt-0.5">{r.what}</p>
              </Link>
            ))}
          </div>
        )}

        {tab === "finance" && <FinanceReport readOnly />}

        {tab === "staff" && (
          <div className="space-y-3">
            {spanPicker}
            {staff ? <StaffChangesPanel data={staffForRegion(staff, regionId)} title={`Staff changes — ${SPANS.find(([v]) => v === span)?.[1].toLowerCase()}`} />
              : <p className="text-muted-foreground text-sm">Loading…</p>}
          </div>
        )}

        {tab === "followup" && <PaymentFollowUp />}
        {tab === "receivables" && <ClientReceivables />}

        {tab === "people" && (
          <div className="space-y-3">
            {spanPicker}
            <PeopleActivity span={span} />
          </div>
        )}
      </div>
    </>
  );
}
