import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Building2, Plus, Loader2, ArrowRight, Eye, Power } from "lucide-react";
import Button from "../../components/Button";
import { supabase, type Company } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type CompanyRow = Company & { employee_count?: number; user_count?: number };

export default function Companies() {
  const { setViewAsCompany } = useAuth();
  const navigate = useNavigate();

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const { data: cs, error: cErr } = await supabase
      .from("companies")
      .select("*")
      .order("created_at", { ascending: false });
    if (cErr) {
      setError(cErr.message);
      setLoading(false);
      return;
    }
    const ids = (cs ?? []).map((c) => c.id);
    const placeholderIds = ids.length ? ids : ["00000000-0000-0000-0000-000000000000"];
    const [{ data: employees }, { data: profiles }] = await Promise.all([
      supabase.from("employees").select("company_id").in("company_id", placeholderIds),
      supabase.from("profiles").select("company_id").in("company_id", placeholderIds),
    ]);
    const empCount = new Map<string, number>();
    for (const e of employees ?? []) empCount.set(e.company_id, (empCount.get(e.company_id) ?? 0) + 1);
    const userCount = new Map<string, number>();
    for (const p of profiles ?? []) if (p.company_id) userCount.set(p.company_id, (userCount.get(p.company_id) ?? 0) + 1);
    setCompanies(
      (cs ?? []).map((c) => ({
        ...c,
        employee_count: empCount.get(c.id) ?? 0,
        user_count: userCount.get(c.id) ?? 0,
      }))
    );
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    const { error: insErr } = await supabase.from("companies").insert({
      name: name.trim(),
      contact_email: contactEmail.trim() || null,
      contact_phone: contactPhone.trim() || null,
    });
    setSubmitting(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setName("");
    setContactEmail("");
    setContactPhone("");
    setAddOpen(false);
    await loadAll();
  };

  const toggleActive = async (c: CompanyRow) => {
    const next = !c.active;
    if (!next && !window.confirm(`Deactivate "${c.name}"? Its users will be blocked from signing in.`)) {
      return;
    }
    setBusyId(c.id);
    const { error: err } = await supabase
      .from("companies")
      .update({ active: next })
      .eq("id", c.id);
    setBusyId(null);
    if (err) {
      setError(err.message);
      return;
    }
    await loadAll();
  };

  const viewAs = async (c: CompanyRow) => {
    setBusyId(c.id);
    const { error: err } = await setViewAsCompany(c.id);
    setBusyId(null);
    if (err) {
      setError(err);
      return;
    }
    navigate("/super-admin", { replace: true });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-8 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl text-slate-900">Companies</h1>
            <p className="text-sm text-slate-500 mt-1">Manage all tenant companies, their admins, and access.</p>
          </div>
          <Button variant="primary" onClick={() => setAddOpen((v) => !v)}>
            <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
            New Company
          </Button>
        </div>

        {addOpen && (
          <form onSubmit={handleAdd} className="bg-white border border-slate-200 rounded-lg p-6 mb-6 space-y-4">
            <h3 className="text-base text-slate-900">Add Company</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Name *</label>
                <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Contact Email</label>
                <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Contact Phone</label>
                <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button type="submit" variant="primary" disabled={submitting}>
                {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Create
              </Button>
              <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
            </div>
          </form>
        )}

        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-2 rounded mb-4">{error}</div>}

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : companies.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-lg p-12 text-center">
            <Building2 className="w-10 h-10 text-slate-300 mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-slate-500">No companies yet. Create your first tenant above.</p>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Company</th>
                  <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Contact</th>
                  <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Users</th>
                  <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Employees</th>
                  <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Status</th>
                  <th className="px-6 py-3 text-right text-xs uppercase tracking-wider text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {companies.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-6 py-4">
                      <div className="text-sm text-slate-900">{c.name}</div>
                      <div className="text-xs text-slate-500 font-mono">{c.id.slice(0, 8)}</div>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">
                      {c.contact_email ?? "—"}
                      {c.contact_phone && <div className="text-xs text-slate-500">{c.contact_phone}</div>}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">{c.user_count}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{c.employee_count}</td>
                    <td className="px-6 py-4">
                      <span className={`text-xs px-2 py-1 rounded ${c.active ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                        {c.active ? "Active" : "Suspended"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => viewAs(c)}
                          disabled={busyId === c.id || !c.active}
                          title={c.active ? "View this company's data" : "Activate the company first to view"}
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Eye className="w-3 h-3" /> View
                        </button>
                        <button
                          onClick={() => toggleActive(c)}
                          disabled={busyId === c.id}
                          className={`flex items-center gap-1 text-xs px-2 py-1 rounded border ${
                            c.active
                              ? "border-red-200 text-red-700 hover:bg-red-50"
                              : "border-green-200 text-green-700 hover:bg-green-50"
                          } disabled:opacity-50`}
                        >
                          <Power className="w-3 h-3" /> {c.active ? "Deactivate" : "Activate"}
                        </button>
                        <Link
                          to={`/super-super-admin/companies/${c.id}`}
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-200 text-blue-700 hover:bg-blue-50"
                        >
                          Users <ArrowRight className="w-3 h-3" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
