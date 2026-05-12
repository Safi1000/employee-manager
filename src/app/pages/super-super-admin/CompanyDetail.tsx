import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Plus, Loader2, UserPlus } from "lucide-react";
import Button from "../../components/Button";
import { supabase, type Company, type Profile, type UserRole } from "../../lib/supabase";
import { callCreateUser } from "../../lib/auth";

const ROLE_LABEL: Record<UserRole, string> = {
  super_super_admin: "Super Super Admin",
  super_admin: "Super Admin",
  hr: "HR",
  accounting: "Accounting",
};

const displayLabel = (u: Profile) => u.title?.trim() || ROLE_LABEL[u.role];

export default function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const [company, setCompany] = useState<Company | null>(null);
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePassword, setInvitePassword] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteTitle, setInviteTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadAll = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const [{ data: c, error: cErr }, { data: ps, error: pErr }] = await Promise.all([
      supabase.from("companies").select("*").eq("id", id).maybeSingle(),
      supabase.from("profiles").select("*").eq("company_id", id).order("created_at", { ascending: true }),
    ]);
    if (cErr) setError(cErr.message);
    if (pErr) setError(pErr.message);
    setCompany((c as Company) ?? null);
    setUsers((ps as Profile[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, [id]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setSubmitting(true);
    setError(null);
    // SSA always creates super_admins from this page — the company's first admin.
    // The super_admin then creates HR/Accounting/etc users with permissions via
    // the in-company User Management page.
    const res = await callCreateUser({
      email: inviteEmail.trim(),
      password: invitePassword,
      role: "super_admin",
      title: inviteTitle.trim() || null,
      company_id: id,
      full_name: inviteName.trim() || null,
    });
    setSubmitting(false);
    if ("error" in res) {
      setError(res.error ?? "Failed to create user");
      return;
    }
    setInviteEmail("");
    setInvitePassword("");
    setInviteName("");
    setInviteTitle("");
    setInviteOpen(false);
    await loadAll();
  };

  if (!id) return null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 md:p-8 max-w-6xl mx-auto">
        <Link to="/super-super-admin" className="inline-flex items-center text-sm text-slate-500 hover:text-slate-900 mb-4">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to companies
        </Link>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : !company ? (
          <p className="text-slate-500">Company not found.</p>
        ) : (
          <>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-8">
              <div>
                <h1 className="text-2xl text-slate-900">{company.name}</h1>
                <p className="text-sm text-slate-500 mt-1 font-mono">{company.id}</p>
              </div>
              <Button variant="primary" onClick={() => setInviteOpen((v) => !v)} className="self-stretch md:self-auto">
                <UserPlus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Add Super Admin
              </Button>
            </div>

            {inviteOpen && (
              <form onSubmit={handleInvite} className="bg-white border border-slate-200 rounded-lg p-4 md:p-6 mb-6 space-y-4">
                <div>
                  <h3 className="text-base text-slate-900">Add Super Admin for {company.name}</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Creates a Super Admin (full company access). For HR / Accounting / custom-title users,
                    sign in as this admin and use the in-app User Management page.
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-slate-700 mb-1">Email *</label>
                    <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-700 mb-1">Full Name</label>
                    <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-700 mb-1">Title</label>
                    <input
                      value={inviteTitle}
                      onChange={(e) => setInviteTitle(e.target.value)}
                      placeholder="e.g. CEO, Founder, Director"
                      className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                    />
                    <p className="text-xs text-slate-500 mt-1">Free-form display label.</p>
                  </div>
                  <div>
                    <label className="block text-sm text-slate-700 mb-1">Temporary Password *</label>
                    <input type="text" value={invitePassword} onChange={(e) => setInvitePassword(e.target.value)} required minLength={8} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm font-mono" />
                    <p className="text-xs text-slate-500 mt-1">At least 8 characters. Share securely.</p>
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button type="submit" variant="primary" disabled={submitting}>
                    {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Create Super Admin
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setInviteOpen(false)}>Cancel</Button>
                </div>
              </form>
            )}

            {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-2 rounded mb-4">{error}</div>}

            <h2 className="text-lg text-slate-900 mb-4">Users</h2>
            {users.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-lg p-8 text-center">
                <Plus className="w-8 h-8 text-slate-300 mx-auto mb-2" strokeWidth={1.5} />
                <p className="text-slate-500 text-sm">No users yet. Add the first Super Admin so they can manage this company.</p>
              </div>
            ) : (
              <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Name</th>
                      <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Email</th>
                      <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Title</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td className="px-6 py-4 text-sm text-slate-900">{u.full_name ?? "—"}</td>
                        <td className="px-6 py-4 text-sm text-slate-600">{u.email ?? "—"}</td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {displayLabel(u)}
                          {(u.role === "super_admin" || u.role === "super_super_admin") && (
                            <span className="ml-2 text-xs text-blue-600">(admin)</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
