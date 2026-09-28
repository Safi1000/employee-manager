import { BellRing, CalendarPlus, Camera, FilePlus2, FolderOpen, Pencil, Plus, Trash2, Upload } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { Progress } from "../../components/Charts";
import { MonthGrid, MonthStepper } from "../../components/MonthGrid";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Chips, Empty, HStack, IconBtn, Input, ListCard, RecordCard, Row, SearchBar, Section, Segmented, Tabs, Toggle, toneOf } from "../../components/ui";
import { THIS_MONTH, TODAY } from "../../data/seed";
import { clientName, useDB } from "../../data/store";
import {
  acknowledgeAlert, addCase, addFiling, addRenewal, addVisit, advanceCase, CASE_TYPES, DateForm, deleteDocument, deleteImportantDate, deleteRecurringAlert,
  FILING_TYPES, JURISDICTIONS, loadAlerts, loadAllDocuments, loadCases, loadRenewals, loadUpcoming, loadVetting, loadVisits, markFiled, markPaid, nextStage,
  RecForm, RENEWAL_STAGES, saveImportantDate, saveRecurringAlert, setRenewalStage, toggleRecurringAlert, UpcomingRow, VettingRow,
} from "../../data/api/compliance";
import { EMPLOYEE_DOC_TYPES, uploadEmployeeDoc } from "../../data/api/employees";
import { useAuth } from "../../lib/auth";
import { pickDocument, takePhoto } from "../../lib/files";
import { daysBetween, fmtShort } from "../../lib/format";
import { COMPLIANCE_CATEGORIES } from "../../lib/web/supabase";
import { useTheme } from "../../theme/ThemeProvider";

const label = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Compliance hub (web ComplianceHub): Calendar · Licences & renewals · Contract renewals. */
export default function Compliance() {
  const { can } = useAuth();
  const [tab, setTab] = useState<"calendar" | "licences" | "renewals">("calendar");
  const [dateEdit, setDateEdit] = useState<{ id: string | null; f: DateForm } | null>(null);
  const [recEdit, setRecEdit] = useState<{ id: string | null; f: RecForm } | null>(null);
  return (
    <Screen
      eyebrow="Compliance"
      title="Compliance"
      actions={can("compliance.edit") && tab === "calendar" ? <>
        <IconBtn icon={BellRing} label="Add recurring alert" onPress={() => setRecEdit({ id: null, f: { name: "", category: "Tax", frequency: "Monthly", trigger_day: "1", advance_notice_days: "3", active: true, notes: "" } })} />
        <IconBtn icon={CalendarPlus} label="Add important date" filled onPress={() => setDateEdit({ id: null, f: { title: "", due_date: TODAY, category: "License", priority: "medium", advance_notice_days: "7", notes: "" } })} />
      </> : undefined}
      sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "calendar", label: "Calendar" }, { key: "licences", label: "Licences & renewals" }, { key: "renewals", label: "Contract renewals" }]} />}
    >
      {tab === "calendar" && <Calendar onEditDate={setDateEdit} onEditRec={setRecEdit} />}
      {tab === "licences" && <Licences />}
      {tab === "renewals" && <Renewals />}
      {dateEdit && <DateSheet init={dateEdit} onClose={() => setDateEdit(null)} />}
      {recEdit && <AlertSheet init={recEdit} onClose={() => setRecEdit(null)} />}
    </Screen>
  );
}

