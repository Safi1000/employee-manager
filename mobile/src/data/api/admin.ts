// Admin (web UserManagement, Governance, AuditLog, Settings, Billing, Companies,
// CompanyDetail). Users are created and their passwords reset through the same
// edge functions the web calls; everything else is the web's own write.
import { q, rpc, sb } from "./core";

// ------------------------------------------------------ edge function helpers
// The web's FN_ERROR_MESSAGES + unwrapFnError (lib/auth.tsx), which the phone
// does not sync because that file is the browser auth provider.
const FN_ERROR_MESSAGES: Record<string, string> = {
  missing_token: "Your session expired — sign in again.",
  invalid_token: "Your session expired — sign in again.",
  no_profile: "Your account has no profile on this company.",
  forbidden: "You don't have permission to do that.",
  wrong_company: "You can only manage users in your own company.",
  company_id_required: "Cannot determine your company.",
  company_not_found: "That company no longer exists.",
  branch_not_found: "The selected branch no longer exists.",
  branch_company_mismatch: "The selected branch belongs to another company.",
  email_and_password_required: "Email and password are required.",
  password_too_short: "Password must be at least 8 characters.",
  password_breached: "That password has appeared in a public data breach. Choose a different one.",
  invalid_role: "Invalid role.",
};
async function unwrapFnError(error: unknown): Promise<string> {
  const fallback = error instanceof Error ? error.message : String(error);
  const ctx = (error as { context?: Response })?.context;
  if (!ctx || typeof ctx.clone !== "function") return fallback;
  try {
    const body = await ctx.clone().json();
    const code = body?.error ? String(body.error) : null;
    if (!code) return fallback;
    return FN_ERROR_MESSAGES[code] ?? (body?.detail ? `${code}: ${body.detail}` : code);
  } catch { return fallback; }
}
export async function callCreateUser(input: { email: string; password: string; role?: string; title?: string | null; company_id: string; branch_id?: string | null; full_name?: string | null; permissions?: string[] }) {
  const { data, error } = await sb().functions.invoke("create-user", { body: input });
  if (error) return { error: await unwrapFnError(error) };
  if (data && typeof data === "object" && "error" in data) return { error: String((data as { error: unknown }).error) };
  return { ok: true as const, user_id: (data as { user_id: string }).user_id };
}
export async function callChangePassword(input: { new_password: string; current_password?: string; target_user_id?: string }) {
  const { data, error } = await sb().functions.invoke("change-password", { body: input });
  if (error) return { error: await unwrapFnError(error) };
  if (data && typeof data === "object" && "error" in data) return { error: String((data as { error: unknown }).error) };
  return { ok: true as const };
}

