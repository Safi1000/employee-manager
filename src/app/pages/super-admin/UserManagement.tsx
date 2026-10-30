import { useEmployeeCodeIndex } from "../../lib/employeeCodes";
import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Plus, Search, Loader2, UserPlus, Pencil, Trash2, KeyRound, ShieldCheck } from "lucide-react";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";
import Header from "../../components/Header";
import MobileCardList from "../../components/MobileCardList";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import {
  supabase,
  type Profile,
  type UserRole,
  type Branch,
  PERMISSION_GROUPS,
} from "../../lib/supabase";
import { callCreateUser, callChangePassword, useAuth } from "../../lib/auth";
import { usePageState } from "../../lib/pageState";
import UserSecurityModal, { deviceLabel, type UserSecurity } from "../../components/UserSecurityModal";
import DrivePrivacyCard from "../../components/DrivePrivacyCard";
import BackupCard from "../../components/BackupCard";
import SecurityDigestCard from "../../components/SecurityDigestCard";

const ROLE_LABEL: Record<UserRole, string> = {
  super_super_admin: "Super Super Admin",
  super_admin: "Super Admin",
  hr: "HR",
  accounting: "Accounting",
  ops_manager: "Manager Ops",
  ops_director: "Director Ops",
  finance_director: "Director Finance",
};

const displayLabel = (u: Profile) => u.title?.trim() || ROLE_LABEL[u.role];

// Roles assignable from this screen (super_super_admin is a platform role, never
// assigned here). Order = seniority for the dropdown.
const ASSIGNABLE_ROLES: UserRole[] = [
  "super_admin", "ops_director", "finance_director", "ops_manager", "accounting", "hr",
];