function Calendar({ onEditDate, onEditRec }: { onEditDate: (x: { id: string; f: DateForm }) => void; onEditRec: (x: { id: string; f: RecForm }) => void }) {
  const t = useTheme();
  const { db, v, act } = useDB();
  const { can } = useAuth();
  const { confirm } = useOverlay();
  const [month, setMonth] = useState(THIS_MONTH);
  const [sub, setSub] = useState<"dates" | "alerts">("dates");
  const [day, setDay] = useState<string | null>(null);
  const [vetting, setVetting] = useState<VettingRow[] | null>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  useEffect(() => {
    loadVetting().then(setVetting).catch(() => setVetting([]));
    loadAlerts(db.company.id).then((a) => setAlerts(a.alerts)).catch(() => setAlerts([]));
  }, [db.company.id, v]);
  const sum = (k: keyof VettingRow) => (vetting ?? []).reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const total = sum("total");
  const coverage = [
    { label: "Police verification cleared", n: sum("police_cleared") },
    { label: "NADRA Verisys cleared", n: sum("nadra_cleared") },
    { label: "CNIC number recorded", n: sum("cnic_number_recorded") },
    { label: "CNIC expiry recorded", n: sum("cnic_expiry_recorded") },
  ];
  const upcoming = db.importantDates.filter((d) => daysBetween(TODAY, d.date) <= 60).sort((a, b) => a.date.localeCompare(b.date));
  const ending = db.contracts.filter((k) => k.status === "active" && k.end && daysBetween(TODAY, k.end) <= 60).sort((a, b) => a.end.localeCompare(b.end));
  return (
    <>
      <Section title="Guard data coverage" style={{ marginTop: 0 }}>
        <Card>
          {vetting === null ? <ActivityIndicator color={t.brand[500]} /> : coverage.map((c) => (
            <View key={c.label} style={{ marginBottom: 10 }}>
              <HStack style={{ marginBottom: 4 }}><T v="small" soft style={{ flex: 1, fontSize: 14 }}>{c.label}</T><T v="mono">{c.n}/{total}</T></HStack>
              <Progress value={c.n} max={Math.max(total, 1)} tone={total && c.n / total > 0.9 ? "success" : "warning"} />
            </View>
          ))}
        </Card>
      </Section>
      <Section title="Raised alerts" count={alerts.length}>
        {alerts.length ? <ListCard>{alerts.map((a, i) => <Row key={a.id} last={i === alerts.length - 1} title={a.message} meta={fmtShort(String(a.created_at).slice(0, 10))} right={<Badge label={a.tier} tone={a.tier === "blocking" ? "danger" : "warning"} small />} />)}</ListCard> : <T v="small" muted>No open alerts.</T>}
      </Section>
      {ending.length > 0 && (
        <Section title="Contracts ending within 60 days" count={ending.length}>
          <ListCard>{ending.map((k, i) => <Row key={k.id} last={i === ending.length - 1} title={clientName(db, k.client_id)} subtitle={k.code} right={<Badge label={`${daysBetween(TODAY, k.end)}d`} tone="warning" small />} />)}</ListCard>
        </Section>
      )}
      <Section title="Calendar">
        <MonthStepper month={month} onChange={setMonth} max="2099-12" />
        <Card pad={10} style={{ marginTop: 10 }}>
          <MonthGrid month={month} selected={day} onPress={setDay} render={(d) => {
            const n = db.importantDates.filter((x) => x.date === d);
            return n.length ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.tone(n.some((x) => x.priority === "high" || x.priority === "critical") ? "danger" : "warning").solid }} /> : null;
          }} />
        </Card>
        {day && <View style={{ marginTop: 8 }}>{db.importantDates.filter((x) => x.date === day).map((x) => <T key={x.id} v="smallStrong">{x.title}</T>)}{!db.importantDates.some((x) => x.date === day) && <T v="small" muted>Nothing on {fmtShort(day)}.</T>}</View>}
      </Section>
      <Section title="Upcoming" count={upcoming.length}>
        <ListCard>{upcoming.map((d, i) => { const n = daysBetween(TODAY, d.date); return <Row key={d.id} last={i === upcoming.length - 1} title={d.title} subtitle={`${d.category} · ${fmtShort(d.date)}`} right={<Badge label={n < 0 ? `${-n}d overdue` : `${n}d`} tone={n < 0 ? "danger" : n <= d.notice ? "warning" : "neutral"} small />} />; })}</ListCard>
      </Section>
      <View style={{ marginTop: 22 }}>
        <Segmented value={sub} onChange={setSub} items={[{ key: "dates", label: "Important dates", count: db.importantDates.length }, { key: "alerts", label: "Recurring alerts", count: db.recurringAlerts.length }]} />
      </View>
      <View style={{ marginTop: 12 }}>
        {sub === "dates" ? db.importantDates.map((d) => (
          <RecordCard key={d.id} title={d.title} subtitle={d.category} badge={<Badge label={d.priority} tone={toneOf(d.priority)} small />}
            fields={[{ label: "Date", value: fmtShort(d.date) }, { label: "Days remaining", value: String(daysBetween(TODAY, d.date)), mono: true, tone: d.date < TODAY ? "danger" : undefined }, { label: "Advance notice", value: `${d.notice} days` }]}
            actions={can("compliance.edit") ? [
              { label: "Edit", icon: Pencil, onPress: () => onEditDate({ id: d.id, f: { title: d.title, due_date: d.date, category: d.category, priority: d.priority, advance_notice_days: String(d.notice), notes: d.raw?.notes ?? "" } }) },
              { label: "Delete", icon: Trash2, tone: "danger", onPress: async () => { if (await confirm({ title: `Delete "${d.title}"?`, confirmLabel: "Delete", tone: "danger" })) await act(() => deleteImportantDate(d.id), "Date removed"); } },
            ] : undefined} />
        )) : db.recurringAlerts.map((a) => (
          <RecordCard key={a.id} title={a.name} subtitle={a.category} badge={<Badge label={a.active ? "Active" : "Paused"} tone={a.active ? "success" : "neutral"} small />}
            fields={[{ label: "Frequency", value: a.frequency }, { label: "Trigger day", value: String(a.raw?.trigger_day ?? a.trigger_day), mono: true }, { label: "Advance notice", value: `${a.notice} days` }]}
            actions={can("compliance.edit") ? [
              { label: a.active ? "Pause" : "Resume", onPress: () => { void act(() => toggleRecurringAlert(a.id, !a.active), a.active ? "Paused" : "Resumed"); } },
              { label: "Edit", icon: Pencil, onPress: () => onEditRec({ id: a.id, f: { name: a.name, category: a.category, frequency: a.frequency, trigger_day: String(a.raw?.trigger_day ?? a.trigger_day), advance_notice_days: String(a.notice), active: a.active, notes: a.raw?.notes ?? "" } }) },
              { label: "Delete", icon: Trash2, tone: "danger", onPress: async () => { if (await confirm({ title: `Delete recurring alert "${a.name}"?`, confirmLabel: "Delete", tone: "danger" })) await act(() => deleteRecurringAlert(a.id), "Alert removed"); } },
            ] : undefined} />
        ))}
      </View>
    </>
  );
}

