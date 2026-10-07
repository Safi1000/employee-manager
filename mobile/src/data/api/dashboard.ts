// Dashboard (web super-admin/Dashboard.tsx + DashboardAttachments). The same
// twenty reads, region-scoped the same way, folded into the same figures.
import { q, sb } from "./core";
import { fetchAllRows, DASHBOARD_ATTACHMENTS_BUCKET } from "../../lib/web/supabase";
import type { PickedFile } from "./core";
import { File } from "expo-file-system";

const iso = (x: Date) => x.toISOString().slice(0, 10);
const monthRange = (offset: number) => { const d = new Date(); return { start: iso(new Date(d.getFullYear(), d.getMonth() + offset, 1)), end: iso(new Date(d.getFullYear(), d.getMonth() + offset + 1, 0)) }; };
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const daysAhead = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
export const monthShort = (offset: number) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + offset, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" }); };

export type AlertRow = { id: string; title: string; due_date: string; category: string; priority: string; days_remaining: number };
const toAlertRows = (data: any[] | null): AlertRow[] => (data ?? []).map((r) => ({
  id: `${r.kind}-${r.ref_id}`, title: r.label, due_date: r.due_date, category: r.sublabel ?? "",
  priority: r.days_remaining < 0 || r.days_remaining <= 7 ? "critical" : r.days_remaining <= 30 ? "high" : "medium", days_remaining: r.days_remaining,
}));

async function clientNames(ids: string[]) {
  const m = new Map<string, string>();
  if (ids.length) for (const c of await q<any[]>(sb().from("clients").select("id, name").in("id", ids))) m.set(c.id, c.name);
  return m;
}
async function invoiceClients(ids: string[]) {
  const m = new Map<string, string>();
  if (ids.length) for (const i of await q<any[]>(sb().from("invoices").select("id, client_id").in("id", ids))) m.set(i.id, i.client_id);
  return m;
}

