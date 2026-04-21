import { useEffect, useState } from "react";
import { Plus, Loader2, AlertCircle, X, Trash2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { supabase } from "../../lib/supabase";

type LocationRow = { id: string; name: string; employees: number };
type ClientRow = {
  id: string;
  client_code: string;
  name: string;
  email: string | null;
  phone: string | null;
  employees: number;
};

export default function Settings() {
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [workingDays, setWorkingDays] = useState<number>(22);
  const [savingWorkingDays, setSavingWorkingDays] = useState(false);
  const [workingDaysSaved, setWorkingDaysSaved] = useState(false);

  const [locAddOpen, setLocAddOpen] = useState(false);
  const [newLocName, setNewLocName] = useState("");
  const [locEditingId, setLocEditingId] = useState<string | null>(null);
  const [locEditingName, setLocEditingName] = useState("");

  const [clientAddOpen, setClientAddOpen] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");

  const [clientEditingId, setClientEditingId] = useState<string | null>(null);
  const [editClientName, setEditClientName] = useState("");
  const [editClientEmail, setEditClientEmail] = useState("");
  const [editClientPhone, setEditClientPhone] = useState("");

  const [submitting, setSubmitting] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [empRes, locRes, cliRes, settingsRes] = await Promise.all([
      supabase.from("employees").select("location_id, client_id"),
      supabase.from("locations").select("id, name").order("name"),
      supabase
        .from("clients")
        .select("id, client_code, name, email, phone")
        .order("client_code"),
      supabase
        .from("app_settings")
        .select("value")
        .eq("key", "working_days_per_month")
        .maybeSingle(),
    ]);

    const locCounts: Record<string, number> = {};
    const cliCounts: Record<string, number> = {};
    (empRes.data ?? []).forEach((e: any) => {
      if (e.location_id) locCounts[e.location_id] = (locCounts[e.location_id] ?? 0) + 1;
      if (e.client_id) cliCounts[e.client_id] = (cliCounts[e.client_id] ?? 0) + 1;
    });

    if (locRes.error) setError(locRes.error.message);
    if (cliRes.error) setError(cliRes.error.message);

    setLocations(
      (locRes.data ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        employees: locCounts[r.id] ?? 0,
      }))
    );
    setClients(
      (cliRes.data ?? []).map((r: any) => ({
        id: r.id,
        client_code: r.client_code,
        name: r.name,
        email: r.email,
        phone: r.phone,
        employees: cliCounts[r.id] ?? 0,
      }))
    );

    const wdRaw = settingsRes.data?.value;
    const wd = typeof wdRaw === "number" ? wdRaw : Number(wdRaw);
    if (!Number.isNaN(wd) && wd > 0) setWorkingDays(wd);

    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleAddLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLocName.trim()) return;
    setSubmitting(true);
    setError(null);
    const { error: insErr } = await supabase.from("locations").insert({ name: newLocName.trim() });
    setSubmitting(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setNewLocName("");
    setLocAddOpen(false);
    await loadAll();
  };

  const handleSaveLocationEdit = async (id: string) => {
    if (!locEditingName.trim()) return;
    const { error: upErr } = await supabase
      .from("locations")
      .update({ name: locEditingName.trim() })
      .eq("id", id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setLocEditingId(null);
    setLocEditingName("");
    await loadAll();
  };

  const handleDeleteLocation = async (row: LocationRow) => {
    const msg =
      row.employees > 0
        ? `Delete "${row.name}"? ${row.employees} employee${row.employees === 1 ? "" : "s"} assigned to this location will have their location cleared.`
        : `Delete "${row.name}"?`;
    if (!window.confirm(msg)) return;
    const { error: delErr } = await supabase.from("locations").delete().eq("id", row.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const handleAddClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newClientName.trim()) return;
    setSubmitting(true);
    setError(null);
    const { error: insErr } = await supabase.from("clients").insert({
      name: newClientName.trim(),
      email: newClientEmail.trim() || null,
      phone: newClientPhone.trim() || null,
    });
    setSubmitting(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setNewClientName("");
    setNewClientEmail("");
    setNewClientPhone("");
    setClientAddOpen(false);
    await loadAll();
  };

  const openClientEdit = (row: ClientRow) => {
    setClientEditingId(row.id);
    setEditClientName(row.name);
    setEditClientEmail(row.email ?? "");
    setEditClientPhone(row.phone ?? "");
  };

  const handleSaveClientEdit = async (id: string) => {
    if (!editClientName.trim()) return;
    const { error: upErr } = await supabase
      .from("clients")
      .update({
        name: editClientName.trim(),
        email: editClientEmail.trim() || null,
        phone: editClientPhone.trim() || null,
      })
      .eq("id", id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setClientEditingId(null);
    await loadAll();
  };

  const handleDeleteClient = async (row: ClientRow) => {
    const msg =
      row.employees > 0
        ? `Delete "${row.name}"? ${row.employees} employee${row.employees === 1 ? "" : "s"} assigned to this client will have their client cleared.`
        : `Delete "${row.name}"?`;
    if (!window.confirm(msg)) return;
    const { error: delErr } = await supabase.from("clients").delete().eq("id", row.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const handleSaveWorkingDays = async () => {
    if (!workingDays || workingDays < 1 || workingDays > 31) {
      setError("Working days must be between 1 and 31");
      return;
    }
    setSavingWorkingDays(true);
    setError(null);
    const { error: upErr } = await supabase
      .from("app_settings")
      .upsert({ key: "working_days_per_month", value: workingDays, updated_at: new Date().toISOString() });
    setSavingWorkingDays(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setWorkingDaysSaved(true);
    setTimeout(() => setWorkingDaysSaved(false), 2000);
  };

  const renderLocations = () => (
    <div className="bg-white rounded-lg border border-slate-200 p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-base text-slate-900">Location Management</h3>
        <Button variant="primary" size="sm" onClick={() => setLocAddOpen(true)}>
          <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
          Add Location
        </Button>
      </div>
      <div className="space-y-3">
        {loading && (
          <div className="text-sm text-slate-500 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {!loading && locations.length === 0 && (
          <p className="text-sm text-slate-500">No locations yet. Add one to get started.</p>
        )}
        {!loading &&
          locations.map((row) => (
            <div
              key={row.id}
              className="p-4 border border-slate-200 rounded-lg flex items-center justify-between"
            >
              {locEditingId === row.id ? (
                <>
                  <input
                    autoFocus
                    value={locEditingName}
                    onChange={(e) => setLocEditingName(e.target.value)}
                    className="flex-1 mr-3 px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                  <div className="flex gap-2">
                    <Button variant="primary" size="sm" onClick={() => handleSaveLocationEdit(row.id)}>
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setLocEditingId(null);
                        setLocEditingName("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <p className="text-sm text-slate-900">{row.name}</p>
                    <p className="text-xs text-slate-500 mt-1">{row.employees} employees</p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setLocEditingId(row.id);
                        setLocEditingName(row.name);
                      }}
                    >
                      Edit
                    </Button>
                    <button
                      type="button"
                      onClick={() => handleDeleteLocation(row)}
                      className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-red-700 hover:bg-red-50"
                      title="Delete location"
                    >
                      <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
      </div>
    </div>
  );

  const renderClients = () => (
    <div className="bg-white rounded-lg border border-slate-200 p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-base text-slate-900">Client Management</h3>
        <Button variant="primary" size="sm" onClick={() => setClientAddOpen(true)}>
          <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
          Add Client
        </Button>
      </div>
      <div className="space-y-3">
        {loading && (
          <div className="text-sm text-slate-500 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {!loading && clients.length === 0 && (
          <p className="text-sm text-slate-500">No clients yet. Add one to get started.</p>
        )}
        {!loading &&
          clients.map((row) => (
            <div
              key={row.id}
              className="p-4 border border-slate-200 rounded-lg"
            >
              {clientEditingId === row.id ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-500">{row.client_code}</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <input
                      placeholder="Client name"
                      value={editClientName}
                      onChange={(e) => setEditClientName(e.target.value)}
                      className="px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                    <input
                      placeholder="Email"
                      type="email"
                      value={editClientEmail}
                      onChange={(e) => setEditClientEmail(e.target.value)}
                      className="px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                    <input
                      placeholder="Phone"
                      value={editClientPhone}
                      onChange={(e) => setEditClientPhone(e.target.value)}
                      className="px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="primary" size="sm" onClick={() => handleSaveClientEdit(row.id)}>
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setClientEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-slate-900 truncate">{row.name}</p>
                      <span className="text-xs font-mono text-slate-500">{row.client_code}</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      {row.employees} employees
                      {row.email ? ` · ${row.email}` : ""}
                      {row.phone ? ` · ${row.phone}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => openClientEdit(row)}>
                      Edit
                    </Button>
                    <button
                      type="button"
                      onClick={() => handleDeleteClient(row)}
                      className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-red-700 hover:bg-red-50"
                      title="Delete client"
                    >
                      <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );

  return (
    <>
      <Header title="Settings" />

      <div className="flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 text-red-700 border border-red-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {renderLocations()}
          {renderClients()}
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6">
          <h3 className="text-base mb-6 text-slate-900">Salary Rules</h3>
          <div className="space-y-4 max-w-lg">
            <div>
              <label className="block text-sm text-slate-700 mb-2">Working Days per Month</label>
              <input
                type="number"
                min={1}
                max={31}
                value={workingDays}
                onChange={(e) => setWorkingDays(Number(e.target.value))}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
              <p className="text-xs text-slate-500 mt-1">
                Used as the default working days when computing payroll for each employee.
              </p>
            </div>
            <div className="flex items-center gap-3 mt-4">
              <Button variant="primary" size="md" onClick={handleSaveWorkingDays} disabled={savingWorkingDays}>
                {savingWorkingDays ? "Saving…" : "Save Rules"}
              </Button>
              {workingDaysSaved && <span className="text-xs text-emerald-700">Saved.</span>}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="text-base mb-6 text-slate-900">Role Permissions Configuration</h3>
          <div className="space-y-6">
            <div>
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-200">
                <h4 className="text-sm text-slate-900">Super Admin</h4>
                <span className="text-xs text-slate-500">Full Access</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  "User Management",
                  "Employee Management",
                  "Attendance",
                  "Payroll",
                  "Expenses",
                  "Cashflow",
                  "Settings",
                  "Reports",
                ].map((perm) => (
                  <label key={perm} className="flex items-center gap-2 text-sm text-slate-600">
                    <input type="checkbox" defaultChecked className="rounded border-slate-300" />
                    <span>{perm}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-200">
                <h4 className="text-sm text-slate-900">HR</h4>
                <span className="text-xs text-slate-500">Employee & Attendance Management</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {["Employee Management", "Attendance", "Documents"].map((perm) => (
                  <label key={perm} className="flex items-center gap-2 text-sm text-slate-600">
                    <input type="checkbox" defaultChecked className="rounded border-slate-300" />
                    <span>{perm}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-200">
                <h4 className="text-sm text-slate-900">Accounts</h4>
                <span className="text-xs text-slate-500">Financial Management</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {["Attendance (Read Only)", "Payroll", "Expenses", "Cashflow", "Reports"].map((perm) => (
                  <label key={perm} className="flex items-center gap-2 text-sm text-slate-600">
                    <input type="checkbox" defaultChecked className="rounded border-slate-300" />
                    <span>{perm}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="pt-4">
              <Button variant="primary" size="md">
                Save Permissions
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Modal
        isOpen={locAddOpen}
        onClose={() => {
          setLocAddOpen(false);
          setNewLocName("");
        }}
        title="Add Location"
        size="sm"
      >
        <form className="space-y-4" onSubmit={handleAddLocation}>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Location Name</label>
            <input
              required
              autoFocus
              type="text"
              value={newLocName}
              onChange={(e) => setNewLocName(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="e.g., F-10 Islamabad"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting ? "Saving…" : "Add Location"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setLocAddOpen(false);
                setNewLocName("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={clientAddOpen}
        onClose={() => {
          setClientAddOpen(false);
          setNewClientName("");
          setNewClientEmail("");
          setNewClientPhone("");
        }}
        title="Add Client"
        size="sm"
      >
        <form className="space-y-4" onSubmit={handleAddClient}>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Client Name</label>
            <input
              required
              autoFocus
              type="text"
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="e.g., Acme Corp"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Email</label>
            <input
              type="email"
              value={newClientEmail}
              onChange={(e) => setNewClientEmail(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="contact@acme.com"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Phone</label>
            <input
              type="tel"
              value={newClientPhone}
              onChange={(e) => setNewClientPhone(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="+92 300 1234567"
            />
          </div>
          <p className="text-xs text-slate-500">A unique Client ID (CLI-…) is generated automatically.</p>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting ? "Saving…" : "Add Client"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setClientAddOpen(false);
                setNewClientName("");
                setNewClientEmail("");
                setNewClientPhone("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