function DateSheet({ init, onClose }: { init: { id: string | null; f: DateForm }; onClose: () => void }) {
  const { act } = useDB();
  const [f, setF] = useState<DateForm>(init.f);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={init.id ? "Edit important date" : "Add important date"}
      footer={<Button label="Save" full loading={busy} disabled={!f.title.trim()} onPress={async () => { setBusy(true); const ok = await act(() => saveImportantDate(init.id, f), init.id ? "Date saved" : "Date added"); setBusy(false); if (ok) onClose(); }} />}>
      <Input label="Title" required value={f.title} onChangeText={(v) => setF({ ...f, title: v })} />
      <Input label="Due date" required value={f.due_date} onChangeText={(v) => setF({ ...f, due_date: v })} placeholder="YYYY-MM-DD" />
      <Select label="Category" value={f.category} onChange={(v) => setF({ ...f, category: v })} options={COMPLIANCE_CATEGORIES.map((x) => ({ value: x, label: x }))} />
      <Select label="Priority" value={f.priority} onChange={(v) => setF({ ...f, priority: v })} options={["critical", "high", "medium", "low"].map((x) => ({ value: x, label: label(x) }))} />
      <Input label="Advance notice (days)" keyboardType="numeric" value={f.advance_notice_days} onChangeText={(v) => setF({ ...f, advance_notice_days: v })} />
      <Input label="Notes" multiline value={f.notes} onChangeText={(v) => setF({ ...f, notes: v })} />
    </Sheet>
  );
}

