// Live mode: read the real database into the same shapes the screens already
// render (seed.ts types), so every screen works against production data without
// being rewritten. RLS scopes every read to the signed-in user's company.
//
// Only what can be mapped TRUTHFULLY is loaded. A collection whose web figure is
// a ledger fold this file does not reproduce (custodian cash held, partner
// balances, journal) is left empty rather than filled with a number that looks
// right and is not — an empty list is visibly incomplete, a wrong balance is not.
import type * as seed from "./seed";
import { supabase } from "../lib/supabase";
import { addDays, iso } from "../lib/format";
import { isPkWallet } from "../lib/web/validation";
import { loadCustodianOptions } from "../lib/web/custodian";
import { hasPermission } from "../lib/permissions";

type Shift = seed.Shift;
type SeedShape = { -readonly [K in keyof typeof seed]: (typeof seed)[K] };
const SHIFTS: Shift[] = ["day", "night", "evening"];
const asShift = (s: unknown): Shift => (SHIFTS.includes(s as Shift) ? (s as Shift) : "day");

/** PostgREST caps a response at 1000 rows; page until the set is exhausted. */
async function all<T = any>(build: () => any, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < pageSize) return out;
  }
}

/** A read the user's permissions may refuse: an RLS denial is an empty list, not a failed load. */
async function soft<T = any>(build: () => any): Promise<T[]> {
  try { return await all<T>(build); } catch { return []; }
}

const SEPARATED = new Set(["terminated", "fired", "left", "absconded"]);

/** hiddenFromAttendance (web lib/employmentWindow.ts), verbatim in intent. */
export function hiddenFromAttendance(e: { lifecycle_state?: string | null; termination_date?: string | null; last_working_day?: string | null; exit_date?: string | null }, date: string) {
  if (!SEPARATED.has(String(e.lifecycle_state ?? ""))) return false;
  const cutoff = e.termination_date ?? e.last_working_day ?? e.exit_date;
  return cutoff ? date >= cutoff : true;
}

/** Web rosterTabOf(): separated-but-rehireable sits in the waiting list. */
const lifecycleOf = (s: string | null | undefined, eligible: boolean | null | undefined): seed.Lifecycle => {
  if (s === "active" || s === "on_leave") return "active";
  if (s === "applicant" || s === "waitlisted") return "waiting_fresh";
  if (s === "archived") return "terminated";
  if (SEPARATED.has(String(s ?? ""))) return eligible === false ? "terminated" : "waiting_rehire";
  return "terminated";
};

/** Web missingRequiredFields() — the list's "Incomplete" badge. */
function missingRequiredFields(e: any): string[] {
  const has = (v: unknown) => !!String(v ?? "").trim();
  if (e.lifecycle_state === "applicant" || e.lifecycle_state === "waitlisted") {
    return [!has(e.full_name) ? "Full Name" : null, !has(e.phone) ? "Phone" : null].filter(Boolean) as string[];
  }
  const emergency = (has(e.emergency_contact_name) && has(e.emergency_contact_phone)) || (has(e.emergency_contact2_name) && has(e.emergency_contact2_phone));
  return [
    !has(e.full_name) ? "Full Name" : null, !has(e.phone) ? "Phone" : null, !has(e.cnic_number) ? "CNIC" : null,
    !e.date_of_birth ? "Date of Birth" : null, !has(e.father_or_husband_name) ? "Father / Husband Name" : null,
    !e.cnic_expiry ? "CNIC Expiry" : null, !emergency ? "Emergency Contact" : null, !e.join_date ? "Join Date" : null,
    !has(e.bank_name) ? "Bank Name" : null, !has(e.account_title) ? "Account Title" : null, !has(e.bank_account) ? "Bank Account Number" : null,
    !isPkWallet(e.bank_name) && !has(e.bank_branch_code) ? "Branch Code" : null,
  ].filter(Boolean) as string[];
}

/** Web stores leave under "leave"; rotation_leave / rest_day read as L too. */
const attStatus = (s: string | null | undefined): seed.AttStatus => {
  const v = String(s ?? "").toLowerCase();
  if (v === "rotation_leave") return "leave";
  if (["present", "absent", "leave", "double_duty", "rest_day", "relief_cover"].includes(v)) return v as seed.AttStatus;
  return "present";
};

/** Picks the posting in force on `date`, exactly as the web board does. */
function bestPostingByGuard(deps: any[]) {
  const best = new Map<string, any>();
  for (const d of deps) {
    const prev = best.get(d.guard_id);
    if (!prev) { best.set(d.guard_id, d); continue; }
    const better = d.start_date !== prev.start_date
      ? d.start_date > prev.start_date
      : (d.end_date === null) !== (prev.end_date === null)
        ? d.end_date === null
        : String(d.id) > String(prev.id);
    if (better) best.set(d.guard_id, d);
  }
  return best;
}

