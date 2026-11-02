import Header from "../../components/Header";
import Tabs from "../../components/Tabs";
import FinanceReport from "../../components/FinanceReport";
import PaymentFollowUp from "../../components/PaymentFollowUp";
import PeopleActivity, { SPANS, type Span } from "../../components/PeopleActivity";
import { AttendanceView, DailyOpsView, LastSent } from "../../components/CeoReports";
import { hasAnyPermission, useAuth } from "../../lib/auth";
import { usePageState } from "../../lib/pageState";

/**
 * CEO DASHBOARD (0632/0633, DECIDED 2 Nov 2026; key dashboard.ceo).
 *
 * The reports as proper screens, one tab each, read-only and for any day:
 * Daily Operations, Attendance, Finance, Payment Follow-up — plus People, what
 * each login did. Shayan turned down a chart overview ("its same as dashboard
 * now") and a PDF viewer ("add proper tabs and screens in it directly"). The
 * last PDF actually sent of each report (0633) is a link at the top of its tab.
 */
type Tab = "daily" | "attendance" | "finance" | "followup" | "people";

export default function CeoDashboard() {
  const { profile } = useAuth();
  const [tab, setTab] = usePageState<Tab>("CeoDashboard.tab4", "daily");
  const [span, setSpan] = usePageState<Span>("CeoDashboard.span", "7d");
  // Follow-up reads with follow-up access; a CEO-only login without it is not shown the tab.
  const canFollowUp = hasAnyPermission(profile, ["receivables.follow_up", "invoices.view", "invoices.edit", "receivables.view", "accounting.edit"]);
  const items: { value: Tab; label: string }[] = [
    { value: "daily", label: "Daily Operations" },
    { value: "attendance", label: "Attendance" },
    { value: "finance", label: "Finance" },
    ...(canFollowUp ? [{ value: "followup" as Tab, label: "Payment Follow-up" }] : []),
    { value: "people", label: "People" },
  ];
  const current = items.some((i) => i.value === tab) ? tab : "daily";

  return (
    <>
      <Header title="CEO Dashboard" subtitle="Every report as a screen, for any day — and what each person did" />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4">
        <Tabs items={items} value={current} onChange={setTab} />

        {current === "daily" && <DailyOpsView />}
        {current === "attendance" && <AttendanceView />}
        {current === "finance" && (
          <div className="space-y-3">
            <LastSent kinds={["finance"]} />
            <FinanceReport readOnly />
          </div>
        )}
        {current === "followup" && (
          <div className="space-y-3">
            <LastSent kinds={["followup"]} />
            <PaymentFollowUp />
          </div>
        )}
        {current === "people" && (
          <div className="space-y-3">
            <Tabs size="sm" items={SPANS.map(([v, label]) => ({ value: v, label }))} value={span} onChange={setSpan} />
            <PeopleActivity span={span} />
          </div>
        )}
      </div>
    </>
  );
}