function PermissionCheckboxes({
  selected,
  onToggle,
  disabled,
}: {
  selected: Set<string>;
  onToggle: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-4">
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.label}>
          <h4 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">{group.label}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {group.items.map((item) => (
              <label
                key={item.key}
                className={`flex items-start gap-2 text-sm text-foreground ${
                  disabled ? "opacity-50" : "cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.key)}
                  onChange={() => onToggle(item.key)}
                  disabled={disabled}
                  className="mt-0.5 rounded border-border"
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function UserManagement() {
  const codeIndex = useEmployeeCodeIndex();
  const { profile, company } = useAuth();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = usePageState("UserManagement.search", "");

  // Create
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [title, setTitle] = useState("");
  const [createBranchId, setCreateBranchId] = useState<string>("");
  const [createPerms, setCreatePerms] = useState<Set<string>>(new Set());
  // User type + partner scope (0314). 'partner' reveals a partner multi-select;
  // the chosen partner ids scope the Partnership Report for this user.
  const [createUserType, setCreateUserType] = useState<"office_staff" | "partner">("office_staff");
  const [createEmployeeId, setCreateEmployeeId] = useState<string>("");
  const [createPartnerScope, setCreatePartnerScope] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // Edit
  const [editUser, setEditUser] = useState<Profile | null>(null);
  const [editName, setEditName] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editBranchId, setEditBranchId] = useState<string>("");
  const [editRole, setEditRole] = useState<UserRole>("hr");
  const [editPerms, setEditPerms] = useState<Set<string>>(new Set());
  const [editUserType, setEditUserType] = useState<"office_staff" | "partner">("office_staff");
  const [editEmployeeId, setEditEmployeeId] = useState<string>("");
  const [editPartnerScope, setEditPartnerScope] = useState<Set<string>>(new Set());
  const [editSubmitting, setEditSubmitting] = useState(false);

  // Only a Super Super Admin may create/demote/delete a Super Admin (mirrors the
  // password-reset rule). A plain Super Admin manages everyone else freely but
  // cannot touch another Super Admin's role or existence.
  const isSSA = profile?.role === "super_super_admin";

  const [branches, setBranches] = useState<Branch[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Partners in the company, for the Partner-scope multi-select (0314).
  const [partnersList, setPartnersList] = useState<{ id: string; name: string }[]>([]);
  // Employees in the company, for the single-employee link (0424).
  const [employeesList, setEmployeesList] = useState<
    { id: string; full_name: string; employee_code: string | null }[]
  >([]);
  // Which employees already belong to another login. One employee, one account —
  // offering a taken one would fail on the unique index with a raw Postgres error.
  const [linkedEmployeeIds, setLinkedEmployeeIds] = useState<Map<string, string>>(new Map());

  // Reset password
  const [resetPwUserId, setResetPwUserId] = useState<string | null>(null);
  const [resetPwValue, setResetPwValue] = useState("");
  const [resetPwSubmitting, setResetPwSubmitting] = useState(false);
  const [resetPwSuccess, setResetPwSuccess] = useState(false);

  // Two-factor, last login and disabled state per login (0591, users.manage).
  const [security, setSecurity] = useState<Map<string, UserSecurity>>(new Map());
  const [securityUser, setSecurityUser] = useState<Profile | null>(null);
  const loadSecurity = async () => {
    const { data } = await supabase.rpc("user_security_overview");
    setSecurity(new Map(((data ?? []) as UserSecurity[]).map((r) => [r.user_id, r])));
  };

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [usersRes, branchesRes, partnersRes, empRes] = await Promise.all([
      supabase.from("profiles").select("*").order("created_at", { ascending: true }),
      supabase
        .from("branches")
        .select("*")
        .order("is_head_office", { ascending: false })
        .order("name"),
      supabase.from("partners").select("id, name").order("name"),
      // Serving staff only: a login belongs to somebody who still works here.
      supabase
        .from("employees")
        .select("id, full_name, employee_code")
        .eq("lifecycle_state", "active")
        .order("full_name")
        .range(0, 9999),
    ]);
    if (usersRes.error) setError(usersRes.error.message);
    if (branchesRes.error) setError(branchesRes.error.message);
    // Field (site-supervisor) logins are managed by the Field accounts card. The
    // edit form here would rewrite user_type to office_staff and lift the
    // field-app lock (0607), so they never appear in this list.
    setUsers(((usersRes.data as Profile[]) ?? []).filter((u) => u.user_type !== "site_supervisor"));
    setBranches((branchesRes.data ?? []) as Branch[]);
    setPartnersList((partnersRes.data ?? []) as { id: string; name: string }[]);
    setEmployeesList(
      (empRes.data ?? []) as { id: string; full_name: string; employee_code: string | null }[],
    );
    const taken = new Map<string, string>();
    for (const u of ((usersRes.data ?? []) as Profile[])) {
      if (u.employee_id) taken.set(u.employee_id, u.full_name ?? u.email ?? "another user");
    }
    setLinkedEmployeeIds(taken);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
    void loadSecurity();
  }, []);

  const togglePerm = (set: Set<string>, setSet: (s: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSet(next);
  };

  // User Type + Partner scope, shared by the Create and Edit forms. Choosing
  // "Partner" reveals a partner checklist; the picked partner ids scope the
  // Partnership Report for this user (enforced by RLS, migration 0314). Mirrors
  // the branch-scope philosophy: unset/Office Staff = unscoped (all partners).
  const renderUserTypeFields = (
    userType: "office_staff" | "partner",
    setUserType: (t: "office_staff" | "partner") => void,
    scope: Set<string>,
    setScope: (s: Set<string>) => void,
    employeeId: string,
    setEmployeeId: (id: string) => void,
    // The user being edited, so their OWN current link is not reported as taken
    // by somebody else.
    selfId?: string | null,
  ) => (
    <div className="md:col-span-2">
      <label className="block text-sm text-foreground mb-1">User Type</label>
      <ThemedSelect
        value={userType}
        onChange={(e) => setUserType(e.target.value === "partner" ? "partner" : "office_staff")}
        className="w-full px-4 py-2 border border-border rounded-md text-sm"
      >
        <option value="office_staff">Office Staff</option>
        <option value="partner">Partner</option>
      </ThemedSelect>
      {/* Employee link (0424). Offered only for Office Staff: a profile cannot be
          both employee-linked and partner-scoped — the two are different people
          and a check constraint refuses the pair. */}
      {userType !== "partner" && (
        <div className="mt-3">
          <label className="block text-sm text-foreground mb-1">Linked employee (optional)</label>
          <ThemedSelect
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="w-full px-4 py-2 border border-border rounded-md text-sm"
          >
            <option value="">Not linked — an ordinary admin account</option>
            {employeesList.map((emp) => {
              const takenBy = linkedEmployeeIds.get(emp.id);
              const taken = !!takenBy && emp.id !== (selfId ?? "__none__");
              return (
                <option key={emp.id} value={emp.id} disabled={taken}>
                  {(codeIndex.byId.get(emp.id) ?? emp.employee_code) ? `${codeIndex.byId.get(emp.id) ?? emp.employee_code} · ` : ""}{emp.full_name}
                  {taken ? ` — already linked to ${takenBy}` : ""}
                </option>
              );
            })}
          </ThemedSelect>
          <p className="text-xs text-muted-foreground mt-1">
            Gives this login a <strong>My Profile</strong> page showing that employee&rsquo;s own
            record, attendance, payslips, advances and cash. It <strong>adds</strong> access rather
            than removing it: where the user holds no governing permission, the database also
            restricts them to that one employee&rsquo;s rows; where they do hold it, their view is
            unchanged. One employee, one login.
          </p>
        </div>
      )}
      {userType === "partner" && (
        <div className="mt-3">
          <label className="block text-sm text-foreground mb-1">Partners this user represents</label>
          {partnersList.length === 0 ? (
            <p className="text-xs text-muted-foreground">No partners in this company yet.</p>
          ) : (
            <div className="border border-border rounded-md divide-y divide-border max-h-48 overflow-y-auto">
              {partnersList.map((p) => (
                <label key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50">
                  <input type="checkbox" checked={scope.has(p.id)} onChange={() => togglePerm(scope, setScope, p.id)} />
                  {p.name}
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            The Partnership Report shows ONLY the selected partners' data. None selected = this user sees no partner data.
            Requires the Partnership Report view permission as well — this only narrows which partners are visible.
          </p>
        </div>
      )}
    </div>
  );

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    // SSA has no company_id of their own — they act on the company they're
    // viewing as, which the auth context exposes as `company`. Fall back to
    // profile.company_id for super_admin / hr / accounting.
    const companyId = company?.id ?? profile?.company_id ?? null;
    if (!companyId) {
      setError("Cannot determine your company.");
      return;
    }
    // Caught here as well as in the edge function and the DB index, purely so
    // the operator is told before the round trip. The authority is
    // profiles_email_unique (migration 0189) — `users` only holds the accounts
    // this admin can see, so it cannot rule on an address in another company.
    const typed = email.trim().toLowerCase();
    if (users.some((u) => (u.email ?? "").trim().toLowerCase() === typed)) {
      setError(`A user with the email ${typed} already exists.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await callCreateUser({
      email: email.trim(),
      password,
      title: title.trim() || null,
      company_id: companyId,
      branch_id: createBranchId || null,
      full_name: fullName.trim() || null,
      permissions: Array.from(createPerms),
    });
    setSubmitting(false);
    if ("error" in res) {
      // email_taken can come back even when the pre-check passed: the address
      // may belong to a user in another company, which this admin cannot see.
      setError(
        res.error === "email_taken"
          ? `A user with the email ${email.trim().toLowerCase()} already exists. Emails must be unique across the whole system, including other companies.`
          : res.error ?? "Failed to create user",
      );
      return;
    }
    // User type + partner scope aren't part of the create-user edge function, so
    // stamp them onto the fresh profile here (same channel the Edit form uses).
    if ("user_id" in res && res.user_id) {
      const { error: scopeErr } = await supabase
        .from("profiles")
        .update({
          user_type: createUserType,
          partner_scope: createUserType === "partner" ? Array.from(createPartnerScope) : null,
          employee_id: createUserType === "partner" ? null : createEmployeeId || null,
        })
        .eq("id", res.user_id);
      if (scopeErr) { setError(scopeErr.message); return; }
    }
    setEmail("");
    setFullName("");
    setPassword("");
    setTitle("");
    setCreateBranchId("");
    setCreatePerms(new Set());
    setCreateUserType("office_staff");
    setCreatePartnerScope(new Set());
    setCreateEmployeeId("");
    setCreateOpen(false);
    await loadAll();
  };

  const openEdit = (u: Profile) => {
    setEditUser(u);
    setEditName(u.full_name ?? "");
    setEditTitle(u.title ?? "");
    // Head Office branch is no longer offered as a per-user scope; legacy users
    // pinned to it surface as "No branch — unrestricted (Head Office admin)".
    const headOfficeId = branches.find((b) => b.is_head_office)?.id ?? null;
    const branchId = u.branch_id && u.branch_id === headOfficeId ? "" : (u.branch_id ?? "");
    setEditBranchId(branchId);
    setEditRole(u.role);
    setEditPerms(new Set(u.permissions ?? []));
    setEditUserType(u.user_type === "partner" ? "partner" : "office_staff");
    setEditPartnerScope(new Set(u.partner_scope ?? []));
    setEditEmployeeId(u.employee_id ?? "");
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
    // Guard: touching Super Admin status (demoting one, or promoting someone to
    // it) is reserved for the Super Super Admin. Non-SSA edits keep the role as-is.
    const roleTouchesAdmin = editUser.role === "super_admin" || editRole === "super_admin";
    if (roleTouchesAdmin && editRole !== editUser.role && !isSSA) {
      setError("Only a Super Super Admin can change a Super Admin's role.");
      return;
    }
    const nextRole = isSSA ? editRole : (roleTouchesAdmin ? editUser.role : editRole);
    setEditSubmitting(true);
    setError(null);
    const { error: err } = await supabase
      .from("profiles")
      .update({
        full_name: editName.trim() || null,
        title: editTitle.trim() || null,
        branch_id: editBranchId || null,
        role: nextRole,
        // A Super Admin has implicit full access — don't persist a per-feature
        // list for them (kept empty), so demoting later starts from a clean slate.
        permissions: nextRole === "super_admin" ? [] : Array.from(editPerms),
        user_type: editUserType,
        // Empty array when Partner with none picked = sees no partners (not all);
        // null when Office Staff = unscoped.
        partner_scope: editUserType === "partner" ? Array.from(editPartnerScope) : null,
        // Switching a user to Partner drops any employee link: the constraint
        // refuses both, and silently keeping the old value would make the save
        // fail with a constraint name instead of doing what was asked.
        employee_id: editUserType === "partner" ? null : editEmployeeId || null,
      })
      .eq("id", editUser.id);
    setEditSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setEditUser(null);
    await loadAll();
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPwUserId) return;
    setResetPwSubmitting(true);
    setError(null);
    const res = await callChangePassword({
      new_password: resetPwValue,
      target_user_id: resetPwUserId,
    });
    setResetPwSubmitting(false);
    if ("error" in res && res.error) {
      const msg = res.error === "only_super_super_admin_can_change_super_admin_password"
        ? "Only Super Super Admin can reset a Super Admin's password."
        : res.error;
      setError(msg);
      return;
    }
    setResetPwSuccess(true);
    setTimeout(() => {
      setResetPwUserId(null);
      setResetPwValue("");
      setResetPwSuccess(false);
    }, 2000);
  };

  const handleDelete = async (u: Profile) => {
    if (u.id === profile?.id) {
      setError("You can't delete your own account.");
      return;
    }
    if (u.role === "super_admin" && !isSSA) {
      setError("Only a Super Super Admin can delete a Super Admin.");
      return;
    }
    if (!window.confirm(`Delete user ${u.email}? This removes their access and profile.`)) return;
    // Delete profile (auth.users delete requires admin; profile removal effectively blocks access via RLS).
    const { error: err } = await supabase.from("profiles").delete().eq("id", u.id);
    if (err) {
      setError(err.message);
      return;
    }
    await loadAll();
  };

  const filtered = users
    .filter((u) => u.role !== "super_super_admin")
    .filter((u) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (
        (u.full_name ?? "").toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q) ||
        (u.title ?? "").toLowerCase().includes(q)
      );
    });

  const showImplicitAll = (role: UserRole) => role === "super_admin" || role === "super_super_admin";

  return (
    <>
      <Header
        title="Users & Permissions"
        subtitle="Access control, permissions and branch scope"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="md" onClick={() => setReviewOpen(true)}>
              <ShieldCheck className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Review access
            </Button>
            <Button variant="primary" size="md" onClick={() => setCreateOpen(true)}>
              <UserPlus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Create User
            </Button>
          </div>
        }
      >
        {users.length > 0 && (() => {
          // Band (2026-10-20): who can get in, and how far. Super admins hold
          // every permission implicitly; everyone else holds what is ticked.
          const byRole = new Map<string, number>();
          for (const u of users) byRole.set(u.role, (byRole.get(u.role) ?? 0) + 1);
          const scoped = users.filter((u) => u.branch_id).length;
          const temp = users.filter((u) => u.must_change_password).length;
          const isSuper = (u: Profile) => u.role === "super_admin" || u.role === "super_super_admin";
          const accountant = users.filter((u) => isSuper(u) || (u.permissions ?? []).includes("accountant.view")).length;
          const noAccess = users.filter((u) => !isSuper(u) && (u.permissions?.length ?? 0) === 0).length;
          return (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
              <div className="col-span-2 rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-2">
                <span className="lbl">{users.length} users by role</span>
                <div className="flex flex-wrap gap-1.5">
                  {[...byRole.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => (
                    <span key={r} className="text-xs px-2.5 py-1 rounded-lg border border-border">{ROLE_LABEL[r as UserRole] ?? r} <span className="font-ledger font-semibold">{n}</span></span>
                  ))}
                </div>
              </div>
              {[
                { label: "Scoped to a region", v: scoped, sub: `${users.length - scoped} see every region`, tone: "text-foreground" },
                { label: "Accountant page", v: accountant, sub: "can open it (incl. super admins)", tone: "text-foreground" },
                { label: "Need attention", v: temp + noAccess, sub: `${temp} on a temporary password · ${noAccess} with no permissions`, tone: temp + noAccess ? "text-heed" : "text-up" },
              ].map((t) => (
                <div key={t.label} className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
                  <span className="lbl">{t.label}</span><span className={`font-ledger text-2xl font-semibold leading-none ${t.tone}`}>{t.v}</span><span className="text-xs text-muted-foreground">{t.sub}</span>
                </div>
              ))}
            </div>
          );
        })()}
      </Header>

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
        {error && <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-4 py-2 rounded mb-4">{error}</div>}

        {(profile?.role === "super_admin" || profile?.role === "super_super_admin") && (<><SecurityDigestCard companyId={company?.id ?? profile?.company_id ?? null} /><BackupCard /><DrivePrivacyCard /></>)}
        {profile?.role === "super_admin" && (
          <Link to="/app/field-supervisors" className="mb-4 flex items-center justify-between gap-2 rounded-2xl border border-border bg-card p-4 text-sm hover:bg-muted/30 md:p-5">
            <span><span className="font-semibold text-foreground">Field accounts</span> <span className="text-muted-foreground">— supervisor logins, phones and their sites now live on Operations ▸ Field Supervisors.</span></span>
            <span className="whitespace-nowrap text-brand-700 dark:text-brand-500">Open →</span>
          </Link>
        )}

        <div className="bg-card rounded-2xl border border-border">
          <div className="p-4 md:p-6 border-b border-border flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/70" strokeWidth={1.5} />
              <input
                type="text"
                placeholder="Search by name, email, or title…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <div className="p-8 flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="p-12 text-center">
                <Plus className="w-8 h-8 text-muted-foreground/50 mx-auto mb-2" strokeWidth={1.5} />
                <p className="text-muted-foreground text-sm">No users match your filters.</p>
              </div>
            ) : (
              <>
              {/* Phone: one card per user. The table carries a 720px minimum
                  width, so on a handset it was pure side-scrolling. */}
              <MobileCardList
                rows={filtered}
                rowKey={(u) => u.id}
                title={(u) => u.full_name ?? "—"}
                subtitle={(u) => u.email ?? ""}
                badge={(u) =>
                  showImplicitAll(u.role) ? (
                    <span className="text-xs px-2 py-1 rounded bg-brand-50 text-brand-700">All (implicit)</span>
                  ) : (u.permissions?.length ?? 0) === 0 ? (
                    <span className="text-xs text-muted-foreground">No permissions</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {u.permissions.length} feature{u.permissions.length === 1 ? "" : "s"}
                    </span>
                  )
                }
                fields={[
                  {
                    label: "Title",
                    value: (u) => (
                      <>
                        {displayLabel(u)}
                        {showImplicitAll(u.role) && <span className="ml-1 text-xs text-brand-600">(admin)</span>}
                      </>
                    ),
                  },
                  {
                    label: "Branch",
                    value: (u) =>
                      u.branch_id
                        ? branches.find((b) => b.id === u.branch_id)?.name ?? "—"
                        : "All branches",
                  },
                ]}
                actions={(u) => (
                  <>
                    <button
                      onClick={() => setSecurityUser(u)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground"
                    >
                      <ShieldCheck className="w-4 h-4" /> Security
                    </button>
                    <button
                      onClick={() => openEdit(u)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground"
                    >
                      <Pencil className="w-4 h-4" /> Edit
                    </button>
                    <button
                      onClick={() => { setResetPwUserId(u.id); setResetPwValue(""); setResetPwSuccess(false); }}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-warning-600"
                    >
                      <KeyRound className="w-4 h-4" /> Reset password
                    </button>
                    <button
                      onClick={() => handleDelete(u)}
                      disabled={u.id === profile?.id || (u.role === "super_admin" && !isSSA)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-danger-600 disabled:opacity-30"
                      title={
                        u.id === profile?.id
                          ? "Cannot delete yourself"
                          : u.role === "super_admin" && !isSSA
                            ? "Only a Super Super Admin can delete a Super Admin"
                            : "Delete"
                      }
                    >
                      <Trash2 className="w-4 h-4" /> Delete
                    </button>
                  </>
                )}
              />

              <div className="hidden md:block overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-6 py-3 text-sm text-muted-foreground">Name</th>
                      <th className="text-left px-6 py-3 text-sm text-muted-foreground">Email</th>
                      <th className="text-left px-6 py-3 text-sm text-muted-foreground">Title</th>
                      <th className="text-left px-6 py-3 text-sm text-muted-foreground">Branch</th>
                      <th className="text-left px-6 py-3 text-sm text-muted-foreground">Permissions</th>
                      <th className="text-left px-6 py-3 text-sm text-muted-foreground">Security</th>
                      <th className="text-right px-6 py-3 text-sm text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filtered.map((u) => (
                      <tr key={u.id} className="hover:bg-muted/50">
                        <td className="px-6 py-4 text-sm text-foreground">{u.full_name ?? "—"}</td>
                        <td className="px-6 py-4 text-sm text-muted-foreground">{u.email ?? "—"}</td>
                        <td className="px-6 py-4 text-sm text-muted-foreground">
                          {displayLabel(u)}
                          {showImplicitAll(u.role) && (
                            <span className="ml-2 text-xs text-brand-600">(admin)</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-muted-foreground">
                          {u.branch_id
                            ? branches.find((b) => b.id === u.branch_id)?.name ?? "—"
                            : <span className="text-xs text-muted-foreground/70">All branches</span>}
                        </td>
                        <td className="px-6 py-4 text-sm text-muted-foreground">
                          {showImplicitAll(u.role) ? (
                            <span className="text-xs px-2 py-1 rounded bg-brand-50 text-brand-700">All (implicit)</span>
                          ) : (u.permissions?.length ?? 0) === 0 ? (
                            <span className="text-xs text-muted-foreground/70">None</span>
                          ) : (
                            <span className="text-xs text-foreground">{u.permissions.length} feature{u.permissions.length === 1 ? "" : "s"}</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-xs">
                          {(() => {
                            const sec = security.get(u.id);
                            if (!sec) return <span className="text-muted-foreground/70">—</span>;
                            return (
                              <div className="flex flex-col gap-0.5">
                                <span className={sec.disabled_at ? "font-semibold text-down" : sec.two_factor ? "text-up" : "text-heed"}>
                                  {sec.disabled_at ? "Disabled" : sec.two_factor ? "Two-factor on" : "Two-factor not set up"}
                                </span>
                                <span className="text-muted-foreground">
                                  {sec.last_login
                                    ? `${new Date(sec.last_login).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${deviceLabel(sec.last_device)}`
                                    : "Never logged in"}
                                </span>
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="inline-flex gap-1">
                            <button
                              onClick={() => setSecurityUser(u)}
                              className="p-1.5 rounded text-muted-foreground hover:bg-muted"
                              title="Security — two-factor, logins, sign out, disable"
                            >
                              <ShieldCheck className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => openEdit(u)}
                              className="p-1.5 rounded text-muted-foreground hover:bg-muted"
                              title="Edit"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => { setResetPwUserId(u.id); setResetPwValue(""); setResetPwSuccess(false); }}
                              className="p-1.5 rounded text-warning-600 hover:bg-warning-50"
                              title="Reset Password"
                            >
                              <KeyRound className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDelete(u)}
                              disabled={u.id === profile?.id || (u.role === "super_admin" && !isSSA)}
                              className="p-1.5 rounded text-danger-600 hover:bg-danger-50 disabled:opacity-30 disabled:cursor-not-allowed"
                              title={
                                u.id === profile?.id
                                  ? "Cannot delete yourself"
                                  : u.role === "super_admin" && !isSSA
                                    ? "Only a Super Super Admin can delete a Super Admin"
                                    : "Delete"
                              }
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>
        </div>
      </div>

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="Create User" size="lg">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-foreground mb-1">Full Name</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full px-4 py-2 border border-border rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Email *</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-2 border border-border rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Title *</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                placeholder="e.g. CEO, CTO, HR Manager"
                className="w-full px-4 py-2 border border-border rounded-md text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">Free-form label. Use whatever fits.</p>
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Temporary Password *</label>
              <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full px-4 py-2 border border-border rounded-md text-sm font-mono"
              />
              <p className="text-xs text-muted-foreground mt-1">At least 8 chars. Share securely.</p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm text-foreground mb-1">Branch</label>
              <ThemedSelect
                value={createBranchId}
                onChange={(e) => setCreateBranchId(e.target.value)}
                className="w-full px-4 py-2 border border-border rounded-md text-sm"
              >
                <option value="">No branch — unrestricted (Head Office admin)</option>
                {branches.filter((b) => !b.is_head_office).map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </ThemedSelect>
              <p className="text-xs text-muted-foreground mt-1">
                If set, this user can only see and act on data inside the chosen branch. Leave empty for company-wide access.
              </p>
            </div>
            {renderUserTypeFields(createUserType, setCreateUserType, createPartnerScope, setCreatePartnerScope, createEmployeeId, setCreateEmployeeId)}
          </div>

          <div className="pt-4 border-t border-border">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm text-foreground">Permissions</h3>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setCreatePerms(new Set(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key))))}
                  className="text-xs text-brand-600 hover:underline"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setCreatePerms(new Set())}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  Clear
                </button>
              </div>
            </div>
            <PermissionCheckboxes
              selected={createPerms}
              onToggle={(key) => togglePerm(createPerms, setCreatePerms, key)}
            />
          </div>

          {error && <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded">{error}</div>}
          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create User
            </Button>
            <Button type="button" variant="secondary" size="md" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!editUser} onClose={() => setEditUser(null)} title={`Edit ${editUser?.email ?? ""}`} size="lg">
        {editUser && (
          <form onSubmit={handleSaveEdit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-foreground mb-1">Full Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-foreground mb-1">Title</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="e.g. CEO, CTO, HR Manager"
                  className="w-full px-4 py-2 border border-border rounded-md text-sm disabled:bg-muted/50 disabled:text-muted-foreground"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm text-foreground mb-1">Role</label>
                <ThemedSelect
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as UserRole)}
                  disabled={editUser.role === "super_admin" && !isSSA}
                  className="w-full px-4 py-2 border border-border rounded-md text-sm disabled:bg-muted/50 disabled:text-muted-foreground"
                >
                  {ASSIGNABLE_ROLES.map((r) => (
                    // Assigning/keeping Super Admin is Super-Super-Admin-only.
                    <option key={r} value={r} disabled={r === "super_admin" && !isSSA}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </ThemedSelect>
                {editUser.role === "super_admin" && !isSSA && (
                  <p className="text-xs text-warning-600 mt-1">
                    Only a Super Super Admin can change or remove a Super Admin's role.
                  </p>
                )}
                {editRole === "super_admin" && (
                  <p className="text-xs text-brand-600 mt-1">Super Admin — implicit full access (no per-feature list).</p>
                )}
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm text-foreground mb-1">Branch</label>
                <ThemedSelect
                  value={editBranchId}
                  onChange={(e) => setEditBranchId(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-md text-sm"
                >
                  <option value="">No branch — unrestricted (Head Office admin)</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </ThemedSelect>
                <p className="text-xs text-muted-foreground mt-1">
                  Empty = company-wide access. Set a branch to scope this user's view to that branch only.
                </p>
              </div>
              {renderUserTypeFields(editUserType, setEditUserType, editPartnerScope, setEditPartnerScope, editEmployeeId, setEditEmployeeId, editUser?.id)}
            </div>

            {editRole !== "super_admin" && (
              <div className="pt-4 border-t border-border">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm text-foreground">Permissions</h3>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setEditPerms(new Set(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key))))}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditPerms(new Set())}
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <PermissionCheckboxes
                  selected={editPerms}
                  onToggle={(key) => togglePerm(editPerms, setEditPerms, key)}
                />
              </div>
            )}

            {error && <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded">{error}</div>}
            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" variant="primary" size="md" className="flex-1" disabled={editSubmitting}>
                {editSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
              <Button type="button" variant="secondary" size="md" onClick={() => setEditUser(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        isOpen={!!resetPwUserId}
        onClose={() => { setResetPwUserId(null); setResetPwValue(""); setResetPwSuccess(false); }}
        title="Reset Password"
        size="sm"
      >
        {resetPwSuccess ? (
          <div className="text-center py-4">
            <div className="w-12 h-12 bg-success-50 rounded-full flex items-center justify-center mx-auto mb-3">
              <KeyRound className="w-6 h-6 text-success-600" strokeWidth={1.5} />
            </div>
            <p className="text-sm text-success-700 font-medium">Password reset successfully!</p>
            <p className="text-xs text-muted-foreground mt-1">The user will be prompted to set a new password on next login.</p>
          </div>
        ) : (
          <form onSubmit={handleResetPassword} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Set a new temporary password for this user. They will be required to change it on their next login.
            </p>
            <div>
              <label className="block text-sm text-foreground mb-1">New Temporary Password</label>
              <input
                type="text"
                value={resetPwValue}
                onChange={(e) => setResetPwValue(e.target.value)}
                required
                minLength={8}
                placeholder="At least 8 characters"
                className="w-full px-4 py-2 border border-border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              />
            </div>
            {error && (
              <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded">{error}</div>
            )}
            <div className="flex items-center gap-3 pt-1">
              <Button type="submit" variant="primary" size="md" className="flex-1" disabled={resetPwSubmitting}>
                {resetPwSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Reset Password
              </Button>
              <Button type="button" variant="secondary" size="md" onClick={() => { setResetPwUserId(null); setResetPwValue(""); }}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>
      {reviewOpen && (() => {
        // ACCESS REVIEW (2026-10-21): who can do what that matters, for a
        // quarterly look. Super admins hold every key implicitly. Nothing is
        // saved; export it to keep the sign-off.
        const SENSITIVE: [string, string][] = [
          ["accounting.edit", "Edit banks & ledgers"], ["banks.view", "See bank balances"], ["payroll.edit", "Edit payroll"],
          ["payroll.approve", "Approve payroll"], ["expenses.approve", "Approve expenses"], ["invoices.edit", "Edit invoices"],
          ["reversals.execute", "Reverse actions"], ["users.manage", "Manage users"], ["accountant.view", "Accountant page"],
          ["planning.edit", "Edit plan & budget"], ["partnership.post", "Post partnership"], ["period_close.manage", "Close months"],
        ];
        const isSuperU = (u: Profile) => u.role === "super_admin" || u.role === "super_super_admin";
        const rows = [...users].sort((a, b) => Number(isSuperU(b)) - Number(isSuperU(a)) || (a.full_name ?? a.email ?? "").localeCompare(b.full_name ?? b.email ?? ""))
          .map((u) => {
            const held = isSuperU(u) ? SENSITIVE.map(([, l]) => l) : SENSITIVE.filter(([k]) => (u.permissions ?? []).includes(k)).map(([, l]) => l);
            return { u, held, region: branches.find((b) => b.id === u.branch_id)?.name ?? "Every region", total: isSuperU(u) ? "all" : String(u.permissions?.length ?? 0) };
          });
        return (
          <Modal isOpen onClose={() => setReviewOpen(false)} title="Access review" size="lg">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <p className="text-sm text-muted-foreground">Everyone who can sign in, and the sensitive things they can do. Untick anything that is no longer needed from each user's Edit.</p>
              <ExportButton onExport={() => exportTable({
                fileName: `Access review ${new Date().toISOString().slice(0, 10)}.xlsx`, sheetName: "Access",
                title: `Access review — ${new Date().toLocaleDateString()}`,
                headers: ["Name", "Email", "Role", "Region", "Permissions", "Sensitive access", "Reviewed by", "Keep / change"],
                rows: rows.map((r) => [r.u.full_name ?? "", r.u.email ?? "", ROLE_LABEL[r.u.role as UserRole] ?? r.u.role, r.region, r.total, r.held.join(", "), "", ""]),
              })} />
            </div>
            <div className="max-h-[60vh] overflow-y-auto divide-y divide-border border border-border rounded-xl">
              {rows.map((r) => (
                <div key={r.u.id} className="px-4 py-3 flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{r.u.full_name ?? r.u.email}</span>
                    <span className="text-xs text-muted-foreground">{ROLE_LABEL[r.u.role as UserRole] ?? r.u.role} · {r.region} · {r.total} permission{r.total === "1" ? "" : "s"}</span>
                  </div>
                  {r.held.length === 0 ? <span className="text-xs text-muted-foreground">No sensitive access</span> : (
                    <div className="flex flex-wrap gap-1">
                      {r.held.map((h) => <span key={h} className="text-[11px] px-2 py-0.5 rounded-full border border-warning-200 bg-warning-50 text-warning-700 dark:text-warning-500">{h}</span>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Modal>
        );
      })()}

      {securityUser && (
        <UserSecurityModal
          user={securityUser}
          security={security.get(securityUser.id) ?? null}
          onClose={() => setSecurityUser(null)}
          onChanged={() => void loadSecurity()}
        />
      )}
    </>
  );
}
