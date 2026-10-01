// Compliance (web Compliance.tsx, Licences.tsx, ContractRenewals.tsx,
// ComplianceCases.tsx, Alerts.tsx, Documents.tsx). Views are READ, not
// recomputed: compliance_upcoming, vetting_dashboard, warning_alerts,
// dashboard_alerts, compliance_jurisdiction_register.
import { driveDelete, q, sb } from "./core";

/**
 * 0385: a bare UPDATE under RLS affects zero rows and raises nothing. Ask for
 * the rows back and treat none as the refusal it is, naming the permission.
 */
async function expectRows(p: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, needs: string) {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error(`That change was not saved — it needs the ${needs} permission. Nothing has been recorded.`);
}

// ---------- important dates / recurring alerts ----------
export type DateForm = { title: string; due_date: string; category: string; priority: string; advance_notice_days: string; notes: string };
export type RecForm = { name: string; category: string; frequency: string; trigger_day: string; advance_notice_days: string; active: boolean; notes: string };

function checkDate(f: DateForm) {
  if (!f.title.trim()) throw new Error("Title is required.");
  if (!f.due_date) throw new Error("Due date is required.");
  const adv = Number(f.advance_notice_days);
  if (Number.isNaN(adv) || adv < 0) throw new Error("Advance notice must be 0 or more days.");
}
function checkRec(f: RecForm) {
  if (!f.name.trim()) throw new Error("Name is required.");
  if (!f.trigger_day.trim()) throw new Error("Trigger day is required.");
  const adv = Number(f.advance_notice_days);
  if (Number.isNaN(adv) || adv < 0) throw new Error("Advance notice must be 0 or more days.");
}
const datePayload = (f: DateForm) => ({
  title: f.title.trim(), due_date: f.due_date, category: f.category, priority: f.priority,
  advance_notice_days: Number(f.advance_notice_days), notes: f.notes.trim() || null,
});
const recPayload = (f: RecForm) => ({
  name: f.name.trim(), category: f.category, frequency: f.frequency, trigger_day: f.trigger_day.trim(),
  advance_notice_days: Number(f.advance_notice_days), active: f.active, notes: f.notes.trim() || null,
});

export async function saveImportantDate(id: string | null, f: DateForm) {
  checkDate(f);
  if (id) await q(sb().from("important_dates").update({ ...datePayload(f), updated_at: new Date().toISOString() } as never).eq("id", id));
  else await q(sb().from("important_dates").insert(datePayload(f) as never));
}
export const deleteImportantDate = (id: string) => q(sb().from("important_dates").delete().eq("id", id));

export async function saveRecurringAlert(id: string | null, f: RecForm) {
  checkRec(f);
  if (id) await q(sb().from("recurring_alerts").update({ ...recPayload(f), updated_at: new Date().toISOString() } as never).eq("id", id));
  else await q(sb().from("recurring_alerts").insert(recPayload(f) as never));
}
export const deleteRecurringAlert = (id: string) => q(sb().from("recurring_alerts").delete().eq("id", id));
export const toggleRecurringAlert = (id: string, active: boolean) =>
  q(sb().from("recurring_alerts").update({ active, updated_at: new Date().toISOString() } as never).eq("id", id));

// ---------- read-only views ----------
export type UpcomingRow = { kind: string; ref_id: string; label: string; sublabel: string | null; due_date: string; notice_days: number; days_remaining: number };
export const loadUpcoming = () => q<UpcomingRow[]>(sb().from("compliance_upcoming").select("kind, ref_id, label, sublabel, due_date, notice_days, days_remaining").order("days_remaining"));

export type VettingRow = { region_name: string; total: number; police_cleared: number; police_pending: number; police_adverse: number; police_not_recorded: number; nadra_cleared: number; cnic_number_recorded: number; cnic_expiry_recorded: number };
export const loadVetting = () => q<VettingRow[]>(sb().from("vetting_dashboard").select("region_name, total, police_cleared, police_pending, police_adverse, police_not_recorded, nadra_cleared, cnic_number_recorded, cnic_expiry_recorded"));

// ---------- alerts ----------
export async function loadAlerts(companyId: string) {
  const [al, wa, da] = await Promise.all([
    q<any[]>(sb().from("alerts").select("*").eq("company_id", companyId).eq("state", "open").order("created_at", { ascending: false })),
    q<any[]>(sb().from("warning_alerts").select("*").eq("company_id", companyId)),
    q<any[]>(sb().from("dashboard_alerts").select("*").eq("company_id", companyId)),
  ]);
  return { alerts: al, warnings: wa, dashboard: da };
}
/** A blocking alert needs an override reason; a warning is simply acknowledged. */
export async function acknowledgeAlert(id: string, blocking: boolean, reason: string) {
  if (blocking && !reason.trim()) throw new Error("An override reason is required for a blocking alert.");
  await q(sb().rpc("acknowledge_alert" as never, { p_alert_id: id, p_override_reason: blocking ? reason.trim() : null } as never));
}

