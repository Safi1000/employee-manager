// People. Every function here is a port of one handler in the web app's
// EmployeeManagement.tsx / FireGuardModal.tsx / DisciplinaryWarningsModal.tsx —
// same RPCs, same payloads, same order — named in each comment.
import type { Employee } from "../seed";
import { daysInCurrentMonth, driveDelete, driveUpload, nn, PickedFile, q, rpc, sb, todayIso } from "./core";

/** Web displayCodeFor(): client prefix + display number, else the permanent code. */
export function displayCode(e: Employee, clients: { id: string; raw?: any }[]): string {
  const r = e.raw ?? {};
  const fallback = r.guard_code ?? r.employee_code ?? e.code;
  if (r.display_number == null || !r.client_id) return fallback;
  const prefix = clients.find((c) => c.id === r.client_id)?.raw?.employee_id_prefix;
  if (!prefix) return fallback;
  return `${prefix}-${String(r.display_number).padStart(3, "0")}`;
}

/** The fields the phone's employee form holds. Anything else on the row is left alone. */
export type EmployeeFields = {
  full_name: string; father_or_husband_name: string; cnic_number: string; cnic_expiry: string; date_of_birth: string;
  phone: string; current_address: string; blood_group: string; education: string;
  category: "client" | "office_staff" | "reliever"; department: string; shift: string; branch_id: string; join_date: string;
  physical_copy_present: boolean;
  bank_name: string; account_title: string; bank_account: string; bank_branch_code: string; iban: string;
  emergency_contact_name: string; emergency_contact_phone: string;
  is_ex_serviceman: boolean; police_verification_status: string; nadra_verisys_status: string;
};

const payload = (f: EmployeeFields) => ({
  full_name: f.full_name.trim(),
  father_or_husband_name: nn(f.father_or_husband_name),
  cnic_number: nn(f.cnic_number),
  cnic_expiry: f.cnic_expiry || null,
  date_of_birth: f.date_of_birth || null,
  phone: nn(f.phone),
  current_address: nn(f.current_address),
  blood_group: f.blood_group || null,
  education: f.education || null,
  category: f.category,
  department: nn(f.department),
  shift: f.shift,
  branch_id: f.branch_id || null,
  join_date: f.join_date || null,
  physical_copy_present: f.physical_copy_present,
  bank_name: nn(f.bank_name),
  account_title: nn(f.account_title),
  bank_account: nn(f.bank_account),
  bank_branch_code: nn(f.bank_branch_code),
  iban: nn(f.iban),
  emergency_contact_name: nn(f.emergency_contact_name),
  emergency_contact_phone: nn(f.emergency_contact_phone),
  is_ex_serviceman: f.is_ex_serviceman,
  police_verification_status: f.police_verification_status || "pending",
  nadra_verisys_status: f.nadra_verisys_status || "pending",
});

/**
 * handleAdd(). The client posting, guard code, display number and opening
 * salary are issued on the first assignment (Assignments & Pay), exactly as the
 * web: this insert creates an unassigned record.
 */
export async function addEmployee(f: EmployeeFields, base: string, allowance: string) {
  const b = Number(base);
  return q(sb().from("employees").insert({
    ...payload(f), client_id: null, contract_id: null, contract_line_id: null,
    base_salary: base ? b : null,
    // computePerDay(): base ÷ days in the current month, to 2 dp.
    per_day_salary: base && b > 0 ? Number((b / daysInCurrentMonth()).toFixed(2)) : null,
    allowance: allowance ? Math.max(0, Number(allowance)) : 0,
  } as never).select("id").single());
}

/**
 * handleEdit(). Salary is NOT written here — the web routes every change through
 * the dated set_employee_salary. Posting (client) is not changed here either:
 * that is Change client. When `hire` is set the record is promoted through the
 * lifecycle RPC after the update lands, so the record that becomes active is the
 * completed one.
 */
export async function updateEmployee(e: Employee, f: EmployeeFields, hire = false) {
  const patch: Record<string, unknown> = { ...payload(f) };
  // Leaving the client category clears the posting, as the web's update does.
  if (f.category !== "client") { patch.client_id = null; patch.contract_id = null; patch.contract_line_id = null; }
  if (hire) patch.status = "Active";
  await q(sb().from("employees").update(patch as never).eq("id", e.id));
  if (hire) await rpc("transition_employee_lifecycle", { p_employee_id: e.id, p_to_state: "active" });
}