export type LiveExtra = {
  /** `${employeeId}|${date}` → status, for the attendance window loaded. */
  attLive: Record<string, seed.AttStatus>;
  /** `${siteId}|${shift}|${date}` → confirmed. */
  confLive: Record<string, true>;
  /** First date of the loaded attendance window. Older dates read as unmarked. */
  attFrom: string;
  companyId: string | null;
};

export async function loadLive(profile: { id: string; role: string; permissions?: string[] }): Promise<Partial<SeedShape> & LiveExtra> {
  if (!supabase) throw new Error("Supabase is not configured");
  const sb = supabase;
  const today = iso(new Date());
  // Attendance covers this month and the last two in full — the monthly board,
  // timesheet and payroll screens reach back that far.
  const d = new Date();
  const attFrom = iso(new Date(d.getFullYear(), d.getMonth() - 2, 1));
  const payFrom = iso(new Date(d.getFullYear(), d.getMonth() - 6, 1));

  // A platform owner reads the company they are viewing as (profiles.view_as_company), as the web does.
  const [me] = await soft(() => sb.from("profiles").select("company_id, view_as_company").eq("id", profile.id));
  const companyId: string | null = me?.view_as_company ?? me?.company_id ?? null;
  // Cash custodians and what each holds: the web's own fold (lib/custodian.ts).
  // The held figure is banking data — only fetched with banks.view.
  const custodianOpts = companyId ? await loadCustodianOptions(companyId, hasPermission(profile as never, "banks.view")).catch(() => []) : [];

  const [
    companyRows, branchRows, clientRows, siteRows, contractRows, lineRows, employeeRows, deps, shiftDefs,
    attRows, confRows, reportRows, incidentRows, incidentGuards, invoiceRows, paymentRows, payslipRows,
    expenseRows, categoryRows, vendorRows, advanceRows, bankRows, chequeRows, taskRows, dateRows, alertRows,
    profileRows, periodRows, vacancyRows, coaRows, postRows, complaintRows, checklistRows, exportRows, adjustmentRows,
  ] = await Promise.all([
    companyId ? soft(() => sb.from("companies").select("*").eq("id", companyId)) : Promise.resolve([]),
    soft(() => sb.from("branches").select("id, name, code, kind, is_head_office, ho_excluded, active").order("name")),
    soft(() => sb.from("clients").select("*").order("name")),
    soft(() => sb.from("sites").select("id, client_id, name, location").order("name")),
    soft(() => sb.from("contracts").select("*").order("start_date", { ascending: false })),
    soft(() => sb.from("contract_lines").select("id, contract_id, category, label, location, committed_count, unit_rate, billing_rate, billed_qty, site_id, shift_code").order("id")),
    soft(() => sb.from("employees").select(
      "id, company_id, employee_code, guard_code, display_number, eligible_for_rehire, record_state, contract_id, account_title, bank_branch_code, secondary_phone, emergency_contact_relation, opening_leaves, full_name, father_or_husband_name, phone, cnic_number, cnic_expiry, date_of_birth, category, department, designation, " +
      "client_id, contract_line_id, shift, branch_id, lifecycle_state, status, join_date, exit_date, last_working_day, termination_date, base_salary, allowance, per_day_salary, " +
      "physical_copy_present, identity_verified, bank_name, bank_account, iban, current_address, permanent_address, blood_group, is_ex_serviceman, " +
      "police_verification_status, nadra_verisys_status, emergency_contact_name, emergency_contact_phone, emergency_contact2_name, emergency_contact2_phone, education",
    ).order("full_name")),
    soft(() => sb.from("deployments").select("id, guard_id, client_id, site_id, contract_line_id, shift_code, start_date, end_date").lte("start_date", today).or(`end_date.is.null,end_date.gte.${today}`).order("id")),
    soft(() => sb.from("shift_definitions").select("site_id, shift_code, start_time").order("start_time")),
    soft(() => sb.from("attendance_records").select("employee_id, attendance_date, status, worked_shift").gte("attendance_date", attFrom).order("id")),
    soft(() => sb.from("attendance_confirmations").select("site_id, group_key, shift_code, attendance_date").gte("attendance_date", attFrom).order("id")),
    soft(() => sb.from("daily_client_reports").select("client_id, report_date, details, no_report").gte("report_date", addDays(today, -60)).order("report_date")),
    soft(() => sb.from("incidents").select("id, incident_code, occurred_at, client_id, post_id, severity, category, description, action_taken, status, client_notified, client_notified_at, drive_file_id, drive_view_url, attachment_file_name").order("occurred_at", { ascending: false })),
    soft(() => sb.from("incident_guards").select("incident_id, employee_id").order("incident_id")),
    soft(() => sb.from("invoices").select("*").order("invoice_date", { ascending: false })),
    soft(() => sb.from("invoice_payments").select("id, invoice_id, payment_date, amount, payment_mode, notes, withholding_amount").order("payment_date")),
    soft(() => sb.from("payslips").select("id, employee_id, period_month, working_days, present_days, absent_days, leave_days, base_salary, allowance, bonus, advance, deductions, net_salary, final_salary, status, payment_mode, disbursed_at").gte("period_month", payFrom).order("id")),
    soft(() => sb.from("expenses").select("id, expense_date, category_id, client_id, vendor_id, description, amount, payment_mode, approved_at, pl_category, expense_by").order("expense_date", { ascending: false })),
    soft(() => sb.from("expense_categories").select("id, name").order("name")),
    soft(() => sb.from("vendors").select("id, name").order("name")),
    soft(() => sb.from("advances").select("id, advance_date, employee_id, amount, payment_mode, notes").order("advance_date", { ascending: false })),
    soft(() => sb.from("bank_accounts").select("id, bank_name, account_number, account_type, owner_type, balance, active").order("bank_name")),
    soft(() => sb.from("cheques").select("id, cheque_number, direction, cheque_type, bank_account_id, cheque_date, recipient, amount, status, notes").order("cheque_date", { ascending: false })),
    soft(() => sb.from("tasks").select("id, title, description, status, assignee_id, due_date, priority").order("position")),
    soft(() => sb.from("important_dates").select("id, title, due_date, category, advance_notice_days, priority, notes").order("due_date")),
    soft(() => sb.from("recurring_alerts").select("id, name, category, frequency, trigger_day, advance_notice_days, active, notes").order("name")),
    soft(() => sb.from("profiles").select("id, full_name, email, title, role, branch_id, permissions, employee_id").order("full_name")),
    soft(() => sb.from("accounting_periods").select("period_month, closed_at").order("period_month")),
    soft(() => sb.from("vacancies").select("id, client_id, site_id, shift_code, opened_at, opened_reason, status").eq("status", "open").order("opened_at", { ascending: false })),
    soft(() => sb.from("chart_of_accounts").select("id, account_code, account_name, account_type, parent_id, is_control, system_account, active").order("account_code")),
    soft(() => sb.from("posts").select("id, client_id, name, active").order("name")),
    soft(() => sb.from("client_complaints").select("id, client_id, raised_on, channel, description, status").order("raised_on", { ascending: false })),
    soft(() => sb.from("personal_checklist_items").select("*").eq("owner_id", profile.id).order("position").order("created_at")),
    soft(() => sb.from("daily_report_exports").select("id, report_date, total_posts, reported, generated_by, created_at").order("created_at", { ascending: false }).limit(50)),
    // Payslip corrections (0437) — the employee record lists its own, as PayrollAdjustmentHistory does.
    soft(() => sb.from("payroll_adjustments").select("id, employee_id, original_period_month, amount, reason, status").order("original_period_month", { ascending: false })),
  ]);

  // ---------- reference ----------
  const co = companyRows[0];
  const company = { id: co?.id ?? "", name: co?.name ?? "Bastion", short: (co?.name ?? "B").split(/\s+/).map((w: string) => w[0]).join("").slice(0, 4).toUpperCase(), plan: "", guard_cap: co?.guard_limit ?? 0, theme: (co?.theme ?? null) as string | null, raw: co ?? null };

  const branches: seed.Branch[] = branchRows.filter((b) => b.active !== false).map((b) => ({
    raw: b, id: b.id, name: b.name, code: b.code ?? "", ho_excluded: !!b.ho_excluded,
    kind: b.kind === "head_office" || b.is_head_office ? "head_office" : "regional",
  }));

  const activeContractClients = new Set(contractRows.filter((k) => k.status === "active").map((k) => k.client_id));
  const clients: seed.Client[] = clientRows.filter((c) => !c.is_internal).map((c) => ({
    raw: c, id: c.id, name: c.name, code: c.client_code ?? "", industry: c.industry ?? "", branch_id: c.branch_id ?? "",
    status: activeContractClients.has(c.id) ? "active" : "inactive",
    invoice_group: c.invoice_group === "VARIABLE" ? "VARIABLE" : "FIXED", ntn: c.ntn ?? "", strn: c.strn ?? "",
    filer: c.filer_status === "non_filer" ? "non_filer" : "filer", billing_email: c.email ?? "", phone: c.phone ?? "",
    signatory: c.authorised_signatory ?? "", address: c.billing_address ?? "",
    bank: (() => { const d = (Array.isArray(c.remit_accounts) ? c.remit_accounts : []).find((x: any) => x.is_default) ?? (c.remit_accounts ?? [])[0]; return { title: d?.account_title ?? "", account: d?.account_number ?? "", bank: d?.bank_name ?? "" }; })(),
    tax_lines: (Array.isArray(c.tax_profile) ? c.tax_profile : []).map((x: any) => ({ name: x.name, rate: Number(x.rate) || 0, direction: x.direction })), notes: c.relationship_notes ?? "",
  }));

  // ---------- postings (today) ----------
  const empById = new Map(employeeRows.map((e) => [e.id, e]));
  const posting = bestPostingByGuard(deps);
  const lineById = new Map(lineRows.map((l) => [l.id, l]));

  // Contracted strength per (site, shift) from contract lines, as the web board computes it.
  const contracted = new Map<string, number>();
  for (const l of lineRows) {
    if (!l.site_id) continue;
    const k = `${l.site_id}|${asShift(l.shift_code)}`;
    contracted.set(k, (contracted.get(k) ?? 0) + (Number(l.billed_qty) || 0));
  }
  const siteShifts = new Map<string, Set<Shift>>();
  const addShift = (siteId: string | null, s: unknown) => {
    if (!siteId) return;
    const set = siteShifts.get(siteId) ?? new Set<Shift>();
    set.add(asShift(s));
    siteShifts.set(siteId, set);
  };
  for (const l of lineRows) if (l.site_id && (Number(l.billed_qty) || 0) > 0) addShift(l.site_id, l.shift_code);
  for (const sd of shiftDefs) addShift(sd.site_id, sd.shift_code);
  for (const p of posting.values()) addShift(p.site_id, p.shift_code ?? lineById.get(p.contract_line_id)?.shift_code ?? empById.get(p.guard_id)?.shift);

  const sites: seed.Site[] = siteRows.map((s) => ({
    raw: s, id: s.id, client_id: s.client_id, name: s.name, area: s.location ?? "",
    shifts: SHIFTS.filter((sh) => siteShifts.get(s.id)?.has(sh)).map((sh) => ({ shift: sh, contracted: contracted.get(`${s.id}|${sh}`) ?? 0 })),
  }));

  const employees: seed.Employee[] = employeeRows.map((e) => {
    const p = posting.get(e.id);
    const onRoster = p && !hiddenFromAttendance(e, today) && e.lifecycle_state !== "archived";
    const shift = asShift(p?.shift_code ?? lineById.get(p?.contract_line_id)?.shift_code ?? e.shift);
    const lifecycle = lifecycleOf(e.lifecycle_state, e.eligible_for_rehire);
    const prefix = clientRows.find((c) => c.id === e.client_id)?.employee_id_prefix;
    const permanent = e.guard_code ?? e.employee_code ?? "";
    const display = e.display_number != null && e.client_id && prefix ? `${prefix}-${String(e.display_number).padStart(3, "0")}` : permanent;
    const cat: seed.Employee["category"] = e.category === "office_staff" ? "office_staff" : e.category === "reliever" ? "reliever" : "client";
    return {
      raw: e, id: e.id, code: display, permanent_code: permanent, name: e.full_name ?? "—",
      father_name: e.father_or_husband_name ?? "", phone: e.phone ?? "", cnic: e.cnic_number ?? "", cnic_expiry: e.cnic_expiry ?? null,
      dob: e.date_of_birth ?? "", category: cat, department: e.department ?? e.designation ?? "",
      client_id: onRoster ? p.client_id : e.client_id ?? null, site_id: onRoster ? p.site_id ?? null : null,
      line_id: onRoster ? p.contract_line_id ?? null : e.contract_line_id ?? null, shift, branch_id: e.branch_id ?? "",
      lifecycle, status: SEPARATED.has(e.lifecycle_state) ? "Fired" : e.lifecycle_state === "on_leave" ? "On Leave" : e.status === "Active" ? "Active" : "Inactive",
      join_date: e.join_date ?? null, left_on: e.termination_date ?? e.last_working_day ?? e.exit_date ?? null,
      base: Number(e.base_salary) || 0, allowance: Number(e.allowance) || 0, per_day: Number(e.per_day_salary) || 0, pay_mode: "fixed",
      physical_copy: !!e.physical_copy_present, incomplete: missingRequiredFields(e), verified: !!e.identity_verified,
      bank: e.bank_name ?? "", account: e.bank_account ?? e.iban ?? "", address: e.current_address ?? e.permanent_address ?? "",
      blood_group: e.blood_group ?? "", ex_service: !!e.is_ex_serviceman,
      police_verification: e.police_verification_status ?? "pending", verisys: e.nadra_verisys_status ?? "pending",
      emergency_name: e.emergency_contact_name ?? "", emergency_phone: e.emergency_contact_phone ?? "", education: e.education ?? "", warnings: 0,
    };
  });

  const activeByLine = new Map<string, number>();
  for (const e of employees) if (e.lifecycle === "active" && e.line_id) activeByLine.set(e.line_id, (activeByLine.get(e.line_id) ?? 0) + 1);
  const contracts: seed.Contract[] = contractRows.map((k) => ({
    raw: k, id: k.id, code: k.contract_code ?? "", client_id: k.client_id, type: k.contract_type === "services" ? "services" : "guard_deployment",
    start: k.start_date ?? "", end: k.is_infinite ? "" : k.end_date ?? "", status: k.status, weapons: "", document: !!k.drive_file_id, addendums: [],
    lines: lineRows.filter((l) => l.contract_id === k.id).map((l) => ({
      raw: l, id: l.id, category: l.label ?? String(l.category ?? "").replace(/_/g, " ").toLowerCase(), notes: l.location ?? "",
      committed: Number(l.committed_count) || 0, rate: Number(l.unit_rate ?? l.billing_rate) || 0, active: activeByLine.get(l.id) ?? 0,
    })),
  }));

  // ---------- attendance ----------
  // A day can hold two rows (double duty); any leave on the day wins, then any
  // double duty, else the single mark.
  const attLive: Record<string, seed.AttStatus> = {};
  const rank: Record<string, number> = { leave: 4, double_duty: 3, absent: 2, relief_cover: 1, present: 0, rest_day: 4 };
  for (const a of attRows) {
    const k = `${a.employee_id}|${a.attendance_date}`;
    const s = attStatus(a.status);
    const prev = attLive[k];
    if (!prev || (rank[s] ?? 0) > (rank[prev] ?? 0)) attLive[k] = s;
  }
  const confLive: Record<string, true> = {};
  for (const c of confRows) if (c.site_id) confLive[`${c.site_id}|${asShift(c.shift_code)}|${c.attendance_date}`] = true;

  const dailyNotes: Record<string, Record<string, string>> = {};
  for (const r of reportRows) {
    const text = r.no_report ? "No report." : r.details ?? "";
    if (!text) continue;
    (dailyNotes[r.report_date] ??= {})[r.client_id] = text;
  }

  const vacancies = vacancyRows.map((v) => ({ id: v.id, client_id: v.client_id, site_id: v.site_id, shift: asShift(v.shift_code), reason: v.opened_reason ?? "Open vacancy", opened: String(v.opened_at ?? "").slice(0, 10) }));

  // ---------- operations ----------
  const guardsByIncident = new Map<string, string[]>();
  for (const g of incidentGuards) guardsByIncident.set(g.incident_id, [...(guardsByIncident.get(g.incident_id) ?? []), g.employee_id]);
  const incidents: seed.Incident[] = incidentRows.map((i) => ({
    raw: i, id: i.id, code: i.incident_code ?? "", occurred_at: i.occurred_at ?? "", client_id: i.client_id ?? "", site_id: i.post_id ?? "",
    severity: i.severity, category: i.category, description: i.description ?? "", response: i.action_taken ?? "",
    guards: guardsByIncident.get(i.id) ?? [], status: i.status,
  }));

  // ---------- money ----------
  const paymentsByInvoice = new Map<string, seed.Invoice["payments"]>();
  for (const p of paymentRows) {
    const arr = paymentsByInvoice.get(p.invoice_id) ?? [];
    arr.push({ id: p.id, date: p.payment_date, amount: Number(p.amount) || 0, mode: p.payment_mode === "Cash" ? "Cash" : p.payment_mode === "Cheque" ? "Cheque" : "Bank", notes: p.notes ?? "", wht: Number(p.withholding_amount) || 0 });
    paymentsByInvoice.set(p.invoice_id, arr);
  }
  const invoices: seed.Invoice[] = invoiceRows.map((i) => ({
    raw: i, id: i.id, number: i.invoice_number ?? "", client_id: i.client_id, contract_id: i.contract_id ?? "",
    month: String(i.service_month ?? i.period_start ?? i.invoice_date ?? "").slice(0, 7), amount: Number(i.invoice_amount) || 0,
    date: i.invoice_date ?? "", status: ["Paid", "Partial", "Unpaid", "Overdue"].includes(i.status) ? i.status : "Unpaid",
    attachment: !!(i.drive_file_id || i.attachment_path), notes: i.notes ?? "", payments: paymentsByInvoice.get(i.id) ?? [],
  }));

  const payslips: seed.Payslip[] = payslipRows.map((p) => ({
    raw: p, id: p.id, employee_id: p.employee_id, month: String(p.period_month).slice(0, 7), working: p.working_days ?? 0, present: p.present_days ?? 0,
    double_duty: 0, absent: p.absent_days ?? 0, leave: p.leave_days ?? 0, base: Number(p.base_salary) || 0, allowance: Number(p.allowance) || 0,
    bonus: Number(p.bonus) || 0, advance: Number(p.advance) || 0, deductions: Number(p.deductions) || 0, net: Number(p.net_salary ?? p.final_salary) || 0,
    status: p.status === "Cleared" ? "Cleared" : "Pending", mode: p.payment_mode ?? null, paid_on: p.disbursed_at ? String(p.disbursed_at).slice(0, 10) : null,
  }));

  const catName = new Map(categoryRows.map((c) => [c.id, c.name]));
  const vendorName = new Map(vendorRows.map((v) => [v.id, v.name]));
  const userName = new Map(profileRows.map((p) => [p.id, p.full_name ?? p.email ?? "—"]));
  const expenses: seed.Expense[] = expenseRows.map((x) => ({
    raw: x, id: x.id, date: x.expense_date, category: catName.get(x.category_id) ?? "—", client_id: x.client_id ?? null, vendor: vendorName.get(x.vendor_id) ?? "",
    description: x.description ?? "", amount: Number(x.amount) || 0, mode: ["Cash", "Bank", "Cheque", "Payable"].includes(x.payment_mode) ? x.payment_mode : "Cash",
    by: empById.get(x.expense_by)?.full_name ?? "", approved: !!x.approved_at, nature: x.pl_category === "cost_of_services" ? "Cost of Services" : "Operating Expense",
  }));

  const advances: seed.Advance[] = advanceRows.map((a) => ({
    raw: a, id: a.id, date: a.advance_date, employee_id: a.employee_id, amount: Number(a.amount) || 0, mode: a.payment_mode === "Bank" ? "Bank" : "Cash",
    paid_by: "", notes: a.notes ?? "", recovered: 0,
  }));

  const banks: seed.Bank[] = bankRows.filter((b) => b.active !== false).map((b) => ({
    raw: b, id: b.id, name: b.bank_name ?? "", number: b.account_number ?? "", type: b.account_type === "Savings" ? "Savings" : "Current",
    owner: b.owner_type === "partner" ? "Partner" : b.owner_type === "client" ? "Client" : "Company", balance: Number(b.balance) || 0, cheque_balance: 0,
  }));

  const cheques: seed.Cheque[] = chequeRows.map((c) => ({
    raw: c, id: c.id, number: c.cheque_number ?? "", type: c.direction === "incoming" || c.cheque_type === "deposit" ? "deposit" : "payment",
    bank_id: c.bank_account_id ?? "", date: c.cheque_date ?? "", party: c.recipient ?? "", amount: Number(c.amount) || 0, linked: c.notes ?? "",
    status: ["pending", "cleared", "bounced"].includes(c.status) ? c.status : "pending",
  }));

  const accounts: seed.Account[] = (() => {
    const codeById = new Map(coaRows.map((a) => [a.id, a.account_code]));
    return coaRows.filter((a) => a.active !== false).map((a) => ({
      raw: a, code: a.account_code, name: a.account_name, type: a.account_type, parent: a.parent_id ? codeById.get(a.parent_id) ?? null : null,
      control: !!a.is_control, system: !!a.system_account,
    }));
  })();

  // ---------- overview / compliance / admin ----------
  const tasks: seed.Task[] = taskRows.map((t) => ({
    raw: t, id: t.id, title: t.title ?? "", description: t.description ?? "", assignee: userName.get(t.assignee_id) ?? "", due: t.due_date ?? "",
    status: ["todo", "in_progress", "done"].includes(t.status) ? t.status : "todo", priority: t.priority ?? "medium",
  }));
  const importantDates: seed.ImportantDate[] = dateRows.map((r) => ({
    raw: r, id: r.id, title: r.title, date: r.due_date, category: r.category ?? "", notice: r.advance_notice_days ?? 0, priority: ["low", "medium", "high", "critical"].includes(r.priority) ? r.priority : "medium",
  }));
  const recurringAlerts: seed.RecurringAlert[] = alertRows.map((r) => ({
    raw: r, id: r.id, name: r.name, category: r.category ?? "", frequency: r.frequency ?? "", trigger_day: Number(r.trigger_day) || 0, notice: r.advance_notice_days ?? 0, active: !!r.active,
  }));
  const users: seed.AppUser[] = profileRows.map((p) => ({
    raw: p, id: p.id, name: p.full_name ?? p.email ?? "—", email: p.email ?? "", title: p.title ?? "", role: p.role, branch_id: p.branch_id ?? null,
    permissions: p.permissions ?? [], employee_id: p.employee_id ?? null, active: true,
  }));
  const closed = new Set(periodRows.filter((p) => p.closed_at).map((p) => String(p.period_month).slice(0, 7)));
  const periods = Array.from({ length: 7 }, (_, i) => {
    const m = iso(new Date(d.getFullYear(), d.getMonth() - i, 1)).slice(0, 7);
    return { month: m, invoices: 0, payments: 0, expenses: 0, payslips: 0, advances: 0, cheques: 0, status: (closed.has(m) ? "closed" : "open") as "open" | "closed" };
  });

  return {
    company, branches, clients, sites, contracts, employees, vacancies, dailyNotes, incidents, invoices, payslips, expenses,
    expenseCategories: categoryRows.map((c) => c.name), vendors: vendorRows.map((v) => v.name), advances, banks, cheques, accounts,
    tasks, importantDates, recurringAlerts, users, periods,
    custodians: custodianOpts.map((c) => ({
      raw: c, id: c.locationId!, location: c.kind === "partner" ? "Partner" : "Office staff", type: c.kind === "partner" ? "Partner" as const : "Office" as const,
      holder: c.fullName, opening: 0, held: c.held, active: true,
    })),
    reportExports: exportRows.map((x) => ({ id: x.id, date: x.report_date, clients: x.total_posts ?? 0, by: userName.get(x.generated_by) ?? "—", at: x.created_at })),
    checklist: checklistRows.map((c) => ({ raw: c, id: c.id, text: c.label ?? "", done: !!c.done })),
    posts: postRows.filter((p) => p.active !== false).map((p) => ({ id: p.id, client_id: p.client_id, name: p.name })),
    complaints: complaintRows.map((c) => ({ id: c.id, client_id: c.client_id, raised: c.raised_on, description: c.description ?? "", status: c.status, channel: c.channel })),
    incidentCategories: ["theft", "altercation", "guard_injury", "weapon_discharge", "no_show", "asset_damage", "client_complaint", "other"],
    adjustments: adjustmentRows.map((a) => ({ id: a.id, employee_id: a.employee_id, month: String(a.original_period_month).slice(0, 7), amount: Number(a.amount), reason: a.reason ?? "", status: a.status })),
    attLive, confLive, attFrom, companyId,
  };
}