function AlertSheet({ init, onClose }: { init: { id: string | null; f: RecForm }; onClose: () => void }) {
  const { act } = useDB();
  const [f, setF] = useState<RecForm>(init.f);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={init.id ? "Edit recurring alert" : "Add recurring alert"}
      footer={<Button label="Save" full loading={busy} disabled={!f.name.trim()} onPress={async () => { setBusy(true); const ok = await act(() => saveRecurringAlert(init.id, f), init.id ? "Alert saved" : "Alert added"); setBusy(false); if (ok) onClose(); }} />}>
      <Input label="Name" required value={f.name} onChangeText={(v) => setF({ ...f, name: v })} placeholder="e.g., Monthly Tax Filing Reminder" />
      <Select label="Category" value={f.category} onChange={(v) => setF({ ...f, category: v })} options={COMPLIANCE_CATEGORIES.map((x) => ({ value: x, label: x }))} />
      <Select label="Frequency" value={f.frequency} onChange={(v) => setF({ ...f, frequency: v })} options={["Daily", "Weekly", "Monthly", "Yearly"].map((x) => ({ value: x, label: x }))} />
      <HStack gap={10}>
        <Input style={{ flex: 1 }} label="Trigger day" required value={f.trigger_day} onChangeText={(v) => setF({ ...f, trigger_day: v })} />
        <Input style={{ flex: 1 }} label="Notice (days)" keyboardType="numeric" value={f.advance_notice_days} onChangeText={(v) => setF({ ...f, advance_notice_days: v })} />
      </HStack>
      <Toggle label="Active" value={f.active} onChange={(v) => setF({ ...f, active: v })} />
      <Input label="Notes" multiline value={f.notes} onChangeText={(v) => setF({ ...f, notes: v })} />
    </Sheet>
  );
}

/** Licences: reads compliance_upcoming and nothing else; days_remaining is the server's. */
function Licences() {
  const t = useTheme();
  const { v } = useDB();
  const [rows, setRows] = useState<UpcomingRow[] | null>(null);
  const [e, setE] = useState<string | null>(null);
  const [bucket, setBucket] = useState("all");
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { loadUpcoming().then(setRows).catch((x) => { setE(err(x)); setRows([]); }); }, [v]);
  const band = (d: number) => (d < 0 ? "expired" : d <= 30 ? "30" : d <= 90 ? "90" : "future");
  const list = (rows ?? []).filter((r) => (bucket === "all" || band(r.days_remaining) === bucket) && (!kind || r.kind === kind) && (!q || (r.label + (r.sublabel ?? "")).toLowerCase().includes(q.toLowerCase())));
  if (!rows) return <ActivityIndicator color={t.brand[500]} style={{ marginTop: 30 }} />;
  return (
    <>
      {e ? <Banner tone="danger" title="Couldn't load" sub={e} /> : null}
      <Chips value={bucket} onChange={setBucket} items={[{ key: "all", label: "All" }, { key: "expired", label: "Expired" }, { key: "30", label: "≤ 30 days" }, { key: "90", label: "≤ 90 days" }, { key: "future", label: "> 90 days" }]} />
      <View style={{ gap: 8, marginTop: 8, marginBottom: 12 }}>
        <Select compact clearable label="Kind" value={kind} onChange={setKind} placeholder="All kinds" options={[...new Set(rows.map((r) => r.kind))].map((k) => ({ value: k, label: label(k) }))} />
        <SearchBar value={q} onChange={setQ} placeholder="Search" />
      </View>
      {list.map((r) => {
        const d = r.days_remaining;
        return <RecordCard key={`${r.kind}-${r.ref_id}`} title={r.label} subtitle={r.sublabel ?? label(r.kind)} accent={d < 0 ? "danger" : d <= 30 ? "warning" : undefined}
          badge={<Badge label={d < 0 ? "Expired" : d <= 30 ? "< 30 days" : d <= 90 ? "< 90 days" : "> 90 days"} tone={d < 0 || d <= 30 ? "danger" : d <= 90 ? "warning" : "success"} small />}
          fields={[{ label: "Kind", value: label(r.kind) }, { label: "Due", value: fmtShort(r.due_date) }, { label: "Days", value: String(d), mono: true, tone: d < 0 ? "danger" : undefined }]} />;
      })}
      {list.length === 0 && <Empty title="Nothing in this window" />}
    </>
  );
}

