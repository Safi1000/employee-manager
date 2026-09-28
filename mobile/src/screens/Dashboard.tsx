// Dashboard (web super-admin/Dashboard.tsx): the same reads and widgets, gated by
// the same permissions and the company's hidden-widget list, plus the shared
// files / links board.
import { useRouter } from "expo-router";
import { AlertTriangle, Calendar, CalendarCheck, FileSignature, Link2, Lock, Paperclip, Plus, Receipt, Siren, Trash2, Unlock, Users, Wallet } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { Bars, Columns } from "../components/Charts";
import { Screen } from "../components/Screen";
import { Sheet, useOverlay } from "../components/Sheet";
import { T } from "../components/Text";
import { Badge, Banner, Button, Card, Empty, HStack, IconBtn, Input, ListCard, Row, Section, Stat, StatGrid } from "../components/ui";
import { useDB } from "../data/store";
import { addAttachmentLink, attachmentUrl, DashboardData, loadAttachments, loadDashboard, monthShort, removeAttachment, uploadAttachment } from "../data/api/dashboard";
import { useAuth } from "../lib/auth";
import { pickDocument } from "../lib/files";
import { fmtShort } from "../lib/format";
import { useRegion } from "../lib/region";
import { useTheme } from "../theme/ThemeProvider";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const compact = (n: number) => (Math.abs(n) >= 1_000_000 ? `PKR ${(n / 1_000_000).toFixed(1)}M` : Math.abs(n) >= 1_000 ? `PKR ${(n / 1_000).toFixed(0)}K` : `PKR ${Math.round(n).toLocaleString("en-PK")}`);
const delta = (curr: number, prev: number) => {
  if (prev === 0 && curr === 0) return "no change";
  if (prev === 0) return "new this month";
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% vs ${monthShort(-1)}`;
};
const SEVERITY: Record<string, "danger" | "warning" | "neutral"> = { critical: "danger", high: "danger", medium: "warning", low: "neutral" };

export default function Dashboard() {
  const t = useTheme();
  const router = useRouter();
  const { db } = useDB();
  const { profile, can } = useAuth();
  const { regionId } = useRegion();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let c = false; loadDashboard(regionId).then((d) => { if (!c) { setData(d); setError(null); } }).catch((e) => { if (!c) setError(err(e)); }); return () => { c = true; }; }, [regionId]);

  const hidden = useMemo(() => new Set<string>((db.company.raw?.dashboard_hidden_widgets ?? []) as string[]), [db.company.raw]);
  const show = (k: string) => !hidden.has(k);
  const has = {
    compliance: can("compliance.view"), employees: can("employees.view"), attendance: can("attendance.view"), expenses: can("expenses.view"), payroll: can("payroll.view"),
    accounting: can("banks.view"), reports: can("reports.view"), contracts: can("contracts.view"), roster: can("roster.view"), incidents: can("incidents.view"),
    periodClose: can("period_close.manage") || can("reports.view"),
  };
  const nothing = !Object.entries(has).some(([k, v]) => k !== "periodClose" && v);

  const feed = useMemo(() => {
    if (!data) return [];
    const dated: { at: string; id: string; tone: "success" | "danger" | "info"; text: string; amount?: string }[] = [];
    data.recentPayments.forEach((p) => dated.push({ at: p.payment_date, id: `pay-${p.id}`, tone: "success", text: `Payment received · ${p.client_name} · ${fmtShort(p.payment_date)}`, amount: `+${compact(p.amount)}` }));
    data.recentIncidents.forEach((i) => dated.push({ at: i.occurred_at.slice(0, 10), id: `inc-${i.id}`, tone: "danger", text: `Incident ${i.code} · ${i.category} · ${i.status.replace(/_/g, " ")}` }));
    data.alerts.forEach((a) => dated.push({ at: a.due_date, id: `al-${a.id}`, tone: "info", text: `${a.title} · due ${fmtShort(a.due_date)}` }));
    return dated.sort((a, b) => b.at.localeCompare(a.at));
  }, [data]);

  const stats: Stat[] = [];
  if (data) {
    if (has.employees && show("stat_employees")) stats.push({ label: "Total employees", value: String(data.employeeCount), tone: "brand", icon: Users, onPress: () => router.push("/employees") });
    if (has.attendance && show("stat_attendance_today")) stats.push({ label: "Attendance today", value: `${data.attToday}%`, tone: "info", icon: Calendar, hint: data.attToday === 0 && data.attYest === 0 ? undefined : `${data.attToday - data.attYest >= 0 ? "+" : ""}${data.attToday - data.attYest}% from yesterday`, onPress: () => router.push("/attendance") });
    if (has.expenses && show("stat_expenses_mtd")) stats.push({ label: `Expenses · ${monthShort(0)}`, value: compact(data.expensesMtd), tone: "danger", icon: Receipt, hint: delta(data.expensesMtd, data.expensesPrev), onPress: () => router.push("/expenses") });
    if (has.payroll && show("stat_payroll_mtd")) stats.push({ label: `Payroll · ${monthShort(0)}`, value: compact(data.payrollMtd), tone: "warning", icon: Wallet, hint: delta(data.payrollMtd, data.payrollPrev), onPress: () => router.push("/payroll") });
    if (has.contracts && show("stat_active_contracts")) stats.push({ label: "Active contracts", value: String(data.activeContracts), tone: "brand", icon: FileSignature, onPress: () => router.push("/contracts") });
    if (has.incidents && show("stat_open_incidents")) stats.push({ label: "Open incidents", value: String(data.openIncidents), tone: data.openIncidents > 0 ? "danger" : "info", icon: Siren, onPress: () => router.push("/incidents") });
    if (has.compliance && show("stat_licences_expiring")) stats.push({ label: data.licencesOverdue > 0 ? `Compliance due <30d (${data.licencesOverdue} overdue)` : "Compliance due <30d", value: String(data.licencesExpiring), tone: data.licencesOverdue > 0 ? "danger" : "warning", icon: AlertTriangle, onPress: () => router.push("/compliance") });
  }
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <Screen region eyebrow={new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} title={`${greet}, ${profile?.name.split(" ")[0] ?? ""}`}>
      {error && <Banner tone="danger" title={error} />}
      {nothing && <Card><Empty icon={CalendarCheck} title="Nothing to show yet" sub="Your permissions don't include any dashboard widgets. Use Menu to reach your pages." /></Card>}
      {!data && !error && !nothing && <ActivityIndicator style={{ marginTop: 24 }} />}
      {data && !nothing && (
        <>
          {stats.length > 0 && <StatGrid items={stats} />}
          {has.accounting && show("bank_overview") && (
            <Section title="Bank account overview" count={data.banks.length} action={<T v="smallStrong" color={t.tone("brand").text} onPress={() => router.push("/accounting?tab=banks")}>Open</T>}>
              <ListCard>{data.banks.map((b, i) => <Row key={b.id} last={i === data.banks.length - 1} title={b.bank_name} right={<T v="mono" style={{ fontSize: 14 }}>{compact(b.balance)}</T>} />)}</ListCard>
              <T v="small" muted style={{ marginTop: 6 }}>Total {compact(data.banks.reduce((s, b) => s + b.balance, 0))}</T>
            </Section>
          )}
          {has.reports && show("top_clients") && data.topClients.length > 0 && (
            <Section title={`Top clients · payments ${monthShort(0)}`}><Card><Bars data={data.topClients.map((c) => ({ label: c.name, value: c.revenue }))} format={compact} /></Card></Section>
          )}
          <Section title="Live activity">
            {feed.length > 0 ? (
              <ListCard>
                {feed.slice(0, 20).map((f, i) => (
                  <Row key={f.id} last={i === Math.min(feed.length, 20) - 1} left={<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.tone(f.tone).solid }} />}
                    title={<T v="small" style={{ fontSize: 14 }}>{f.text}</T>} right={f.amount ? <T v="mono" color={t.tone("success").text}>{f.amount}</T> : undefined} />
                ))}
              </ListCard>
            ) : <Card><T v="small" muted>No recent activity. Payments received, incidents logged and upcoming compliance dates appear here.</T></Card>}
          </Section>
          {has.expenses && show("expenses_pie") && data.pie.length > 0 && (
            <Section title={`Expenses by category · ${monthShort(0)}`}><Card><Bars data={data.pie.slice(0, 8).map((p) => ({ label: p.name, value: p.value }))} format={compact} /></Card></Section>
          )}
          {has.attendance && show("attendance_trend") && (
            <Section title="Attendance trend · last 7 days">
              <Card><Columns data={data.trend.map((d) => ({ label: d.label, value: d.present }))} format={(n) => `${n} present`} tone="success" /></Card>
            </Section>
          )}
          {show("compliance_alerts") && (
            <Section title="Compliance · overdue and next 60 days" count={data.alerts.length}>
              <ListCard>
                {data.alerts.map((a, i) => (
                  <Row key={a.id} last={i === data.alerts.length - 1} title={a.title} subtitle={`${a.category} · ${fmtShort(a.due_date)}`} onPress={() => router.push("/compliance")}
                    right={<Badge small label={a.days_remaining < 0 ? `${-a.days_remaining}d overdue` : `${a.days_remaining}d`} tone={a.priority === "critical" ? "danger" : a.priority === "high" ? "warning" : "neutral"} />} />
                ))}
              </ListCard>
              {data.alerts.length === 0 && <T v="small" muted>Nothing due in the next 60 days.</T>}
            </Section>
          )}
          {has.contracts && show("contracts_ending") && (
            <Section title="Contracts ending · next 60 days" count={data.contractsEnding.length}>
              <ListCard>{data.contractsEnding.map((k, i) => <Row key={k.id} last={i === data.contractsEnding.length - 1} title={k.client_name} meta={k.code} onPress={() => router.push(`/contracts/${k.id}`)} right={<Badge small label={`${k.days_left}d left`} tone={k.days_left <= 14 ? "danger" : "warning"} />} />)}</ListCard>
              {data.contractsEnding.length === 0 && <T v="small" muted>No contracts end in the next 60 days.</T>}
            </Section>
          )}
          {has.incidents && show("incidents_recent") && (
            <Section title="Recent incidents · 30 days" count={data.recentIncidents.length}>
              <ListCard>{data.recentIncidents.map((x, i) => <Row key={x.id} last={i === data.recentIncidents.length - 1} title={`${x.code} · ${x.category}`} meta={`${fmtShort(x.occurred_at.slice(0, 10))} · ${x.status.replace(/_/g, " ")}`} onPress={() => router.push("/incidents")} right={<Badge small label={x.severity} tone={SEVERITY[x.severity] ?? "neutral"} solid={x.severity === "critical"} />} />)}</ListCard>
              {data.recentIncidents.length === 0 && <T v="small" muted>No incidents in the last 30 days.</T>}
            </Section>
          )}
          {has.periodClose && show("period_close_status") && (
            <Section title="Period close status">
              <Card>
                <HStack>
                  {data.periodClosedThisMonth ? <Lock size={18} color={t.tone("success").text} /> : <Unlock size={18} color={t.tone("warning").text} />}
                  <T v="small" style={{ flex: 1 }}>{data.periodClosedThisMonth ? `${monthShort(0)} is closed — writes to this month are blocked.` : `${monthShort(0)} is open. ${data.lastClosedMonth ? `Last closed: ${data.lastClosedMonth.slice(0, 7)}.` : "No months closed yet."}`}</T>
                </HStack>
              </Card>
            </Section>
          )}
          <Attachments />
        </>
      )}
    </Screen>
  );
}

/** DashboardAttachments: company-wide saved files, images and links. */
function Attachments() {
  const t = useTheme();
  const { db } = useDB();
  const { profile } = useAuth();
  const { toast, confirm } = useOverlay();
  const isAdmin = profile?.role === "super_admin" || profile?.role === "super_super_admin";
  const [state, setState] = useState<{ notReady: boolean; items: any[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; title: string } | null>(null);
  const load = useCallback(async () => { try { setState(await loadAttachments()); } catch (e) { toast(err(e), "danger"); } }, [toast]);
  useEffect(() => { const h = setTimeout(() => { void load(); }, 0); return () => clearTimeout(h); }, [load]);
  if (!state || state.notReady) return null;
  return (
    <Section title="Saved files & links" count={state.items.length}
      action={<HStack>
        <IconBtn icon={Plus} size={34} label="Upload a file" onPress={async () => {
          try {
            const f = await pickDocument();
            if (!f) return;
            setBusy(true);
            await uploadAttachment(db.company.id, f, profile?.id ?? null); toast("File saved"); await load();
          } catch (e) { toast(err(e), "danger"); } finally { setBusy(false); }
        }} />
        <IconBtn icon={Link2} size={34} label="Add a link" onPress={() => setLink({ url: "", title: "" })} />
      </HStack>}>
      {busy && <ActivityIndicator />}
      <ListCard>
        {state.items.map((a, i) => {
          const href = a.kind === "link" ? a.url : a.storage_path ? attachmentUrl(a.storage_path) : null;
          return (
            <Row key={a.id} last={i === state.items.length - 1} left={a.kind === "link" ? <Link2 size={16} color={t.mutedFg} /> : <Paperclip size={16} color={t.mutedFg} />}
              title={a.title ?? a.file_name ?? a.url} meta={`${a.kind}${a.size_bytes ? ` · ${Math.round(a.size_bytes / 1024)} KB` : ""} · ${fmtShort(String(a.created_at).slice(0, 10))}`}
              onPress={href ? () => Linking.openURL(href).catch(() => toast("Couldn't open it", "danger")) : undefined}
              right={isAdmin || a.created_by === profile?.id ? <IconBtn icon={Trash2} size={32} tone="danger" label="Remove" onPress={async () => {
                if (!(await confirm({ title: "Remove this item?", confirmLabel: "Remove", tone: "danger" }))) return;
                try { await removeAttachment(a); await load(); } catch (e) { toast(err(e), "danger"); }
              }} /> : undefined} />
          );
        })}
      </ListCard>
      {state.items.length === 0 && <T v="small" muted>Nothing saved yet. Upload a file or add a link for the whole company.</T>}
      <Sheet open={!!link} onClose={() => setLink(null)} title="Add a link" footer={<Button full label="Save" disabled={!link?.url.trim()} onPress={async () => {
        if (!link) return;
        try { await addAttachmentLink(db.company.id, link.url, link.title, profile?.id ?? null); setLink(null); await load(); } catch (e) { toast(err(e), "danger"); }
      }} />}>
        <Input label="URL" autoCapitalize="none" keyboardType="url" value={link?.url ?? ""} onChangeText={(s) => link && setLink({ ...link, url: s })} />
        <Input label="Title (optional)" value={link?.title ?? ""} onChangeText={(s) => link && setLink({ ...link, title: s })} />
      </Sheet>
    </Section>
  );
}