// ---------------------------------------------------------------- writes
// Only the field-ops writes are wired, each one a port of the web screen that
// makes it. Everything else is refused in live mode (see store.tsx) rather than
// written by a guess at what the web does.

export type DrillGuard = { guard_id: string; name: string; code: string; department: string; client_id: string; scheduled_shift: Shift };

/**
 * The roster of one site-shift ON `date` — the dated posting in force that day,
 * separated guards dropped from their cutoff — plus the marks already recorded.
 * Mirrors AttendanceBoard.tsx load() for a single site.
 */
export async function loadShiftRoster(groupKey: string, shift: Shift, date: string, isSite: boolean) {
  if (!supabase) throw new Error("Supabase is not configured");
  const sb = supabase;
  const [deps, att, conf, defs] = await Promise.all([
    all(() => sb.from("deployments")
      .select("id, guard_id, site_id, client_id, contract_line_id, shift_code, start_date, end_date, employees:guard_id(full_name, guard_code, employee_code, designation, department, shift, category, join_date, last_working_day, termination_date, exit_date, lifecycle_state), contract_lines:contract_line_id(shift_code)")
      .lte("start_date", date).or(`end_date.is.null,end_date.gte.${date}`).order("id")),
    all(() => sb.from("attendance_records").select("employee_id, status, absent_reason, worked_shift").eq("attendance_date", date).order("id")),
    all(() => sb.from("attendance_confirmations").select("supervisor_name, confirmed_at").eq("group_key", groupKey).eq("shift_code", shift).eq("attendance_date", date).order("id")),
    isSite ? all(() => sb.from("shift_definitions").select("shift_code, start_time").eq("site_id", groupKey).order("start_time")) : Promise.resolve([] as any[]),
  ]);
  const best = bestPostingByGuard(deps);
  const roster: DrillGuard[] = [];
  for (const d of best.values()) {
    const e = d.employees;
    if (!e || (d.site_id ?? d.client_id) !== groupKey) continue;
    if (e.category === "reliever" || e.lifecycle_state === "archived") continue;
    if (e.join_date && e.join_date > date) continue;
    if (hiddenFromAttendance(e, date)) continue;
    const sched = asShift(d.shift_code ?? d.contract_lines?.shift_code ?? e.shift);
    if (sched !== shift) continue;
    roster.push({ guard_id: d.guard_id, name: e.full_name ?? "—", code: e.guard_code ?? e.employee_code ?? "", department: e.designation ?? e.department ?? "", client_id: d.client_id, scheduled_shift: sched });
  }
  roster.sort((a, b) => a.name.localeCompare(b.name));
  const marks: Record<string, { status: seed.AttStatus; absent_reason: string | null }> = {};
  for (const a of att) {
    if ((a.worked_shift ?? shift) !== shift) continue;
    marks[a.employee_id] = { status: attStatus(a.status), absent_reason: a.absent_reason ?? null };
  }
  const siteShifts = [...new Set([...defs.map((r: any) => asShift(r.shift_code)), shift])];
  let gateRes: { mode: string; reason: string | null } | null = null;
  if (roster[0]) {
    const { data } = await sb.rpc("attendance_gate" as never, { p_guard: roster[0].guard_id, p_date: date } as never);
    gateRes = (data as any) ?? null;
  }
  return { roster, marks, confirmation: (conf[0] as any) ?? null, siteShifts, gate: gateRes };
}