function Renewals() {
  const t = useTheme();
  const { db, v, act } = useDB();
  const { can } = useAuth();
  const [rows, setRows] = useState<any[] | null>(null);
  const [client, setClient] = useState("");
  const [date, setDate] = useState("");
  const load = useCallback(() => loadRenewals(db.company.id).then(setRows).catch(() => setRows([])), [db.company.id]);
  useEffect(() => { void load(); }, [load, v]);
  if (!rows) return <ActivityIndicator color={t.brand[500]} style={{ marginTop: 30 }} />;
  return (
    <>
      {can("compliance.edit") && (
        <Card style={{ marginBottom: 10 }}>
          <T v="h3" style={{ marginBottom: 10 }}>Add to pipeline</T>
          <Select label="Client" value={client} onChange={setClient} options={db.clients.map((c) => ({ value: c.id, label: c.name }))} />
          <Input label="Expected close" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" />
          <Button label="Add" icon={Plus} disabled={!client} onPress={async () => { if (await act(() => addRenewal(db.company.id, client, date), "Added to pipeline")) { setClient(""); setDate(""); } }} />
        </Card>
      )}
      {rows.map((r) => (
        <RecordCard key={r.id} title={clientName(db, r.client_id)} badge={<Badge label={label(r.stage)} tone={toneOf(r.stage)} small />}
          fields={[{ label: "Expected close", value: r.expected_close_date ? fmtShort(r.expected_close_date) : "—" }, { label: "Days", value: r.expected_close_date ? String(daysBetween(TODAY, r.expected_close_date)) : "—", mono: true }]}>
          {can("compliance.edit") ? <View style={{ marginTop: 10 }}><Select compact label="Stage" value={r.stage} onChange={(s) => { void act(() => setRenewalStage(r.id, s), `Moved to ${label(s)}`); }} options={RENEWAL_STAGES.map((s) => ({ value: s, label: label(s) }))} /></View> : null}
        </RecordCard>
      ))}
      {rows.length === 0 && <Empty title="Nothing in the pipeline" />}
    </>
  );
}

