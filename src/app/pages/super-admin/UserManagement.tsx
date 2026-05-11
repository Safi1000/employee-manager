import { useEffect, useState } from "react";
import { Plus, Search, Loader2, UserPlus } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { supabase, type Profile, type UserRole } from "../../lib/supabase";
import { callCreateUser, useAuth } from "../../lib/auth";

const ROLE_LABEL: Record<UserRole, string> = {
  super_super_admin: "Super Super Admin",
  super_admin: "Super Admin",
  hr: "HR",
  accounting: "Accounting",
};

type CreatableRole = "super_admin" | "hr" | "accounting";

export default function UserManagement() {
  const { profile } = useAuth();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | CreatableRole>("all");

  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<CreatableRole>("hr");
  const [submitting, setSubmitting] = useState(false);

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
    setCreateOpen(false);
    await loadAll();
  };

  const filtered = users.filter((u) => {
    if (roleFilter !== "all" && u.role !== roleFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      (u.full_name ?? "").toLowerCase().includes(q) ||
      (u.email ?? "").toLowerCase().includes(q)
    );
  });

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

      <div className="flex-1 overflow-y-auto p-8">
        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-2 rounded mb-4">{error}</div>}

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200 flex items-center gap-4">
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
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Name</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Email</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Role</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filtered.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="px-6 py-4 text-sm text-slate-900">{u.full_name ?? "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{u.email ?? "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{ROLE_LABEL[u.role]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="Create User" size="md">
        <form onSubmit={handleCreate} className="space-y-4">
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
            <p className="text-xs text-slate-500 mt-1">At least 8 characters. Share with the user securely.</p>
          </div>
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
    </>
  );
}