/** SalaryIncrement apply(): a dated change, per-day = base ÷ days this month. */
export async function setSalary(e: Employee, base: number, allowance: number, effectiveDate: string, reason: string) {
  if (!base || base <= 0) throw new Error("Enter a valid new base salary.");
  if (!effectiveDate) throw new Error("Pick an effective date.");
  await rpc("set_employee_salary", {
    p_employee_id: e.id, p_effective_date: effectiveDate, p_base_salary: base,
    p_allowance: Math.max(0, allowance || 0), p_per_day_salary: base / daysInCurrentMonth(), p_reason: reason.trim() || "Increment",
  });
}

async function logCode(e: Employee, oldCode: string, newCode: string, clientId: string | null, reason: string) {
  await q(sb().from("employee_code_history").insert({
    company_id: e.raw?.company_id, employee_id: e.id, old_code: oldCode, new_code: newCode, client_id: clientId, reason,
  } as never));
}

export type MoveReason = "relief_cover" | "return_to_pool" | "separation" | "shift_change" | "new_hire";

/** ChangeClientModal save(): dated posting move; a real client change renumbers and logs. */
export async function changeClient(e: Employee, clients: { id: string; raw?: any }[], args: { clientId: string; lineId?: string | null; siteId?: string | null; reason: MoveReason; effectiveDate: string }) {
  if (!args.clientId) throw new Error("Select a client.");
  const oldDisplay = displayCode(e, clients);
  const clientChanged = args.clientId !== (e.raw?.client_id ?? "");
  await rpc("change_client", {
    p_guard_id: e.id, p_new_client_id: args.clientId, p_contract_line_id: args.lineId || null,
    p_site_id: args.siteId || null, p_reason: args.reason, p_effective_date: args.effectiveDate || null,
  });
  if (clientChanged) {
    const newDisp = await rpc<string | null>("assign_display_number", { p_employee_id: e.id });
    await logCode(e, oldDisplay, newDisp ?? e.raw?.guard_code ?? e.raw?.employee_code, args.clientId, "reassigned");
  }
}

const CATEGORY_LABEL: Record<string, string> = { client: "Client", office_staff: "Office Staff", reliever: "Reliever" };

/** ChangeCategoryModal save(). */
export async function changeCategory(e: Employee, clients: { id: string; raw?: any }[], args: { category: "client" | "office_staff" | "reliever"; clientId?: string | null; lineId?: string | null; siteId?: string | null; effectiveDate: string }) {
  const current = e.raw?.category ?? e.category;
  const toClient = args.category === "client";
  if (args.category === current && !(toClient && args.clientId !== (e.raw?.client_id ?? ""))) throw new Error("Pick a different category (or a different client).");
  if (toClient && !args.clientId) throw new Error("Select a client to move this employee to.");
  const oldDisplay = displayCode(e, clients);
  await rpc("change_category", {
    p_guard_id: e.id, p_new_category: args.category, p_new_client_id: toClient ? args.clientId : null,
    p_contract_line_id: toClient ? args.lineId || null : null, p_effective_date: args.effectiveDate || null,
    p_site_id: toClient ? args.siteId || null : null,
  });
  const permanent = e.raw?.guard_code ?? e.raw?.employee_code ?? e.code;
  let newDisplay = permanent;
  if (toClient) newDisplay = (await rpc<string | null>("assign_display_number", { p_employee_id: e.id })) ?? permanent;
  await logCode(e, oldDisplay, newDisplay, toClient ? args.clientId ?? null : null, `category: ${CATEGORY_LABEL[current] ?? current} → ${CATEGORY_LABEL[args.category]}`);
}

/** ChangeShiftModal save(). */
export async function changeShift(e: Employee, newShift: string, effectiveDate: string) {
  if (!newShift) throw new Error("Select a shift.");
  if (newShift === (e.raw?.shift ?? e.shift)) throw new Error("Pick a different shift from the current one.");
  if (!effectiveDate) throw new Error("An effective date is required.");
  await rpc("change_guard_shift", { p_guard: e.id, p_new_shift: newShift, p_effective_date: effectiveDate });
}

/** The shifts a guard can move to: their site's contract lines + shift definitions + current (web ChangeShiftModal). */
export async function shiftOptions(e: Employee): Promise<string[]> {
  const codes = new Set<string>([e.raw?.shift ?? e.shift]);
  if (e.site_id) {
    const [lines, defs] = await Promise.all([
      q<any[]>(sb().from("contract_lines").select("shift_code, billed_qty").eq("site_id", e.site_id)),
      q<any[]>(sb().from("shift_definitions").select("shift_code").eq("site_id", e.site_id)),
    ]);
    for (const l of lines) if ((Number(l.billed_qty) || 0) > 0 && l.shift_code) codes.add(l.shift_code);
    for (const d of defs) codes.add(d.shift_code);
  }
  const order = ["day", "evening", "night"];
  return [...codes].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
}