export async function loadDashboard(regionId: string | null) {
  const s = sb();
  const reg = <T,>(qb: T) => (regionId ? (qb as any).eq("branch_id", regionId) : qb) as T;
  const { start: mStart, end: mEnd } = monthRange(0);
  const { start: pStart, end: pEnd } = monthRange(-1);
  const today = iso(new Date());
  const periodKey = `${mStart.slice(0, 7)}-01`;
  const [emp, attToday, attYest, attTrend, expMtd, expPrev, psMtd, psPrev, banks, payMtd, compliance, activeContracts, openInc, cats, ending, recentInc, recentPay, empExp, period, periodLast] = await Promise.all([
    reg(s.from("employees").select("id", { count: "exact", head: true }).eq("status", "Active")),
    q<any[]>(reg(s.from("attendance_records").select("status").eq("attendance_date", today))),
    q<any[]>(reg(s.from("attendance_records").select("status").eq("attendance_date", daysAgo(1)))),
    q<any[]>(reg(s.from("attendance_records").select("attendance_date, status").gte("attendance_date", daysAgo(6)).lte("attendance_date", today))),
    q<any[]>(reg(s.from("expenses").select("amount, expense_date, category_id").gte("expense_date", mStart).lte("expense_date", mEnd))),
    q<any[]>(reg(s.from("expenses").select("amount, expense_date").gte("expense_date", pStart).lte("expense_date", pEnd))),
    q<any[]>(reg(s.from("payslips").select("net_salary, disbursed").eq("period_month", periodKey).eq("disbursed", true))),
    q<any[]>(reg(s.from("payslips").select("net_salary, disbursed").eq("period_month", `${pStart.slice(0, 7)}-01`).eq("disbursed", true))),
    q<any[]>(s.from("bank_accounts").select("id, bank_name, balance").order("bank_name")),
    fetchAllRows<any>(() => reg(s.from("invoice_payments").select("client_id, invoice_id, amount, payment_date").gte("payment_date", mStart).lte("payment_date", mEnd)) as any),
    q<any[]>(reg(s.from("compliance_upcoming").select("kind, ref_id, label, sublabel, due_date, days_remaining").in("kind", ["important_date", "contract_end", "client_contract_end"]).lte("days_remaining", 60).order("days_remaining"))),
    s.from("contracts").select("id", { count: "exact", head: true }).eq("status", "active"),
    reg(s.from("incidents").select("id", { count: "exact", head: true }).in("status", ["open", "under_investigation"])),
    q<any[]>(s.from("expense_categories").select("id, name")),
    q<any[]>(s.from("contracts").select("id, contract_code, client_id, end_date").eq("status", "active").not("end_date", "is", null).gte("end_date", today).lte("end_date", daysAhead(60)).order("end_date").limit(10)),
    q<any[]>(reg(s.from("incidents").select("id, incident_code, severity, category, occurred_at, status").gte("occurred_at", daysAgo(30) + "T00:00:00Z").order("occurred_at", { ascending: false }).limit(8))),
    q<any[]>(reg(s.from("invoice_payments").select("id, client_id, invoice_id, amount, payment_date").order("payment_date", { ascending: false }).limit(8))),
    q<any[]>(reg(s.from("compliance_upcoming").select("kind, ref_id, days_remaining").lte("days_remaining", 30))),
    q<any>(s.from("accounting_periods").select("period_month").eq("period_month", periodKey).maybeSingle()),
    q<any>(s.from("accounting_periods").select("period_month").order("period_month", { ascending: false }).limit(1).maybeSingle()),
  ]);
  if ((emp as any).error) throw new Error((emp as any).error.message);
  const attPct = (rows: any[]) => (rows.length === 0 ? 0 : Math.round((rows.filter((r) => r.status === "present").length / rows.length) * 100));
  const trend = Array.from({ length: 7 }, (_, i) => daysAgo(6 - i)).map((d) => {
    const rows = attTrend.filter((r) => r.attendance_date === d);
    return { date: d, label: new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }), present: rows.filter((r) => r.status === "present").length, absent: rows.filter((r) => r.status === "absent").length, leave: rows.filter((r) => r.status === "leave").length };
  });
  const sum = (rows: any[], k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const catMap = new Map(cats.map((c) => [c.id, c.name]));
  const pie = new Map<string, number>();
  for (const e of expMtd) { const n = e.category_id ? catMap.get(e.category_id) ?? "Other" : "Uncategorised"; pie.set(n, (pie.get(n) ?? 0) + Number(e.amount ?? 0)); }
  // Top clients by payment this month; invoice-only payments are traced to their invoice's client.
  const payBy = new Map<string, number>();
  const invOnly: string[] = [];
  for (const r of payMtd) { if (r.client_id) payBy.set(r.client_id, (payBy.get(r.client_id) ?? 0) + Number(r.amount)); else if (r.invoice_id) invOnly.push(r.invoice_id); }
  const invMap = await invoiceClients(invOnly);
  for (const r of payMtd) if (!r.client_id && r.invoice_id) { const cid = invMap.get(r.invoice_id); if (cid) payBy.set(cid, (payBy.get(cid) ?? 0) + Number(r.amount)); }
  const recentInvOnly = recentPay.filter((p) => !p.client_id && p.invoice_id).map((p) => p.invoice_id);
  const recentInvMap = await invoiceClients(recentInvOnly);
  const names = await clientNames([...new Set([...payBy.keys(), ...ending.map((c) => c.client_id).filter(Boolean), ...recentPay.map((p) => p.client_id).filter(Boolean), ...recentInvMap.values()])] as string[]);
  const GUARD_KINDS = new Set(["weapon_licence", "guard_licence", "medical_fitness", "probation_end", "cnic", "weapons_cert", "refresher", "guard_document", "training"]);
  const dueRows = empExp.filter((r) => GUARD_KINDS.has(r.kind));
  const todayDate = new Date(today);
  return {
    employeeCount: (emp as any).count ?? 0,
    attToday: attPct(attToday), attYest: attPct(attYest), trend,
    expensesMtd: sum(expMtd, "amount"), expensesPrev: sum(expPrev, "amount"),
    payrollMtd: sum(psMtd, "net_salary"), payrollPrev: sum(psPrev, "net_salary"),
    banks: banks.map((b) => ({ id: b.id, bank_name: b.bank_name, balance: Number(b.balance ?? 0) })),
    topClients: [...payBy.entries()].map(([id, revenue]) => ({ id, name: names.get(id) ?? "Unknown client", revenue })).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    alerts: toAlertRows(compliance),
    activeContracts: (activeContracts as any).count ?? 0, openIncidents: (openInc as any).count ?? 0,
    licencesExpiring: new Set(dueRows.map((r) => r.ref_id)).size, licencesOverdue: new Set(dueRows.filter((r) => r.days_remaining < 0).map((r) => r.ref_id)).size,
    pie: [...pie.entries()].map(([name, value]) => ({ name, value })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value),
    contractsEnding: ending.map((c) => ({ id: c.id, code: c.contract_code, client_name: c.client_id ? names.get(c.client_id) ?? "—" : "—", end_date: c.end_date, days_left: Math.round((new Date(c.end_date).getTime() - todayDate.getTime()) / 86400000) })),
    recentIncidents: recentInc.map((i) => ({ id: i.id, code: i.incident_code, severity: i.severity, category: i.category, occurred_at: i.occurred_at, status: i.status })),
    recentPayments: recentPay.map((p) => { const cid = p.client_id ?? (p.invoice_id ? recentInvMap.get(p.invoice_id) ?? null : null); return { id: p.id, client_name: cid ? names.get(cid) ?? "Unknown client" : "Unallocated", amount: Number(p.amount ?? 0), payment_date: p.payment_date }; }),
    periodClosedThisMonth: period != null, lastClosedMonth: (periodLast?.period_month ?? null) as string | null,
  };
}
export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;