const LEAVE_TOKENS = ["leave", "rotation_leave", "rest_day"];

/** clearConflictingDayRows (web lib/attendanceDay.ts), same rules, same order. */
async function clearConflictingDayRows(rows: { employee_id: string; attendance_date: string; status: string; worked_shift: string }[]) {
  const sb = supabase!;
  type Agg = { empId: string; date: string; leave: boolean; shifts: Set<string>; double: boolean };
  const byKey = new Map<string, Agg>();
  for (const r of rows) {
    const key = `${r.employee_id}|${r.attendance_date}`;
    const a = byKey.get(key) ?? { empId: r.employee_id, date: r.attendance_date, leave: false, shifts: new Set<string>(), double: false };
    if (LEAVE_TOKENS.includes(r.status)) a.leave = true;
    else {
      if (r.worked_shift) a.shifts.add(r.worked_shift);
      if (r.status === "double_duty") a.double = true;
    }
    byKey.set(key, a);
  }
  for (const a of byKey.values()) {
    if (a.leave) {
      const { error } = await sb.from("attendance_records").delete().eq("employee_id", a.empId).eq("attendance_date", a.date);
      if (error) throw new Error(error.message);
      continue;
    }
    {
      const { error } = await sb.from("attendance_records").delete().eq("employee_id", a.empId).eq("attendance_date", a.date).in("status", LEAVE_TOKENS);
      if (error) throw new Error(error.message);
    }
    if (!a.double && a.shifts.size > 0) {
      const { error } = await sb.from("attendance_records").delete().eq("employee_id", a.empId).eq("attendance_date", a.date)
        .eq("status", "present").not("worked_shift", "in", `(${[...a.shifts].join(",")})`);
      if (error) throw new Error(error.message);
    }
  }
}