export type ClearanceGates = { outstanding_kit_count: number; outstanding_advance: number; open_incident_count: number; undisbursed_salary: number };

export async function clearanceGates(employeeId: string): Promise<ClearanceGates | null> {
  const data = await rpc<any>("employee_clearance_gates", { p_employee_id: employeeId });
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    outstanding_kit_count: Number(row.outstanding_kit_count ?? 0), outstanding_advance: Number(row.outstanding_advance ?? 0),
    open_incident_count: Number(row.open_incident_count ?? 0), undisbursed_salary: Number(row.undisbursed_salary ?? 0),
  };
}

/**
 * FireGuardModal confirm(). The picked date is the EFFECTIVE date — the post is
 * empty that day — so the last working day is the day before, in UTC arithmetic.
 */
export async function separate(e: Employee, args: { type: "firing" | "resignation"; date: string; eligible: boolean; reason: string }) {
  if (!args.reason.trim()) throw new Error("A reason is required.");
  if (!args.date) throw new Error("An effective (fire) date is required.");
  const lwd = new Date(args.date + "T00:00:00Z");
  lwd.setUTCDate(lwd.getUTCDate() - 1);
  await rpc("record_separation", {
    p_guard: e.id, p_reason: args.type === "resignation" ? "resignation" : "termination_misconduct",
    p_last_working_day: lwd.toISOString().slice(0, 10), p_termination_date: args.date,
    p_rehire_eligible: args.eligible, p_note: args.reason.trim(),
  });
  await rpc("assess_clearance", { p_employee_id: e.id });
}

/** RehireModal save(): rehire, new display number, salary effective from the join date. */
export async function rehire(e: Employee, args: { joinDate: string; clientId: string; base: string; allowance: string }) {
  if (!args.clientId) throw new Error("Select the client to rehire into.");
  await rpc("rehire_guard", { p_guard: e.id, p_join_date: args.joinDate, p_client_id: args.clientId });
  await rpc("assign_display_number", { p_employee_id: e.id });
  if (args.base) {
    await rpc("set_employee_salary", {
      p_employee_id: e.id, p_effective_date: args.joinDate, p_base_salary: Number(args.base),
      p_allowance: args.allowance ? Math.max(0, Number(args.allowance)) : 0,
      p_per_day_salary: Number(args.base) / daysInCurrentMonth(), p_reason: "Rehire",
    });
  }
}

// ---------- disciplinary warnings (DisciplinaryWarningsModal) ----------
export type Warning = { id: string; warning_number: number | null; issued_on: string; reason: string; rescinded: boolean };

export async function loadWarnings(employeeId: string): Promise<Warning[]> {
  return q(sb().from("disciplinary_warnings").select("id, warning_number, issued_on, reason, rescinded").eq("employee_id", employeeId).order("issued_on", { ascending: false }));
}
export async function issueWarning(employeeId: string, reason: string) {
  if (!reason.trim()) throw new Error("Describe what happened.");
  await q(sb().from("disciplinary_warnings").insert({ employee_id: employeeId, reason: reason.trim() } as never));
}
export async function rescindWarning(id: string) {
  await q(sb().from("disciplinary_warnings").update({ rescinded: true } as never).eq("id", id));
}

// ---------- identity (IdentityPanel) ----------
export const verifyIdentity = (id: string) => rpc("verify_employee_identity", { p_employee_id: id });
export async function unverifyIdentity(id: string, reason: string) {
  if (!reason.trim()) throw new Error("A reason is required to unverify.");
  await rpc("unverify_employee_identity", { p_employee_id: id, p_reason: reason.trim() });
}

// ---------- the profile's history panels ----------
export async function loadEmployeeHistory(employeeId: string) {
  const [codes, salary, docs] = await Promise.all([
    q<any[]>(sb().from("employee_code_history").select("old_code, new_code, reason, changed_at, client_id").eq("employee_id", employeeId).order("changed_at", { ascending: false })),
    q<any[]>(sb().from("employee_salary_history").select("effective_date, base_salary, allowance, reason").eq("employee_id", employeeId).order("effective_date", { ascending: false })),
    q<any[]>(sb().from("employee_documents").select("id, file_name, doc_type, uploaded_at, drive_view_url, storage_path").eq("employee_id", employeeId).order("uploaded_at", { ascending: false })),
  ]);
  return { codes, salary, docs };
}