// ------------------------------------------------------------------ Attachments
// The bucket is private (0508): stored files open through a short-lived signed URL.
export async function attachmentUrl(path: string): Promise<string | null> {
  if (/^(https?:|data:)/.test(path)) return path;
  const { data } = await sb().storage.from(DASHBOARD_ATTACHMENTS_BUCKET).createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}
export async function loadAttachments() {
  const { data, error } = await sb().from("dashboard_attachments").select("*").order("created_at", { ascending: false });
  if (error) {
    if (/does not exist|relation|schema cache|not find the table/i.test(error.message)) return { notReady: true, items: [] as any[] };
    throw new Error(error.message);
  }
  return { notReady: false, items: (data ?? []) as any[] };
}
const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16); });
export async function uploadAttachment(companyId: string, f: PickedFile, profileId: string | null) {
  const ext = f.name.includes(".") ? `.${f.name.split(".").pop()}` : "";
  const path = `${companyId}/${uuid()}${ext}`;
  const bytes = await new File(f.uri).arrayBuffer();
  const { error: upErr } = await sb().storage.from(DASHBOARD_ATTACHMENTS_BUCKET).upload(path, bytes, { upsert: false, contentType: f.type || undefined });
  if (upErr) throw new Error(upErr.message);
  await q(sb().from("dashboard_attachments").insert({
    company_id: companyId, kind: (f.type || "").startsWith("image/") ? "image" : "file", title: f.name, file_name: f.name, storage_path: path,
    mime_type: f.type || null, size_bytes: f.size ?? bytes.byteLength, created_by: profileId,
  } as never));
}
export async function addAttachmentLink(companyId: string, url: string, title: string, profileId: string | null) {
  let u = url.trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  await q(sb().from("dashboard_attachments").insert({ company_id: companyId, kind: "link", url: u, title: title.trim() || null, created_by: profileId } as never));
}
export async function removeAttachment(a: any) {
  if (a.storage_path) await sb().storage.from(DASHBOARD_ATTACHMENTS_BUCKET).remove([a.storage_path]);
  await q(sb().from("dashboard_attachments").delete().eq("id", a.id));
}