// ---------- renewal pipeline ----------
export const RENEWAL_STAGES = ["not_started", "contacted", "negotiating", "renewed", "lost"] as const;
export const loadRenewals = (companyId: string) => q<any[]>(sb().from("renewal_pipeline").select("*").eq("company_id", companyId).order("expected_close_date"));
export async function addRenewal(companyId: string, clientId: string, expected: string) {
  if (!clientId) throw new Error("Pick a client.");
  await q(sb().from("renewal_pipeline").insert({ company_id: companyId, client_id: clientId, stage: "not_started", expected_close_date: expected || null } as never));
}
export const setRenewalStage = (id: string, stage: string) => q(sb().from("renewal_pipeline").update({ stage } as never).eq("id", id));

// ---------- cases, filings, visits ----------
export const CASE_STAGES = ["not_started", "submitted", "verification", "follow_up", "issued"] as const;
export const JURISDICTIONS = ["ict", "punjab", "federal", "sindh", "kpk", "balochistan", "ajk", "other"] as const;
export const CASE_TYPES = ["licence", "renewal", "noc", "registration", "other"] as const;
export const FILING_TYPES = ["eobi", "social_security", "withholding_tax", "income_tax", "other"] as const;
export const nextStage = (s: string) => {
  const i = CASE_STAGES.indexOf(s as never);
  return i >= 0 && i < CASE_STAGES.length - 1 ? CASE_STAGES[i + 1]! : null;
};

export async function loadCases(companyId: string) {
  const [cs, rg, fl] = await Promise.all([
    q<any[]>(sb().from("compliance_cases").select("*").eq("company_id", companyId).order("target_date", { ascending: true })),
    q<any[]>(sb().from("compliance_jurisdiction_register").select("*").eq("company_id", companyId)),
    q<any[]>(sb().from("statutory_filings").select("*").eq("company_id", companyId).order("due_date", { ascending: false })),
  ]);
  return { cases: cs, register: rg, filings: fl };
}
export async function addCase(f: { title: string; case_type: string; jurisdiction: string; authority: string; target_date: string }) {
  if (!f.title.trim()) throw new Error("A case needs a title.");
  await expectRows(sb().from("compliance_cases").insert({ title: f.title, case_type: f.case_type, jurisdiction: f.jurisdiction, authority: f.authority || null, target_date: f.target_date || null } as never).select("id"), "compliance.edit");
}
export async function advanceCase(id: string, stage: string) {
  const next = nextStage(stage);
  if (!next) throw new Error("This case is already at its last stage.");
  await expectRows(sb().from("compliance_cases").update({ stage: next } as never).eq("id", id).select("id"), "compliance.edit");
}
export async function addFiling(f: { filing_type: string; period_month: string; due_date: string; amount: string }) {
  if (!f.period_month || !f.due_date) throw new Error("Period and due date are required.");
  await expectRows(sb().from("statutory_filings").insert({ filing_type: f.filing_type, period_month: f.period_month, due_date: f.due_date, amount: f.amount ? Number(f.amount) : null } as never).select("id"), "compliance.filings");
}
export const markFiled = (id: string) => expectRows(sb().from("statutory_filings").update({ filed_date: new Date().toISOString().slice(0, 10) } as never).eq("id", id).select("id"), "compliance.filings");
export const markPaid = (id: string) => expectRows(sb().from("statutory_filings").update({ paid_date: new Date().toISOString().slice(0, 10) } as never).eq("id", id).select("id"), "compliance.filings");

export const loadVisits = (caseId: string) => q<any[]>(sb().from("compliance_case_visits").select("*").eq("case_id", caseId).order("visit_date", { ascending: false }));
export async function addVisit(companyId: string, caseId: string, f: { date: string; outcome: string; next_action: string; next_date: string }) {
  if (!f.outcome.trim()) throw new Error("Record the outcome of the visit.");
  await q(sb().from("compliance_case_visits").insert({ company_id: companyId, case_id: caseId, visit_date: f.date, outcome: f.outcome, next_action: f.next_action || null, next_action_date: f.next_date || null } as never));
}

// ---------- documents ----------
export const loadAllDocuments = () => q<any[]>(sb().from("employee_documents").select("id, employee_id, doc_type, file_name, uploaded_at, drive_file_id, drive_view_url").order("uploaded_at", { ascending: false }));
export async function deleteDocument(doc: { id: string; drive_file_id?: string | null }) {
  if (doc.drive_file_id) await driveDelete(doc.drive_file_id);
  await q(sb().from("employee_documents").delete().eq("id", doc.id));
}