export const today = todayIso;

export type TransferDest = "branch" | "client" | "site" | "office_staff" | "reliever";

/**
 * TransferModal save() (EmployeeAssignments.tsx). A branch move sets the region
 * directly; every other destination is one change_category call — a site move
 * stays on the same client (no new number, no history row), a client move gets
 * a new client-scoped number and is logged.
 */
export async function transfer(e: Employee, clients: { id: string; raw?: any }[], args: {
  dest: TransferDest; branchId?: string; clientId?: string; siteId?: string; lineId?: string; effectiveDate: string; hasSites: boolean;
}) {
  const r = e.raw ?? {};
  if (args.dest === "branch") {
    if (!args.branchId) throw new Error("Pick the branch to transfer to.");
    if (args.branchId === (r.branch_id ?? "")) throw new Error("That is the branch they're already in.");
    await q(sb().from("employees").update({ branch_id: args.branchId } as never).eq("id", e.id));
    return;
  }
  const toClient = args.dest === "client";
  const toSite = args.dest === "site";
  if (toClient && !args.clientId) throw new Error("Pick the client to transfer to.");
  if (toSite && !r.client_id) throw new Error("This employee isn't posted to a client, so there's no site to move within.");
  if ((toClient || toSite) && args.hasSites && !args.siteId) throw new Error("Pick the site to transfer to.");
  if (!args.effectiveDate) throw new Error("Pick an effective date.");
  if (args.effectiveDate > todayIso()) throw new Error("An effective date in the future is not supported — the transfer takes effect immediately.");
  if (toClient && args.clientId === (r.client_id ?? "")) throw new Error("That is the client they are already on.");
  const onClient = toClient || toSite;
  const oldDisplay = displayCode(e, clients);
  await rpc("change_category", {
    p_guard_id: e.id, p_new_category: onClient ? "client" : args.dest,
    p_new_client_id: toClient ? args.clientId : toSite ? r.client_id : null,
    p_contract_line_id: onClient ? args.lineId || null : null, p_effective_date: args.effectiveDate,
    p_site_id: onClient ? args.siteId || null : null,
  });
  if (toClient) {
    const newDisp = await rpc<string | null>("assign_display_number", { p_employee_id: e.id });
    await logCode(e, oldDisplay, newDisp ?? r.guard_code ?? r.employee_code, args.clientId!, "reassigned");
  }
}

/** Web linesForSite(): a site's own lines plus the client's contract-wide (site-less) lines. */
export function linesForSite(contracts: { client_id: string; status: string; lines: { id: string; category: string; committed: number; active: number; raw?: any }[] }[], clientId: string, siteId: string | null) {
  return contracts
    .filter((k) => k.client_id === clientId && k.status === "active")
    .flatMap((k) => k.lines)
    .filter((l) => !siteId || !l.raw?.site_id || l.raw.site_id === siteId);
}

// ---------- documents (uploadDoc / replaceDoc) ----------

export const EMPLOYEE_DOC_TYPES = ["CNIC", "Police Verification", "Other"] as const;

/** CNIC and Police Verification replace the existing file; Other is appended — as the web's uploadDocs(). */
export async function uploadEmployeeDoc(e: Employee, company: { id: string; name: string }, docType: string, file: PickedFile) {
  if (!company.id || !company.name) throw new Error("Company not loaded — refresh and try again.");
  if (docType !== "Other") {
    const existing = await q<any[]>(sb().from("employee_documents").select("id, drive_file_id").eq("employee_id", e.id).eq("doc_type", docType));
    if (existing.length) {
      await Promise.all(existing.filter((d) => d.drive_file_id).map((d) => driveDelete(d.drive_file_id)));
      await q(sb().from("employee_documents").delete().in("id", existing.map((d) => d.id)));
    }
  }
  const up = await driveUpload(file, {
    category: "employees", company_id: company.id, company_name: company.name, entity_id: e.id,
    entity_code: e.raw?.employee_code ?? e.permanent_code, entity_name: e.name, doc_type: docType,
  });
  await q(sb().from("employee_documents").insert({
    employee_id: e.id, doc_type: docType, file_name: up.file_name ?? file.name, storage_path: null,
    drive_file_id: up.drive_file_id, drive_view_url: up.drive_view_url, mime_type: up.mime_type ?? file.type, size_bytes: up.size_bytes ?? file.size ?? null,
  } as never));
}
