import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Building2, Plus, Loader2, ArrowRight, Eye, Power, CreditCard, X } from "lucide-react";
import Button from "../../components/Button";
import { supabase, type Company, type SubscriptionPayment } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

const todayStr = () => new Date().toISOString().slice(0, 10);

const daysBetween = (a: string, b: string) => {
  const ad = new Date(a + "T00:00:00").getTime();
  const bd = new Date(b + "T00:00:00").getTime();
  return Math.round((bd - ad) / (1000 * 60 * 60 * 24));
};

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

  // Subscription modal
  const [subCompany, setSubCompany] = useState<CompanyRow | null>(null);
  const [subPayments, setSubPayments] = useState<SubscriptionPayment[]>([]);
  const [subLoading, setSubLoading] = useState(false);
  const [subAmount, setSubAmount] = useState("");
  const [subDays, setSubDays] = useState("");
  const [subDate, setSubDate] = useState(todayStr());
  const [subNotes, setSubNotes] = useState("");
  const [subSubmitting, setSubSubmitting] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

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
    const msg = next
      ? `Activate "${c.name}"? Its users will be able to sign in again.`
      : `Deactivate "${c.name}"? Its users will be blocked from signing in. Data is preserved and restored on reactivation.`;
    if (!window.confirm(msg)) return;
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

  const openSubscription = async (c: CompanyRow) => {
    setSubCompany(c);
    setSubAmount("");
    setSubDays("");
    setSubDate(todayStr());
    setSubNotes("");
    setSubError(null);
    setSubLoading(true);
    const { data, error: err } = await supabase
      .from("subscription_payments")
      .select("*")
      .eq("company_id", c.id)
      .order("created_at", { ascending: false });
    if (err) setSubError(err.message);
    setSubPayments((data as SubscriptionPayment[]) ?? []);
    setSubLoading(false);
  };

  const handleAddPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subCompany) return;
    const amt = Number(subAmount);
    const days = Number(subDays);
    if (!Number.isFinite(amt) || amt < 0) {
      setSubError("Amount must be a non-negative number.");
      return;
    }
    if (!Number.isInteger(days) || days <= 0) {
      setSubError("Days must be a positive integer.");
      return;
    }
    setSubSubmitting(true);
    setSubError(null);
    const { error: err } = await supabase.rpc("add_subscription_payment", {
      p_company_id: subCompany.id,
      p_amount: amt,
      p_days: days,
      p_payment_date: subDate,
      p_notes: subNotes.trim() || null,
    });
    setSubSubmitting(false);
    if (err) {
      setSubError(err.message);
      return;
    }
    // Refresh both the modal contents and the underlying list
    await Promise.all([openSubscription(subCompany), loadAll()]);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 md:p-8 max-w-6xl mx-auto">
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

        {error && <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-4 py-2 rounded mb-4">{error}</div>}

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Loadingâ€¦</div>
        ) : companies.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-lg p-12 text-center">
            <Building2 className="w-10 h-10 text-slate-300 mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-slate-500">No companies yet. Create your first tenant above.</p>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Company</th>
                  <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Contact</th>
                  <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Users</th>
                  <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Employees</th>
                  <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-500">Subscription</th>
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
                      {c.contact_email ?? "â€”"}
                      {c.contact_phone && <div className="text-xs text-slate-500">{c.contact_phone}</div>}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">{c.user_count}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{c.employee_count}</td>
                    <td className="px-6 py-4 text-sm">
                      {c.subscription_expires_at == null ? (
                        <span className="text-xs text-slate-500">Not set</span>
                      ) : (() => {
                        const remaining = daysBetween(todayStr(), c.subscription_expires_at);
                        const tone =
                          remaining < 0 ? "bg-danger-50 text-danger-700"
                          : remaining <= 7 ? "bg-warning-50 text-warning-700"
                          : "bg-success-50 text-success-700";
                        return (
                          <span className={`text-xs px-2 py-1 rounded ${tone}`}>
                            {remaining < 0 ? `Expired ${-remaining}d ago` : `${remaining} day${remaining === 1 ? "" : "s"} left`}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-xs px-2 py-1 rounded ${c.active ? "bg-success-50 text-success-700" : "bg-danger-50 text-danger-700"}`}>
                        {c.active ? "Active" : "Suspended"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => openSubscription(c)}
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50"
                          title="Manage subscription"
                        >
                          <CreditCard className="w-3 h-3" /> Subscription
                        </button>
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
                              ? "border-danger-200 text-danger-700 hover:bg-danger-50"
                              : "border-success-200 text-success-700 hover:bg-success-50"
                          } disabled:opacity-50`}
                        >
                          <Power className="w-3 h-3" /> {c.active ? "Deactivate" : "Activate"}
                        </button>
                        <Link
                          to={`/super-super-admin/companies/${c.id}`}
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-200 text-brand-700 hover:bg-brand-50"
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

      {subCompany && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h2 className="text-lg text-slate-900">{subCompany.name} â€” Subscription</h2>
                <p className="text-xs text-slate-500 mt-1">
                  {subCompany.subscription_expires_at == null
                    ? "No subscription set yet."
                    : (() => {
                        const r = daysBetween(todayStr(), subCompany.subscription_expires_at);
                        return r < 0
                          ? `Expired ${-r} day${r === -1 ? "" : "s"} ago (${subCompany.subscription_expires_at})`
                          : `${r} day${r === 1 ? "" : "s"} remaining Â· expires ${subCompany.subscription_expires_at}`;
                      })()}
                </p>
              </div>
              <button
                onClick={() => setSubCompany(null)}
                className="text-slate-400 hover:text-slate-700"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              <form onSubmit={handleAddPayment} className="bg-slate-50 border border-slate-200 rounded p-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
                <div>
                  <label className="block text-xs text-slate-700 mb-1">Amount (PKR) *</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={subAmount}
                    onChange={(e) => setSubAmount(e.target.value)}
                    required
                    className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-700 mb-1">Days *</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={subDays}
                    onChange={(e) => setSubDays(e.target.value)}
                    required
                    className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-700 mb-1">Payment Date</label>
                  <input
                    type="date"
                    value={subDate}
                    onChange={(e) => setSubDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
                  />
                </div>
                <div className="md:col-span-2 flex gap-2">
                  <div className="flex-1">
                    <label className="block text-xs text-slate-700 mb-1">Notes</label>
                    <input
                      type="text"
                      value={subNotes}
                      onChange={(e) => setSubNotes(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
                      placeholder="Optional"
                    />
                  </div>
                  <Button type="submit" variant="primary" size="sm" disabled={subSubmitting} className="self-end">
                    {subSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
                    Add
                  </Button>
                </div>
                {subError && (
                  <div className="md:col-span-5 text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded">{subError}</div>
                )}
              </form>

              <div>
                <h3 className="text-sm text-slate-900 mb-3">Payment History</h3>
                {subLoading ? (
                  <div className="text-sm text-slate-500 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loadingâ€¦
                  </div>
                ) : subPayments.length === 0 ? (
                  <p className="text-sm text-slate-500">No payments yet.</p>
                ) : (
                  <div className="border border-slate-200 rounded overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs uppercase text-slate-500">Date</th>
                          <th className="px-3 py-2 text-right text-xs uppercase text-slate-500">Amount</th>
                          <th className="px-3 py-2 text-right text-xs uppercase text-slate-500">Days</th>
                          <th className="px-3 py-2 text-left text-xs uppercase text-slate-500">Notes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 text-sm">
                        {subPayments.map((p) => (
                          <tr key={p.id}>
                            <td className="px-3 py-2 text-slate-700">{p.payment_date}</td>
                            <td className="px-3 py-2 text-right text-slate-900">
                              PKR {Number(p.amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-700">{p.days_added}</td>
                            <td className="px-3 py-2 text-slate-600">{p.notes ?? "â€”"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
