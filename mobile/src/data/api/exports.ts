// Files the web app produces, produced on the phone by the web's OWN generators
// (lib/web, synced verbatim) and handed to the share sheet by lib/saveFile.ts.
import type { Employee } from "../seed";
import { q, sb } from "./core";
import { buildAttendanceRows, type SheetEmployee } from "../../lib/web/attendanceSheet";
import { exportAttendance } from "../../lib/web/excel";
import { guardDisplayCode } from "../../lib/web/guardCode";
import { brandingFromCompany, type PdfBranding } from "../../lib/web/pdfBranding";
import { generateClientAttendancePdf, generateGuardAttendancePdf } from "../../lib/web/attendanceSheetPdf";
import type { BoardRow } from "./attendance";

function sheetEmployee(e: Employee, prefix: string | null): SheetEmployee {
  const r = e.raw ?? {};
  return {
    id: e.id, full_name: e.name, display_code: guardDisplayCode(r, prefix), contract_id: r.contract_id ?? null, client_id: r.client_id ?? null,
    join_date: r.join_date ?? null, last_working_day: r.last_working_day ?? null, termination_date: r.termination_date ?? null,
    lifecycle_state: r.lifecycle_state ?? null, shift: r.shift ?? null,
  };
}

/** One employee's month through the same sheet builder + Excel writer as the web Timesheet export. */
export async function exportEmployeeTimesheet(e: Employee, month: string) {
  const r = e.raw ?? {};
  const [client, contracts] = await Promise.all([
    r.client_id ? q<any>(sb().from("clients").select("id, name, employee_id_prefix, allowed_leaves_per_month").eq("id", r.client_id).maybeSingle()) : Promise.resolve(null),
    r.client_id ? q<any[]>(sb().from("contracts").select("id, allowed_leaves_per_month").eq("client_id", r.client_id)) : Promise.resolve([]),
  ]);
  const built = await buildAttendanceRows({ month, employees: [sheetEmployee(e, client?.employee_id_prefix ?? null)], contracts: contracts as any[], clients: client ? [client] : [] });
  await exportAttendance({ monthLabel: built.monthLabel, daysInMonth: built.daysInMonth, clientLabel: e.name, rows: built.rows, fileName: `Attendance ${e.name} ${built.monthLabel}.xlsx` });
}

// ---------------------------------------------------------------- branding

/**
 * jsPDF on the web can addImage() a URL; on the phone it cannot fetch one, so
 * any image the generators draw is inlined as a data URL first.
 */