// ---------------------------------------------------------------- Compliance Cases
export function ComplianceCases() {
  const t = useTheme();
  const { db, v, act } = useDB();
  const { can } = useAuth();
  const [tab, setTab] = useState<"cases" | "filings">("cases");
  const [data, setData] = useState<Awaited<ReturnType<typeof loadCases>> | null>(null);
  const [nc, setNc] = useState({ title: "", case_type: "licence", jurisdiction: "ict", authority: "", target_date: "" });
  const [nf, setNf] = useState({ filing_type: "eobi", period_month: "", due_date: "", amount: "" });
  const [visitCase, setVisitCase] = useState<any | null>(null);
  const load = useCallback(() => loadCases(db.company.id).then(setData).catch(() => setData({ cases: [], register: [], filings: [] })), [db.company.id]);
  useEffect(() => { void load(); }, [load, v]);
  return (
    <Screen eyebrow="Compliance" title="Compliance Cases" sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "cases", label: "Cases", count: data?.cases.length }, { key: "filings", label: "Statutory filings", count: data?.filings.length }]} />}>
      {!data ? <ActivityIndicator color={t.brand[500]} style={{ marginTop: 30 }} /> : tab === "cases" ? (
        <>
          {data.register.length > 0 && (
            <HStack wrap gap={6} style={{ marginBottom: 12 }}>
              {data.register.map((r) => <Badge key={r.jurisdiction} label={`${String(r.jurisdiction).toUpperCase()} · ${r.open_cases} open${Number(r.overdue_cases) ? ` · ${r.overdue_cases} overdue` : ""}`} tone={Number(r.overdue_cases) ? "danger" : "neutral"} />)}
            </HStack>
          )}
          {can("compliance.edit") && (
            <Card style={{ marginBottom: 10 }}>
              <T v="h3" style={{ marginBottom: 10 }}>New case</T>
              <Input label="Title" required value={nc.title} onChangeText={(x) => setNc({ ...nc, title: x })} />
              <HStack gap={10}>
                <View style={{ flex: 1 }}><Select label="Type" value={nc.case_type} onChange={(x) => setNc({ ...nc, case_type: x })} options={CASE_TYPES.map((x) => ({ value: x, label: label(x) }))} /></View>
                <View style={{ flex: 1 }}><Select label="Jurisdiction" value={nc.jurisdiction} onChange={(x) => setNc({ ...nc, jurisdiction: x })} options={JURISDICTIONS.map((x) => ({ value: x, label: x.toUpperCase() }))} /></View>
              </HStack>
              <Input label="Authority" value={nc.authority} onChangeText={(x) => setNc({ ...nc, authority: x })} />
              <Input label="Target date" value={nc.target_date} onChangeText={(x) => setNc({ ...nc, target_date: x })} placeholder="YYYY-MM-DD" />
              <Button label="Add case" disabled={!nc.title.trim()} onPress={async () => { if (await act(() => addCase(nc), "Case opened")) setNc({ title: "", case_type: "licence", jurisdiction: "ict", authority: "", target_date: "" }); }} />
            </Card>
          )}
          {data.cases.map((c) => {
            const next = nextStage(c.stage);
            return (
              <RecordCard key={c.id} title={c.title} subtitle={`${label(c.case_type)} · ${String(c.jurisdiction).toUpperCase()}${c.authority ? ` · ${c.authority}` : ""}`} badge={<Badge label={label(c.stage)} tone="info" small />}
                fields={[{ label: "Target", value: c.target_date ? fmtShort(c.target_date) : "—" }, { label: "Days", value: c.target_date ? String(daysBetween(TODAY, c.target_date)) : "—", mono: true }]}
                actions={[
                  { label: "Visits", onPress: () => setVisitCase(c) },
                  ...(can("compliance.edit") && next ? [{ label: `→ ${label(next)}`, onPress: () => { void act(() => advanceCase(c.id, c.stage), "Stage advanced"); } }] : []),
                ]} />
            );
          })}
          {data.cases.length === 0 && <Empty title="No cases" />}
        </>
      ) : (
        <>
          {can("compliance.filings") && (
            <Card style={{ marginBottom: 10 }}>
              <T v="h3" style={{ marginBottom: 10 }}>New filing</T>
              <Select label="Type" value={nf.filing_type} onChange={(x) => setNf({ ...nf, filing_type: x })} options={FILING_TYPES.map((x) => ({ value: x, label: label(x) }))} />
              <HStack gap={10}>
                <Input style={{ flex: 1 }} label="Period month" required value={nf.period_month} onChangeText={(x) => setNf({ ...nf, period_month: x })} placeholder="YYYY-MM-01" />
                <Input style={{ flex: 1 }} label="Due date" required value={nf.due_date} onChangeText={(x) => setNf({ ...nf, due_date: x })} placeholder="YYYY-MM-DD" />
              </HStack>
              <Input label="Amount" amount value={nf.amount} onChangeText={(x) => setNf({ ...nf, amount: x })} />
              <Button label="Add filing" disabled={!nf.period_month || !nf.due_date} onPress={async () => { if (await act(() => addFiling(nf), "Filing added")) setNf({ filing_type: "eobi", period_month: "", due_date: "", amount: "" }); }} />
            </Card>
          )}
          {data.filings.map((x) => {
            const status = x.paid_date ? "paid" : x.filed_date ? "filed" : x.due_date < TODAY ? "overdue" : "pending";
            return (
              <RecordCard key={x.id} title={label(x.filing_type)} subtitle={`Period ${String(x.period_month).slice(0, 7)}`} badge={<Badge label={label(status)} tone={toneOf(status)} small />}
                fields={[{ label: "Due", value: fmtShort(x.due_date) }, { label: "Amount", value: x.amount != null ? `PKR ${Number(x.amount).toLocaleString("en-US")}` : "—", mono: true }]}
                actions={can("compliance.filings") ? [
                  ...(!x.filed_date ? [{ label: "File", tone: "success" as const, onPress: () => { void act(() => markFiled(x.id), "Filing recorded"); } }] : []),
                  ...(!x.paid_date ? [{ label: "Pay", onPress: () => { void act(() => markPaid(x.id), "Payment recorded"); } }] : []),
                ] : undefined} />
            );
          })}
          {data.filings.length === 0 && <Empty title="No filings" />}
        </>
      )}
      {visitCase && <VisitsSheet c={visitCase} onClose={() => setVisitCase(null)} />}
    </Screen>
  );
}

