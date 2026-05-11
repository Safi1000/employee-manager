import { useEffect, useState } from "react";
import { Plus, Search, Loader2, UserPlus, Pencil, Trash2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import {
  supabase,
  type Profile,
  type UserRole,
  PERMISSION_GROUPS,
} from "../../lib/supabase";
import { callCreateUser, useAuth } from "../../lib/auth";

const ROLE_LABEL: Record<UserRole, string> = {
  super_super_admin: "Super Super Admin",
  super_admin: "Super Admin",
  hr: "HR",
  accounting: "Accounting",
};

type CreatableRole = "super_admin" | "hr" | "accounting";

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
  const [roleFilter, setRoleFilter] = useState<"all" | CreatableRole>("all");

  // Create
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<CreatableRole>("hr");
  const [createPerms, setCreatePerms] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // Edit
  const [editUser, setEditUser] = useState<Profile | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<CreatableRole>("hr");
  const [editPerms, setEditPerms] = useState<Set<string>>(new Set());
  const [editSubmitting, setEditSubmitting] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: true });
    if (err) setError(err.message);
    setUsers((data as Profile[]) ?? []);
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
      role,
      company_id: profile.company_id,
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
    setRole("hr");
    setCreatePerms(new Set());
    setCreateOpen(false);
    await loadAll();
  };

  const openEdit = (u: Profile) => {
    setEditUser(u);
    setEditName(u.full_name ?? "");
    setEditRole(
      (["super_admin", "hr", "accounting"] as const).includes(u.role as CreatableRole)
        ? (u.role as CreatableRole)
        : "hr",
    );
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
        role: editRole,
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
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (
        (u.full_name ?? "").toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q)
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
        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-2 rounded mb-4">{error}</div>}

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-4 md:p-6 border-b border-slate-200 flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
              <input
                type="text"
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as "all" | CreatableRole)}
              className="px-4 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="all">All Roles</option>
              <option value="super_admin">Super Admin</option>
              <option value="hr">HR</option>
              <option value="accounting">Accounting</option>
            </select>
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
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Role</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Permissions</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filtered.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="px-6 py-4 text-sm text-slate-900">{u.full_name ?? "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{u.email ?? "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{ROLE_LABEL[u.role]}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {showImplicitAll(u.role) ? (
                          <span className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-700">All (implicit)</span>
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
                            onClick={() => handleDelete(u)}
                            disabled={u.id === profile?.id}
                            className="p-1.5 rounded text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed"
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
              <label className="block text-sm text-slate-700 mb-1">Role *</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as CreatableRole)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="super_admin">Super Admin</option>
                <option value="hr">HR</option>
                <option value="accounting">Accounting</option>
              </select>
              <p className="text-xs text-slate-500 mt-1">
                {role === "super_admin"
                  ? "Super Admins implicitly get all permissions (checkboxes ignored)."
                  : "Specify exactly which features this user can access."}
              </p>
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
          </div>

          {role !== "super_admin" && (
            <div className="pt-4 border-t border-slate-200">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm text-slate-900">Permissions</h3>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setCreatePerms(new Set(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key))))}
                    className="text-xs text-blue-600 hover:underline"
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
          )}

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded">{error}</div>}
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
                <label className="block text-sm text-slate-700 mb-1">Role</label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as CreatableRole)}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                >
                  <option value="super_admin">Super Admin</option>
                  <option value="hr">HR</option>
                  <option value="accounting">Accounting</option>
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  {editRole === "super_admin"
                    ? "Super Admins implicitly get all permissions."
                    : "Specify exactly which features this user can access."}
                </p>
              </div>
            </div>

            {editRole !== "super_admin" && (
              <div className="pt-4 border-t border-slate-200">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm text-slate-900">Permissions</h3>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setEditPerms(new Set(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key))))}
                      className="text-xs text-blue-600 hover:underline"
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

            {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded">{error}</div>}
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
    </>
  );
}
