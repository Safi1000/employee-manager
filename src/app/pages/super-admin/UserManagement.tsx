import { useEffect, useState } from "react";
import { Plus, Search, Loader2, UserPlus, Pencil, Trash2, KeyRound } from "lucide-react";
import Header from "../../components/Header";
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

const ROLE_LABEL: Record<UserRole, string> = {
  super_super_admin: "Super Super Admin",
  super_admin: "Super Admin",
  hr: "HR",
  accounting: "Accounting",
};

const displayLabel = (u: Profile) => u.title?.trim() || ROLE_LABEL[u.role];

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
          <h4 className="text-xs uppercase tracking-wider text-slate-500 mb-2">{group.label}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {group.items.map((item) => (
              <label
                key={item.key}
                className={`flex items-start gap-2 text-sm text-slate-700 ${
                  disabled ? "opacity-50" : "cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.key)}
                  onChange={() => onToggle(item.key)}
                  disabled={disabled}
                  className="mt-0.5 rounded border-slate-300"
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
  const { profile } = useAuth();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");

  // Create
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [title, setTitle] = useState("");
  const [createBranchId, setCreateBranchId] = useState<string>("");
  const [createPerms, setCreatePerms] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // Edit
  const [editUser, setEditUser] = useState<Profile | null>(null);
  const [editName, setEditName] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editBranchId, setEditBranchId] = useState<string>("");
  const [editPerms, setEditPerms] = useState<Set<string>>(new Set());
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [branches, setBranches] = useState<Branch[]>([]);

  // Reset password
  const [resetPwUserId, setResetPwUserId] = useState<string | null>(null);
  const [resetPwValue, setResetPwValue] = useState("");
  const [resetPwSubmitting, setResetPwSubmitting] = useState(false);
  const [resetPwSuccess, setResetPwSuccess] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [usersRes, branchesRes] = await Promise.all([
      supabase.from("profiles").select("*").order("created_at", { ascending: true }),
      supabase
        .from("branches")
        .select("*")
        .order("is_head_office", { ascending: false })
        .order("name"),
    ]);
    if (usersRes.error) setError(usersRes.error.message);
    if (branchesRes.error) setError(branchesRes.error.message);
    setUsers((usersRes.data as Profile[]) ?? []);
    setBranches((branchesRes.data ?? []) as Branch[]);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const togglePerm = (set: Set<string>, setSet: (s: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSet(next);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.company_id) {
      setError("Cannot determine your company.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await callCreateUser({
      email: email.trim(),
      password,
      title: title.trim() || null,
      company_id: profile.company_id,
      branch_id: createBranchId || null,
      full_name: fullName.trim() || null,
      permissions: Array.from(createPerms),
    });
    setSubmitting(false);
    if ("error" in res) {
      setError(res.error ?? "Failed to create user");
      return;
    }
    setEmail("");
    setFullName("");
    setPassword("");
    setTitle("");
    setCreateBranchId("");
    setCreatePerms(new Set());
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
    setEditPerms(new Set(u.permissions ?? []));
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
    setEditSubmitting(true);
    setError(null);
    const { error: err } = await supabase
      .from("profiles")
      .update({
        full_name: editName.trim() || null,
        title: editTitle.trim() || null,
        branch_id: editBranchId || null,
        permissions: Array.from(editPerms),
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
        title="User Management"
        actions={
          <Button variant="primary" size="md" onClick={() => setCreateOpen(true)}>
            <UserPlus className="w-4 h-4 mr-2" strokeWidth={1.5} />
            Create User
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {error && <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-4 py-2 rounded mb-4">{error}</div>}

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-4 md:p-6 border-b border-slate-200 flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
              <input
                type="text"
                placeholder="Search by name, email, or title…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <div className="p-8 flex items-center gap-2 text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="p-12 text-center">
                <Plus className="w-8 h-8 text-slate-300 mx-auto mb-2" strokeWidth={1.5} />
                <p className="text-slate-500 text-sm">No users match your filters.</p>
              </div>
            ) : (
              <table className="w-full min-w-[720px]">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Name</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Email</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Title</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Branch</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Permissions</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filtered.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="px-6 py-4 text-sm text-slate-900">{u.full_name ?? "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{u.email ?? "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {displayLabel(u)}
                        {showImplicitAll(u.role) && (
                          <span className="ml-2 text-xs text-brand-600">(admin)</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {u.branch_id
                          ? branches.find((b) => b.id === u.branch_id)?.name ?? "—"
                          : <span className="text-xs text-slate-400">All branches</span>}
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {showImplicitAll(u.role) ? (
                          <span className="text-xs px-2 py-1 rounded bg-brand-50 text-brand-700">All (implicit)</span>
                        ) : (u.permissions?.length ?? 0) === 0 ? (
                          <span className="text-xs text-slate-400">None</span>
                        ) : (
                          <span className="text-xs text-slate-700">{u.permissions.length} feature{u.permissions.length === 1 ? "" : "s"}</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="inline-flex gap-1">
                          <button
                            onClick={() => openEdit(u)}
                            className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
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
                            disabled={u.id === profile?.id}
                            className="p-1.5 rounded text-danger-600 hover:bg-danger-50 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={u.id === profile?.id ? "Cannot delete yourself" : "Delete"}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="Create User" size="lg">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Full Name</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Email *</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Title *</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                placeholder="e.g. CEO, CTO, HR Manager"
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              />
              <p className="text-xs text-slate-500 mt-1">Free-form label. Use whatever fits.</p>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Temporary Password *</label>
              <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm font-mono"
              />
              <p className="text-xs text-slate-500 mt-1">At least 8 chars. Share securely.</p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Branch</label>
              <select
                value={createBranchId}
                onChange={(e) => setCreateBranchId(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">No branch — unrestricted (Head Office admin)</option>
                {branches.filter((b) => !b.is_head_office).map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <p className="text-xs text-slate-500 mt-1">
                If set, this user can only see and act on data inside the chosen branch. Leave empty for company-wide access.
              </p>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm text-slate-900">Permissions</h3>
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
                  className="text-xs text-slate-500 hover:underline"
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
                <label className="block text-sm text-slate-700 mb-1">Full Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Title</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="e.g. CEO, CTO, HR Manager"
                  disabled={editUser.role === "super_admin"}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-500"
                />
                {editUser.role === "super_admin" && (
                  <p className="text-xs text-brand-600 mt-1">This user is a Super Admin — implicit full access.</p>
                )}
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm text-slate-700 mb-1">Branch</label>
                <select
                  value={editBranchId}
                  onChange={(e) => setEditBranchId(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                >
                  <option value="">No branch — unrestricted (Head Office admin)</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  Empty = company-wide access. Set a branch to scope this user's view to that branch only.
                </p>
              </div>
            </div>

            {editUser.role !== "super_admin" && (
              <div className="pt-4 border-t border-slate-200">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm text-slate-900">Permissions</h3>
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
                      className="text-xs text-slate-500 hover:underline"
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
            <p className="text-xs text-slate-500 mt-1">The user will be prompted to set a new password on next login.</p>
          </div>
        ) : (
          <form onSubmit={handleResetPassword} className="space-y-4">
            <p className="text-sm text-slate-600">
              Set a new temporary password for this user. They will be required to change it on their next login.
            </p>
            <div>
              <label className="block text-sm text-slate-700 mb-1">New Temporary Password</label>
              <input
                type="text"
                value={resetPwValue}
                onChange={(e) => setResetPwValue(e.target.value)}
                required
                minLength={8}
                placeholder="At least 8 characters"
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
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
    </>
  );
}
