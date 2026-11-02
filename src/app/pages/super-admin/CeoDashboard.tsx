import Header from "../../components/Header";
import Tabs from "../../components/Tabs";
import KeptReport from "../../components/KeptReport";
import PeopleActivity, { SPANS, type Span } from "../../components/PeopleActivity";
import { usePageState } from "../../lib/pageState";

/**
 * CEO DASHBOARD (0632/0633, DECIDED 2 Nov 2026; key dashboard.ceo).
 *
 * The reports themselves, as the LAST ONE SENT — exactly the PDF that went out,
 * with when and who, and the earlier ones beneath (0633 keeps every export).
 * Shayan turned down a chart overview ("its same as dashboard now") and links
 * out to each report page; the CEO reads what the team actually sent. People
 * is the one live view: what each login did, from records already in Bastion.
 */
type Tab = "daily" | "attendance" | "finance" | "followup" | "people";

export default function CeoDashboard() {
  const [tab, setTab] = usePageState<Tab>("CeoDashboard.tab3", "daily");
  const [span, setSpan] = usePageState<Span>("CeoDashboard.span", "7d");
  const items: { value: Tab; label: string }[] = [
    { value: "daily", label: "Daily Operations" },
    { value: "attendance", label: "Attendance" },
    { value: "finance", label: "Finance" },
    { value: "followup", label: "Payment Follow-up" },
    { value: "people", label: "People" },
  ];

  return (
    <>
      <Header title="CEO Dashboard" subtitle="The last report sent of each kind, exactly as it went out — and what each person did" />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4">
        <Tabs items={items} value={items.some((i) => i.value === tab) ? tab : "daily"} onChange={setTab} />

        {/* A daily export may carry the attendance report with it, so each tab reads both kinds. */}
        {tab === "daily" && <KeptReport kinds={["daily", "daily_attendance"]} title="Daily Operations Report" />}
        {tab === "attendance" && <KeptReport kinds={["attendance", "daily_attendance"]} title="Attendance Report" />}
        {tab === "finance" && <KeptReport kinds={["finance"]} title="Finance Report" />}
        {tab === "followup" && <KeptReport kinds={["followup"]} title="Payment Follow-up" />}

        {tab === "people" && (
          <div className="space-y-3">
            <Tabs size="sm" items={SPANS.map(([v, label]) => ({ value: v, label }))} value={span} onChange={setSpan} />
            <PeopleActivity span={span} />
          </div>
        )}
      </div>
    </>
  );
}