/**
 * Confirm one site-shift for a date: one attendance row per rostered guard
 * (present unless marked), double duty as two rows both `double_duty`, then the
 * confirmation keyed by group_key. Port of the web ShiftDrill confirm().
 */
export async function confirmShift(args: {
  companyId: string | null; groupKey: string; isSite: boolean; clientId: string; shift: Shift; date: string; roster: DrillGuard[];
  marks: Record<string, { status: seed.AttStatus; absent_reason: string | null; extraShift?: Shift | null }>;
  supervisor: string; override: string; userId: string; role: string;
}) {
  const sb = supabase!;
  const rows = args.roster.flatMap((g) => {
    const mk = args.marks[g.guard_id];
    const status = mk?.status ?? "present";
    const isDouble = status === "double_duty";
    const worked = isDouble ? [g.scheduled_shift, mk!.extraShift!] : [g.scheduled_shift];
    return worked.map((ws) => ({
      employee_id: g.guard_id,
      attendance_date: args.date,
      status: isDouble ? "double_duty" : status,
      absent_reason: status === "absent" ? mk?.absent_reason ?? null : null,
      scheduled_shift: g.scheduled_shift,
      worked_shift: ws,
      entry_type: isDouble ? "double_duty" : status === "relief_cover" ? "relief_cover" : "normal",
      source: "app",
      worked_for_client_id: g.client_id,
      marked_by_role: args.role,
      marked_by_user_id: args.userId,
      marked_at: new Date().toISOString(),
      supervisor_override: true,
      override_reason: args.override.trim() || "Confirmed via Bastion Field app",
    }));
  });
  await clearConflictingDayRows(rows);
  const { error: upErr } = await sb.from("attendance_records").upsert(rows as never, { onConflict: "employee_id,attendance_date,worked_shift" });
  if (upErr) throw new Error(upErr.message);
  const { error: cErr } = await sb.from("attendance_confirmations").upsert(
    {
      company_id: args.companyId, group_key: args.groupKey, category: null, client_id: args.clientId, site_id: args.isSite ? args.groupKey : null,
      shift_code: args.shift, attendance_date: args.date, supervisor_name: args.supervisor.trim(), source: "app",
    } as never,
    { onConflict: "company_id,group_key,shift_code,attendance_date" },
  );
  if (cErr) throw new Error(cErr.message);
}

/** Save one client's daily note. Port of FieldOps.tsx saveOne(). */
export async function saveDailyNote(companyId: string | null, clientId: string, date: string, text: string, userId: string) {
  const sb = supabase!;
  const value = text.trim();
  const { error } = value
    ? await sb.from("daily_client_reports").upsert(
        { company_id: companyId, client_id: clientId, report_date: date, details: value, no_report: false, updated_by: userId } as never,
        { onConflict: "company_id,client_id,report_date" },
      )
    : await sb.from("daily_client_reports").delete().eq("company_id", companyId as string).eq("client_id", clientId).eq("report_date", date);
  if (error) throw new Error(error.message);
}