function VisitsSheet({ c, onClose }: { c: any; onClose: () => void }) {
  const { db, act } = useDB();
  const [rows, setRows] = useState<any[] | null>(null);
  const [f, setF] = useState({ date: TODAY, outcome: "", next_action: "", next_date: "" });
  const load = useCallback(() => loadVisits(c.id).then(setRows).catch(() => setRows([])), [c.id]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Sheet open onClose={onClose} title="Government visits" subtitle={c.title} full
      footer={<Button label="Log visit" full disabled={!f.outcome.trim()} onPress={async () => { if (await act(() => addVisit(db.company.id, c.id, f), "Visit logged")) { setF({ date: TODAY, outcome: "", next_action: "", next_date: "" }); await load(); } }} />}>
      <Input label="Date" value={f.date} onChangeText={(x) => setF({ ...f, date: x })} placeholder="YYYY-MM-DD" />
      <Input label="Outcome" required value={f.outcome} onChangeText={(x) => setF({ ...f, outcome: x })} multiline />
      <Input label="Next action" value={f.next_action} onChangeText={(x) => setF({ ...f, next_action: x })} />
      <Input label="Next action date" value={f.next_date} onChangeText={(x) => setF({ ...f, next_date: x })} placeholder="YYYY-MM-DD" />
      <ListCard>
        {(rows ?? []).map((x, i, a) => <Row key={x.id} last={i === a.length - 1} title={x.outcome} subtitle={x.next_action ? `→ ${x.next_action}` : undefined} meta={`${fmtShort(x.visit_date)}${x.next_action_date ? ` · next ${fmtShort(x.next_action_date)}` : ""}`} />)}
        {rows && rows.length === 0 && <View style={{ padding: 14 }}><T v="small" muted>No visits logged for this case.</T></View>}
      </ListCard>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Documents
export function Documents() {
  const t = useTheme();
  const { db, v, act } = useDB();
  const { can } = useAuth();
  const { toast, confirm } = useOverlay();
  const [q, setQ] = useState("");
  const [client, setClient] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [upload, setUpload] = useState(false);
  const [upEmp, setUpEmp] = useState("");
  const [upType, setUpType] = useState<string>("CNIC");
  const [docs, setDocs] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadAllDocuments().then(setDocs).catch(() => setDocs([])); }, [v]);
  const byEmp = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const d of docs ?? []) m.set(d.employee_id, [...(m.get(d.employee_id) ?? []), d]);
    return m;
  }, [docs]);
  const list = db.employees.filter((e) => e.lifecycle === "active" && (!client || e.client_id === client) && (!q || (e.name + e.code + e.phone).toLowerCase().includes(q.toLowerCase())));
  const e = db.employees.find((x) => x.id === open);
  const doUpload = async (source: "camera" | "file") => {
    const emp = db.employees.find((x) => x.id === upEmp);
    if (!emp) return toast("Pick an employee first", "danger");
    try {
      const file = source === "camera" ? await takePhoto() : await pickDocument();
      if (!file) return;
      setBusy(true);
      if (await act(() => uploadEmployeeDoc(emp, { id: db.company.id, name: db.company.name }, upType, file), `${upType} uploaded for ${emp.name}`)) setUpload(false);
    } catch (x) { toast(err(x), "danger"); } finally { setBusy(false); }
  };
  return (
    <Screen eyebrow="Compliance" title="Documents" actions={can("documents.edit") ? <IconBtn icon={Upload} label="Upload documents" filled onPress={() => setUpload(true)} /> : undefined}
      sticky={<SearchBar value={q} onChange={setQ} placeholder="Name, code or phone" />}>
      <Select compact clearable label="Client" value={client} onChange={setClient} placeholder="All" options={db.clients.map((c) => ({ value: c.id, label: c.name }))} />
      <View style={{ height: 12 }} />
      {!docs ? <ActivityIndicator color={t.brand[500]} /> : list.slice(0, 80).map((x) => {
        const mine = byEmp.get(x.id) ?? [];
        return <RecordCard key={x.id} title={x.name} subtitle={x.code} onPress={() => setOpen(x.id)} leading={<FolderOpen size={20} />}
          fields={[{ label: "Client", value: clientName(db, x.client_id) }, { label: "Shift", value: x.shift }, { label: "Documents", value: String(mine.length), mono: true, tone: mine.length === 0 ? "warning" : undefined }, { label: "Last updated", value: mine[0] ? fmtShort(String(mine[0].uploaded_at).slice(0, 10)) : "—" }]} />;
      })}
      <Sheet open={!!e} onClose={() => setOpen(null)} title="Employee documents" subtitle={e?.name}>
        {e && (
          <ListCard>
            {(byEmp.get(e.id) ?? []).map((d, i, a) => <Row key={d.id} last={i === a.length - 1} title={d.file_name} meta={`${d.doc_type} · ${fmtShort(String(d.uploaded_at).slice(0, 10))}`}
              onPress={() => d.drive_view_url ? Linking.openURL(d.drive_view_url).catch(() => toast("Could not open the file", "danger")) : toast("This file has no link", "danger")}
              right={can("documents.edit") ? <IconBtn icon={Trash2} label="Delete" onPress={async () => { if (await confirm({ title: `Delete "${d.file_name}"?`, confirmLabel: "Delete", tone: "danger" })) await act(() => deleteDocument(d), "Document deleted"); }} /> : undefined} />)}
            {(byEmp.get(e.id) ?? []).length === 0 && <View style={{ padding: 14 }}><T v="small" muted>No documents yet.</T></View>}
          </ListCard>
        )}
      </Sheet>
      <Sheet open={upload} onClose={() => setUpload(false)} title="Upload documents"
        footer={<><Button label="Photo" icon={Camera} variant="secondary" full loading={busy} onPress={() => doUpload("camera")} /><Button label="Choose file" icon={FilePlus2} full loading={busy} onPress={() => doUpload("file")} /></>}>
        <Select label="Employee" required searchable value={upEmp} onChange={setUpEmp} options={db.employees.filter((x) => x.lifecycle === "active").map((x) => ({ value: x.id, label: x.name, sub: x.code }))} />
        <Select label="Document type" value={upType} onChange={setUpType} options={EMPLOYEE_DOC_TYPES.map((x) => ({ value: x, label: x }))} />
        <T v="small" muted>{upType === "Other" ? "Added alongside existing files." : `Replaces the current ${upType} file.`}</T>
      </Sheet>
    </Screen>
  );
}

