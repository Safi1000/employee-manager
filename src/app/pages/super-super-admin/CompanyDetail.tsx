import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Plus, Loader2, UserPlus, KeyRound } from "lucide-react";
import Button from "../../components/Button";
import Header from "../../components/Header";
import Modal from "../../components/Modal";
import { supabase, type Company, type Profile, type UserRole } from "../../lib/supabase";
import { callCreateUser, callChangePassword } from "../../lib/auth";

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

  // Reset password
  const [resetPwUserId, setResetPwUserId] = useState<string | null>(null);
  const [resetPwValue, setResetPwValue] = useState("");
  const [resetPwSubmitting, setResetPwSubmitting] = useState(false);
  const [resetPwSuccess, setResetPwSuccess] = useState(false);

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
      setError(res.error);
      return;
    }
    setResetPwSuccess(true);
    setTimeout(() => {
      setResetPwUserId(null);
      setResetPwValue("");
      setResetPwSuccess(false);
    }, 2000);
  };

  return (
    <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
      <Header
        title={company?.name ?? "Company"}
        subtitle={company ? `Tenant ${company.id}` : loading ? "Loading…" : "Company not found"}
        actions={
          <div className="flex items-center gap-2">
            <Link to="/super-super-admin" className="inline-flex items-center gap-1 rounded-xl border border-border px-3 min-h-10 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" /> All companies
            </Link>
            {company && (
              <Button variant="primary" onClick={() => setInviteOpen((v) => !v)}>
                <UserPlus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Add Super Admin
              </Button>
            )}
          </div>
        }
      >
        {company && (() => {
          const byRole = new Map<string, number>();
          for (const u of users) byRole.set(u.role, (byRole.get(u.role) ?? 0) + 1);
          const exp = (company as { subscription_expires_at?: string | null }).subscription_expires_at ?? null;
          const left = exp ? Math.round((new Date(exp + "T00:00:00").getTime() - new Date(new Date().toDateString()).getTime()) / 86400000) : null;
          return (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
                <span className="lbl">Status</span>
                <span className={`font-display text-2xl font-bold leading-none ${company.active ? "text-up" : "text-down"}`}>{company.active ? "Active" : "Switched off"}</span>
                <span className="text-xs text-muted-foreground">{company.active ? "its users can sign in" : "its users are blocked; data kept"}</span>
              </div>
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
                <span className="lbl">Users</span>
                <span className="font-ledger text-2xl font-semibold leading-none">{users.length}</span>
                <span className="text-xs text-muted-foreground truncate">{[...byRole].map(([r, n]) => `${n} ${r.replace(/_/g, " ")}`).join(" · ") || "no users yet"}</span>
              </div>
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
                <span className="lbl">Super admins</span>
                <span className={`font-ledger text-2xl font-semibold leading-none ${(byRole.get("super_admin") ?? 0) === 0 ? "text-heed" : ""}`}>{byRole.get("super_admin") ?? 0}</span>
                <span className="text-xs text-muted-foreground">{(byRole.get("super_admin") ?? 0) === 0 ? "add one so the company can be run" : "can manage the company"}</span>
              </div>
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
                <span className="lbl">Subscription</span>
                <span className={`font-ledger text-2xl font-semibold leading-none ${left == null ? "" : left < 0 ? "text-down" : left <= 14 ? "text-heed" : "text-up"}`}>{left == null ? "—" : left < 0 ? `${-left}d over` : `${left}d left`}</span>
                <span className="text-xs text-muted-foreground">{exp ? `paid until ${exp}` : "no subscription recorded"}</span>
              </div>
            </div>
          );
        })()}
      </Header>
      <div className="max-w-6xl">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : !company ? (
          <p className="text-muted-foreground">Company not found.</p>
        ) : (
          <>
            {inviteOpen && (
              <form onSubmit={handleInvite} className="bg-card border border-border rounded-2xl p-4 md:p-6 mb-6 space-y-4">
                <div>
                  <h3 className="font-display text-lg font-bold tracking-tight text-foreground">Add Super Admin for {company.name}</h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Creates a Super Admin (full company access). For HR / Accounting / custom-title users,
                    sign in as this admin and use the in-app User Management page.
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-foreground mb-1">Email *</label>
                    <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required className="w-full px-3 py-2 border border-border rounded-xl bg-card text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm text-foreground mb-1">Full Name</label>
                    <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} className="w-full px-3 py-2 border border-border rounded-xl bg-card text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm text-foreground mb-1">Title</label>
                    <input
                      value={inviteTitle}
                      onChange={(e) => setInviteTitle(e.target.value)}
                      placeholder="e.g. CEO, Founder, Director"
                      className="w-full px-3 py-2 border border-border rounded-xl bg-card text-sm"
                    />
                    <p className="text-xs text-muted-foreground mt-1">Free-form display label.</p>
                  </div>
                  <div>
                    <label className="block text-sm text-foreground mb-1">Temporary Password *</label>
                    <input type="text" value={invitePassword} onChange={(e) => setInvitePassword(e.target.value)} required minLength={8} className="w-full px-3 py-2 border border-border rounded-xl bg-card text-sm font-mono" />
                    <p className="text-xs text-muted-foreground mt-1">At least 8 characters. Share securely.</p>
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

            {error && <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-4 py-2 rounded mb-4">{error}</div>}

            <h2 className="font-display text-lg font-bold tracking-tight text-foreground mb-4">Users</h2>
            {users.length === 0 ? (
              <div className="bg-card border border-border rounded-2xl p-8 text-center">
                <Plus className="w-8 h-8 text-muted-foreground/50 mx-auto mb-2" strokeWidth={1.5} />
                <p className="text-muted-foreground text-sm">No users yet. Add the first Super Admin so they can manage this company.</p>
              </div>
            ) : (
              <div className="bg-card border border-border rounded-2xl overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead className="bg-muted/50 border-b border-border">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-muted-foreground">Name</th>
                      <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-muted-foreground">Email</th>
                      <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-muted-foreground">Title</th>
                      <th className="px-6 py-3 text-right text-xs uppercase tracking-wider text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td className="px-6 py-4 text-sm text-foreground">{u.full_name ?? "—"}</td>
                        <td className="px-6 py-4 text-sm text-muted-foreground">{u.email ?? "—"}</td>
                        <td className="px-6 py-4 text-sm text-muted-foreground">
                          {displayLabel(u)}
                          {(u.role === "super_admin" || u.role === "super_super_admin") && (
                            <span className="ml-2 text-xs text-brand-600">(admin)</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => { setResetPwUserId(u.id); setResetPwValue(""); setResetPwSuccess(false); }}
                            className="p-1.5 rounded text-warning-600 hover:bg-warning-50"
                            title="Reset Password"
                          >
                            <KeyRound className="w-4 h-4" />
                          </button>
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
              Set a new temporary password. The user will be required to change it on their next login.
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
    </div>
  );
}