export async function toDataUrl(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

let brandingCache: { companyId: string; company: any; branding: PdfBranding } | null = null;
/** Drop the cached branding after the company's invoice identity changes. */
export const resetBranding = () => { brandingCache = null; };

/** The web's brandingFromCompany(company), with the logo inlined. Cached per company. */
export async function loadBranding(companyId: string): Promise<{ company: any; branding: PdfBranding }> {
  if (brandingCache?.companyId === companyId) return brandingCache;
  const company = await q<any>(sb().from("companies").select("*").eq("id", companyId).single());
  const b = brandingFromCompany(company);
  const logo = await toDataUrl(b.logoUrl);
  brandingCache = { companyId, company: { ...company, logo_url: logo, stamp_url: await toDataUrl(company?.stamp_url) }, branding: { ...b, logoUrl: logo } };
  return brandingCache;
}

// ---------------------------------------------------------------- Attendance board (§8.9 ExportMenu)
/** exportClientSheet(): per-client attendance sheet for the day. */
export async function exportBoardClientSheet(companyId: string, date: string, rows: BoardRow[]) {
  const { branding } = await loadBranding(companyId);
  generateClientAttendancePdf(branding, date, rows.map((r) => ({
    client_name: r.client_name, site_name: r.site_name, shift_code: r.shift_code, contracted: r.contracted, on_roster: r.roster.length,
    status: r.confirmation ? "confirmed" : r.marks.size > 0 ? "reported" : "awaiting",
    exceptions: [...r.marks.values()].map((m) => m.status).join("; "), supervisor: r.confirmation?.supervisor_name ?? "",
  })));
}

/** exportGuardSheet(): one row per rostered guard, for payroll. */
export async function exportBoardGuardSheet(companyId: string, date: string, rows: BoardRow[]) {
  const { branding } = await loadBranding(companyId);
  const gr: { full_name: string; code: string; client_name: string; site_name: string; shift_code: string; status: string }[] = [];
  for (const r of rows) for (const g of r.roster) {
    gr.push({ full_name: g.full_name, code: g.code, client_name: r.client_name, site_name: r.site_name, shift_code: g.scheduled_shift, status: r.marks.get(g.guard_id)?.status ?? "present" });
  }
  generateGuardAttendancePdf(branding, date, gr);
}

// ---------------------------------------------------------------- Employee documents
// The web's EMPLOYEE_FULL_SELECT: the whole record plus the three names the
// export and the form print.
const EMPLOYEE_FULL_SELECT = "*, location:location_id(name), client:client_id(name), branch:branch_id(name)";
const fullRow = (e: any) => ({ ...e, location_name: e.location?.name ?? null, client_name: e.client?.name ?? null, branch_name: e.branch?.name ?? null });

async function hydrateRows(ids: string[]) {
  const byId = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 150) {
    for (const e of await q<any[]>(sb().from("employees").select(EMPLOYEE_FULL_SELECT).in("id", ids.slice(i, i + 150)))) byId.set(e.id, fullRow(e));
  }
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/** runExport(): the chosen field list → Employees.xlsx, header, cell and width from the same fields. */
export async function exportEmployeesXlsx(ids: string[], fieldIds: string[], clients: { id: string; raw?: any }[]) {
  const { EMPLOYEE_EXPORT_FIELDS } = await import("../../lib/web/employeeExportFields");
  const { lifecycleStatusLabel } = await import("../../lib/web/employmentWindow");
  const { exportTable } = await import("../../lib/web/excel");
  const byId = new Map(EMPLOYEE_EXPORT_FIELDS.map((f) => [f.id, f]));
  const fields = fieldIds.map((id) => byId.get(id)).filter((f): f is NonNullable<typeof f> => f != null);
  if (fields.length === 0) throw new Error("Pick at least one column.");
  const prefix = (cid: string | null) => clients.find((c) => c.id === cid)?.raw?.employee_id_prefix ?? null;
  const ctx = {
    displayCode: (e: any) => guardDisplayCode(e, prefix(e.client_id)),
    clientOrCategory: (e: any) => ((e.category ?? "client") === "client" ? e.client_name ?? "" : (e.category ?? "client").replace("_", " ")),
    statusLabel: (e: any) => lifecycleStatusLabel(e),
  };
  const rows = await hydrateRows(ids);
  await exportTable({ fileName: "Employees.xlsx", sheetName: "Employees", title: "Employees", headers: fields.map((f) => f.label), rows: rows.map((e) => fields.map((f) => f.value(e, ctx as never))), columnWidths: fields.map((f) => f.width) });
}

/** buildApprovals(): the four §4 approval blocks from employee_approval_events. */
async function buildApprovals(employeeId: string) {
  const data = await q<any[]>(sb().from("employee_approval_events").select("action, changed_at, approver:approved_by(full_name, role)").eq("employee_id", employeeId).order("changed_at"));
  const out: Record<string, { name: string; date: string }> = {};
  for (const ev of data) {
    const name = ev.approver?.full_name ?? "";
    const role = ev.approver?.role ?? "";
    const date = String(ev.changed_at).slice(0, 10);
    if (ev.action === "ops_verify") { if (role === "ops_director") out.director_ops = { name, date }; else out.manager_ops = { name, date }; }
    else if (ev.action === "finance_approve") out.director_finance = { name, date };
  }
  return out;
}

async function formParts(employeeId: string) {
  const [children, references, jobs, checklist, approvals] = await Promise.all([
    q<any[]>(sb().from("employee_children").select("*").eq("employee_id", employeeId).order("created_at")),
    q<any[]>(sb().from("employee_references").select("*").eq("employee_id", employeeId)),
    q<any[]>(sb().from("employee_previous_jobs").select("*").eq("employee_id", employeeId).order("seq")),
    q<any[]>(sb().from("employee_document_checklist").select("*").eq("employee_id", employeeId).order("doc_type")),
    buildApprovals(employeeId),
  ]);
  return { children, references, jobs, checklist, approvals };
}

/** downloadFormPdf(): the branded two-page data form. */
export async function downloadEmployeeForm(companyId: string, employeeId: string) {
  const { generateEmployeeFormPdf } = await import("../../lib/web/employeeFormPdf");
  const [{ branding }, rec, parts] = await Promise.all([
    loadBranding(companyId), q<any>(sb().from("employees").select(EMPLOYEE_FULL_SELECT).eq("id", employeeId).single()), formParts(employeeId),
  ]);
  generateEmployeeFormPdf({ employee: fullRow(rec), branding, ...parts } as never);
}

async function idCardArgs(e: any, prefix: string | null, branding: PdfBranding) {
  return {
    branding, full_name: e.full_name, guard_code: e.guard_code ?? e.employee_code, display_code: guardDisplayCode(e, prefix),
    company_id_card_number: e.company_id_card_number, designation: e.designation, client_name: e.client_name, cnic_number: e.cnic_number,
    // jsPDF on the phone needs the photo inline, as the logo already is.
    photo_url: await toDataUrl(e.photo_url),
  };
}

/** One guard's ID card. */
export async function downloadIdCard(companyId: string, employeeId: string, clients: { id: string; raw?: any }[]) {
  const { generateIdCardPdf } = await import("../../lib/web/idCardPdf");
  const [{ branding }, rec] = await Promise.all([loadBranding(companyId), q<any>(sb().from("employees").select(EMPLOYEE_FULL_SELECT).eq("id", employeeId).single())]);
  const e = fullRow(rec);
  generateIdCardPdf((await idCardArgs(e, clients.find((c) => c.id === e.client_id)?.raw?.employee_id_prefix ?? null, branding)) as never);
}

/** BulkGenerateModal run(): one combined PDF, a failure per guard reported, the batch continues. */
export async function bulkGenerateDocs(companyId: string, ids: string[], docType: "data_form" | "id_card", clients: { id: string; raw?: any }[], onProgress: (n: number) => void) {
  const [{ default: jsPDF }, { generateEmployeeFormPdf }, { generateIdCardPdf }, { savePdf }] = await Promise.all([
    import("jspdf"), import("../../lib/web/employeeFormPdf"), import("../../lib/web/idCardPdf"), import("../../lib/saveFile"),
  ]);
  const { branding } = await loadBranding(companyId);
  const combined = new jsPDF({ unit: "mm", format: "a4" });
  let started = false;
  const fails: string[] = [];
  let done = 0;
  for (const id of ids) {
    let name = id;
    try {
      const e = fullRow(await q<any>(sb().from("employees").select(EMPLOYEE_FULL_SELECT).eq("id", id).single()));
      name = e.full_name;
      if (started) combined.addPage();
      if (docType === "data_form") generateEmployeeFormPdf({ employee: e, branding, ...(await formParts(id)), doc: combined } as never);
      else generateIdCardPdf({ ...(await idCardArgs(e, clients.find((c) => c.id === e.client_id)?.raw?.employee_id_prefix ?? null, branding)), doc: combined } as never);
      started = true;
    } catch (x) { fails.push(`${name}: ${(x as Error).message ?? String(x)}`); }
    onProgress(++done);
  }
  if (started) await savePdf(combined, `${docType === "data_form" ? "data-forms" : "id-cards"}-${ids.length}.pdf`);
  return fails;
}