// ---------------------------------------------------------------- Alerts
export function Alerts() {
  const t = useTheme();
  const { db, v, act } = useDB();
  const [data, setData] = useState<Awaited<ReturnType<typeof loadAlerts>> | null>(null);
  const [override, setOverride] = useState<any | null>(null);
  const [reason, setReason] = useState("");
  const load = useCallback(() => loadAlerts(db.company.id).then(setData).catch(() => setData({ alerts: [], warnings: [], dashboard: [] })), [db.company.id]);
  useEffect(() => { void load(); }, [load, v]);
  if (!data) return <Screen eyebrow="Compliance" title="Alerts"><ActivityIndicator color={t.brand[500]} style={{ marginTop: 30 }} /></Screen>;
  return (
    <Screen eyebrow="Compliance" title="Alerts">
      <Section title="Open alerts" count={data.alerts.length} style={{ marginTop: 0 }}>
        {data.alerts.map((a) => (
          <RecordCard key={a.id} title={a.message} subtitle={fmtShort(String(a.created_at).slice(0, 10))} accent={a.tier === "blocking" ? "danger" : "warning"} badge={<Badge label={a.tier} tone={a.tier === "blocking" ? "danger" : "warning"} small />}
            actions={[{ label: a.tier === "blocking" ? "Override" : "Acknowledge", onPress: () => { if (a.tier === "blocking") { setReason(""); setOverride(a); } else void act(() => acknowledgeAlert(a.id, false, ""), "Acknowledged"); } }]} />
        ))}
        {data.alerts.length === 0 && <Empty title="No open alerts" />}
      </Section>
      <Section title="Live warnings" count={data.warnings.length}>
        {data.warnings.length ? <ListCard>{data.warnings.map((w, i) => <Row key={i} last={i === data.warnings.length - 1} title={w.message} subtitle={label(String(w.category))} />)}</ListCard> : <T v="small" muted>No live warnings.</T>}
      </Section>
      <Section title="Dashboard summary" count={data.dashboard.length}>
        {data.dashboard.length ? <ListCard>{data.dashboard.map((d, i) => <Row key={i} last={i === data.dashboard.length - 1} title={d.message} subtitle={label(String(d.category))} />)}</ListCard> : <T v="small" muted>Nothing to surface.</T>}
      </Section>
      <Sheet open={!!override} onClose={() => setOverride(null)} title="Override blocking alert" subtitle={override?.message}
        footer={<Button label="Override" variant="danger" full disabled={!reason.trim()} onPress={async () => { if (await act(() => acknowledgeAlert(override.id, true, reason), "Alert overridden")) setOverride(null); }} />}>
        <Input label="Override reason" required value={reason} onChangeText={setReason} multiline />
      </Sheet>
    </Screen>
  );
}