// ---------------------------------------------------------------------- Users
export const ASSIGNABLE_ROLES = ["super_admin", "ops_director", "finance_director", "ops_manager", "accounting", "hr"] as const;
export const USER_ROLE_LABEL: Record<string, string> = {
  super_super_admin: "Super Super Admin", super_admin: "Super Admin", hr: "HR", accounting: "Accounting",
  ops_manager: "Manager Ops", ops_director: "Director Ops", finance_director: "Director Finance",
};
export type ProfileRow = {
  id: string; email: string | null; full_name: string | null; title: string | null; role: string; permissions: string[] | null;
  branch_id: string | null; user_type: string | null; partner_scope: string[] | null; employee_id: string | null; created_at: string;
};
export async function loadUsers() {
  const s = sb();
  const [users, branches, partners, employees] = await Promise.all([
    q<ProfileRow[]>(s.from("profiles").select("*").order("created_at", { ascending: true })),
    q<any[]>(s.from("branches").select("*").order("is_head_office", { ascending: false }).order("name")),
    q<{ id: string; name: string }[]>(s.from("partners").select("id, name").order("name")),
    q<{ id: string; full_name: string; employee_code: string | null }[]>(s.from("employees").select("id, full_name, employee_code").eq("lifecycle_state", "active").order("full_name").range(0, 9999)),
  ]);
  const linked = new Map<string, string>();
  for (const u of users) if (u.employee_id) linked.set(u.employee_id, u.full_name ?? u.email ?? "another user");
  return { users, branches, partners, employees, linked };
}
export type UserForm = {
  email: string; password: string; fullName: string; title: string; branchId: string; role: string; perms: Set<string>;
  userType: "office_staff" | "partner"; employeeId: string; partnerScope: Set<string>;
};
export async function createUser(f: UserForm, companyId: string, existing: ProfileRow[]) {
  const typed = f.email.trim().toLowerCase();
  if (existing.some((u) => (u.email ?? "").trim().toLowerCase() === typed)) throw new Error(`A user with the email ${typed} already exists.`);
  const res = await callCreateUser({
    email: f.email.trim(), password: f.password, title: f.title.trim() || null, company_id: companyId, branch_id: f.branchId || null,
    full_name: f.fullName.trim() || null, permissions: Array.from(f.perms),
  });
  if ("error" in res) {
    throw new Error(res.error === "email_taken"
      ? `A user with the email ${typed} already exists. Emails must be unique across the whole system, including other companies.`
      : res.error ?? "Failed to create user");
  }
  if (res.user_id) {
    await q(sb().from("profiles").update({
      user_type: f.userType, partner_scope: f.userType === "partner" ? Array.from(f.partnerScope) : null,
      employee_id: f.userType === "partner" ? null : f.employeeId || null,
    } as never).eq("id", res.user_id));
  }
}
export async function saveUser(u: ProfileRow, f: UserForm, isSSA: boolean) {
  const touchesAdmin = u.role === "super_admin" || f.role === "super_admin";
  if (touchesAdmin && f.role !== u.role && !isSSA) throw new Error("Only a Super Super Admin can change a Super Admin's role.");
  const nextRole = isSSA ? f.role : touchesAdmin ? u.role : f.role;
  await q(sb().from("profiles").update({
    full_name: f.fullName.trim() || null, title: f.title.trim() || null, branch_id: f.branchId || null, role: nextRole,
    permissions: nextRole === "super_admin" ? [] : Array.from(f.perms), user_type: f.userType,
    partner_scope: f.userType === "partner" ? Array.from(f.partnerScope) : null, employee_id: f.userType === "partner" ? null : f.employeeId || null,
  } as never).eq("id", u.id));
}
export async function resetPassword(userId: string, pw: string) {
  const res = await callChangePassword({ new_password: pw, target_user_id: userId });
  if ("error" in res && res.error) {
    throw new Error(res.error === "only_super_super_admin_can_change_super_admin_password" ? "Only Super Super Admin can reset a Super Admin's password." : res.error);
  }
}
export async function deleteUser(u: ProfileRow, meId: string | null, isSSA: boolean) {
  if (u.id === meId) throw new Error("You can't delete your own account.");
  if (u.role === "super_admin" && !isSSA) throw new Error("Only a Super Super Admin can delete a Super Admin.");
  await q(sb().from("profiles").delete().eq("id", u.id));
}

// ----------------------------------------------------------------- Governance
export const DEPARTMENTS = ["operations", "compliance", "hr", "finance", "client_management"] as const;
export async function loadGovernance(companyId: string) {
  const s = sb();
  const [requests, configs, staff] = await Promise.all([
    q<any[]>(s.from("approval_requests").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(100)),
    q<any[]>(s.from("approval_configs").select("*").eq("company_id", companyId).order("action_key")),
    q<any[]>(s.from("profiles").select("id, full_name, email, department, is_rmd").eq("company_id", companyId).order("full_name")),
  ]);
  return { requests, configs, staff };
}
export const decideApproval = (id: string, approve: boolean) => rpc("decide_approval", { p_request_id: id, p_approve: approve, p_reason: null });
export const setDepartment = (id: string, dept: string | null) => q(sb().from("profiles").update({ department: dept } as never).eq("id", id));
export const setRmd = (id: string, v: boolean) => q(sb().from("profiles").update({ is_rmd: v } as never).eq("id", id));
export async function applyDeptDefaults(profileId: string, dept: string | null) {
  if (!dept) throw new Error("Assign a department before applying its permission set.");
  const perms = ((await rpc<string[]>("department_default_permissions", { p_dept: dept })) ?? []) as string[];
  await q(sb().from("profiles").update({ permissions: perms } as never).eq("id", profileId));
}

// ------------------------------------------------------------------ Audit log
export const AUDIT_PAGE_SIZE = 50;
export async function loadAuditProfiles() {
  return q<{ id: string; full_name: string | null; email: string | null }[]>(sb().from("profiles").select("id, full_name, email"));
}
export async function loadAudit(f: { from: string; to: string; table: string; action: string; user: string; recordId: string; page: number }) {
  let qb = sb().from("audit_log").select("*").gte("changed_at", f.from + "T00:00:00Z").lte("changed_at", f.to + "T23:59:59Z")
    .order("changed_at", { ascending: false }).range(f.page * AUDIT_PAGE_SIZE, f.page * AUDIT_PAGE_SIZE + AUDIT_PAGE_SIZE);
  if (f.table !== "all") qb = qb.eq("table_name", f.table);
  if (f.action !== "all") qb = qb.eq("action", f.action);
  if (f.user !== "all") qb = qb.eq("changed_by", f.user);
  if (f.recordId.trim()) qb = qb.eq("record_id", f.recordId.trim());
  const rows = await q<any[]>(qb);
  return { rows: rows.slice(0, AUDIT_PAGE_SIZE), hasMore: rows.length > AUDIT_PAGE_SIZE };
}

// ------------------------------------------------------------------- Settings
export async function loadSettings(companyId: string) {
  const s = sb();
  const [emps, branches, notif] = await Promise.all([
    q<any[]>(s.from("employees").select("client_id, branch_id")),
    q<any[]>(s.from("branches").select("id, name, is_head_office, ho_excluded, ho_excluded_reason").order("is_head_office", { ascending: false }).order("name")),
    q<any>(s.from("notification_settings").select("recipient_email, sender_email").eq("company_id", companyId).maybeSingle()),
  ]);
  const brCounts: Record<string, number> = {};
  for (const e of emps) if (e.branch_id) brCounts[e.branch_id] = (brCounts[e.branch_id] ?? 0) + 1;
  return {
    branches: branches.map((r) => ({ id: r.id as string, name: r.name as string, is_head_office: !!r.is_head_office, employees: brCounts[r.id] ?? 0, ho_excluded: !!r.ho_excluded, ho_excluded_reason: (r.ho_excluded_reason ?? null) as string | null })),
    notif: { recipient: notif?.recipient_email ?? "", sender: notif?.sender_email ?? "info@techxserve.com" },
  };
}
export type BranchRow = Awaited<ReturnType<typeof loadSettings>>["branches"][number];
export const setCompanyTheme = (companyId: string, key: string) => q(sb().from("companies").update({ theme: key } as never).eq("id", companyId));
export const saveHiddenWidgets = (companyId: string, hidden: string[]) => q(sb().from("companies").update({ dashboard_hidden_widgets: hidden } as never).eq("id", companyId));
export async function saveNotificationSettings(companyId: string, recipient: string, sender: string) {
  await q(sb().from("notification_settings").upsert({ company_id: companyId, recipient_email: recipient.trim() || null, sender_email: sender.trim() || null, updated_at: new Date().toISOString() } as never, { onConflict: "company_id" }));
}
export async function sendTestEmail(recipient: string, sender: string) {
  if (!recipient.trim()) throw new Error("Enter a recipient email first.");
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in — sign in again and retry.");
  const res = await fetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/send-compliance-alerts?test=1`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "" },
    body: JSON.stringify({ recipient: recipient.trim(), from: sender.trim() || undefined }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const msg = body?.error?.message ?? body?.error ?? `HTTP ${res.status}`; throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg)); }
  return `Test email sent to ${body?.recipient ?? recipient.trim()}. Check inbox / spam.`;
}
export async function hoExclusionPreview(companyId: string, branches: BranchRow[], b: BranchRow) {
  const proposed = branches.filter((x) => (x.id === b.id ? !b.ho_excluded : x.ho_excluded)).map((x) => x.id);
  return ((await rpc<any[]>("ho_exclusion_preview", { p_company_id: companyId, p_period: new Date().toISOString().slice(0, 8) + "01", p_excluded: proposed })) ?? []) as
    { branch_id: string; region_name: string; absorbs_now: number; absorbs_after: number; delta: number }[];
}
export async function saveHoExclusion(b: BranchRow, reason: string, profileId: string | null) {
  const turningOn = !b.ho_excluded;
  await q(sb().from("branches").update((turningOn
    ? { ho_excluded: true, ho_excluded_reason: reason.trim(), ho_excluded_at: new Date().toISOString(), ho_excluded_by: profileId }
    : { ho_excluded: false }) as never).eq("id", b.id));
}
export const addBranch = (name: string) => q(sb().from("branches").insert({ name: name.trim() } as never));
export const renameBranch = (id: string, name: string) => q(sb().from("branches").update({ name: name.trim() } as never).eq("id", id));
export async function deleteBranch(b: BranchRow, branches: BranchRow[]) {
  if (b.is_head_office) throw new Error("Head Office cannot be deleted.");
  const head = branches.find((x) => x.is_head_office);
  if (head) {
    await sb().from("employees").update({ branch_id: head.id } as never).eq("branch_id", b.id);
    await sb().from("clients").update({ branch_id: head.id } as never).eq("branch_id", b.id);
  }
  await q(sb().from("branches").delete().eq("id", b.id));
}
export async function loadMyDisplay(profileId: string) {
  return q<any>(sb().from("profiles").select("full_name, email, display_company_name, avatar_url").eq("id", profileId).maybeSingle());
}
export async function saveMyDisplay(profileId: string, f: { username: string; email: string; companyName: string; logoUrl: string | null }) {
  await q(sb().from("profiles").update({
    full_name: f.username.trim() || null, email: f.email.trim() || null, display_company_name: f.companyName.trim() || null, avatar_url: f.logoUrl, updated_at: new Date().toISOString(),
  } as never).eq("id", profileId));
}

// ------------------------------------------------------------------ Companies
export async function loadCompanies() {
  const cs = await q<any[]>(sb().from("companies").select("*").order("created_at", { ascending: false }));
  const ids = cs.length ? cs.map((c) => c.id) : ["00000000-0000-0000-0000-000000000000"];
  const [emps, profs] = await Promise.all([
    q<any[]>(sb().from("employees").select("company_id").in("company_id", ids)),
    q<any[]>(sb().from("profiles").select("company_id").in("company_id", ids)),
  ]);
  const ec = new Map<string, number>(); for (const e of emps) ec.set(e.company_id, (ec.get(e.company_id) ?? 0) + 1);
  const uc = new Map<string, number>(); for (const p of profs) if (p.company_id) uc.set(p.company_id, (uc.get(p.company_id) ?? 0) + 1);
  return cs.map((c) => ({ ...c, employee_count: ec.get(c.id) ?? 0, user_count: uc.get(c.id) ?? 0 }));
}
export async function addCompany(f: { name: string; prefix: string; email: string; phone: string }) {
  const cleanPrefix = f.prefix.trim().toUpperCase();
  const { error } = await sb().from("companies").insert({
    name: f.name.trim(), contact_email: f.email.trim() || null, contact_phone: f.phone.trim() || null,
    ...(cleanPrefix ? { invoice_settings: { company_prefix: cleanPrefix } } : {}),
  } as never);
  if (error) {
    throw new Error(error.code === "23505" || /companies_company_prefix_unique/.test(error.message)
      ? `Prefix "${cleanPrefix}" is already used by another company. Choose a different one.` : error.message);
  }
}
export const setCompanyActive = (id: string, active: boolean) => q(sb().from("companies").update({ active } as never).eq("id", id));
export async function setViewAsCompany(profileId: string, companyId: string | null) {
  const { data } = await sb().auth.getSession();
  if (!data.session) throw new Error("Your session has expired. Sign in again to switch company.");
  await q(sb().from("profiles").update({ view_as_company: companyId } as never).eq("id", profileId));
}
export const loadSubscriptionPayments = (companyId: string) => q<any[]>(sb().from("subscription_payments").select("*").eq("company_id", companyId).order("created_at", { ascending: false }));
export async function addSubscriptionPayment(companyId: string, f: { amount: string; days: string; date: string; notes: string }) {
  const amt = Number(f.amount);
  const days = Number(f.days);
  if (!Number.isFinite(amt) || amt < 0) throw new Error("Amount must be a non-negative number.");
  if (!Number.isInteger(days) || days <= 0) throw new Error("Days must be a positive integer.");
  await rpc("add_subscription_payment", { p_company_id: companyId, p_amount: amt, p_days: days, p_payment_date: f.date, p_notes: f.notes.trim() || null });
}
export async function loadCompanyDetail(id: string) {
  const [company, users] = await Promise.all([
    q<any>(sb().from("companies").select("*").eq("id", id).maybeSingle()),
    q<ProfileRow[]>(sb().from("profiles").select("*").eq("company_id", id).order("created_at", { ascending: true })),
  ]);
  return { company, users };
}
export async function inviteCompanyAdmin(companyId: string, f: { email: string; password: string; name: string; title: string }) {
  const res = await callCreateUser({ email: f.email.trim(), password: f.password, role: "super_admin", title: f.title.trim() || null, company_id: companyId, full_name: f.name.trim() || null });
  if ("error" in res) throw new Error(res.error ?? "Failed to create user");
}
