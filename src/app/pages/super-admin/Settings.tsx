import { useEffect, useState } from "react";
import { Plus, Loader2, AlertCircle, X, Trash2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { supabase, type ClientType } from "../../lib/supabase";

type LocationRow = { id: string; name: string; employees: number };
type ClientRow = {
  id: string;
  client_code: string;
  name: string;
  email: string | null;
  phone: string | null;
  allowed_leaves_per_month: number;
  client_type: ClientType;
  employees: number;
};

const clientTypeLabel = (t: ClientType) =>
  t === "security_services" ? "Security Services" : "Guard Deployment";

const previousMonthKey = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const formatMonthLabel = (firstOfMonthIso: string) => {
  const [y, m] = firstOfMonthIso.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
};

export default function Settings() {
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [locAddOpen, setLocAddOpen] = useState(false);
  const [newLocName, setNewLocName] = useState("");
  const [locEditingId, setLocEditingId] = useState<string | null>(null);
  const [locEditingName, setLocEditingName] = useState("");

  const [clientAddOpen, setClientAddOpen] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientAllowedLeaves, setNewClientAllowedLeaves] = useState<number>(0);
  const [newClientType, setNewClientType] = useState<ClientType>("security_services");

  const [clientEditingId, setClientEditingId] = useState<string | null>(null);
  const [editClientName, setEditClientName] = useState("");
  const [editClientEmail, setEditClientEmail] = useState("");
  const [editClientPhone, setEditClientPhone] = useState("");
  const [editClientAllowedLeaves, setEditClientAllowedLeaves] = useState<number>(0);
  const [editClientType, setEditClientType] = useState<ClientType>("security_services");
  const [carryForwardMonth, setCarryForwardMonth] = useState<string>(previousMonthKey());
  const [carryForwardSubmitting, setCarryForwardSubmitting] = useState(false);
  const [carryForwardMessage, setCarryForwardMessage] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [empRes, locRes, cliRes] = await Promise.all([
      supabase.from("employees").select("location_id, client_id"),
      supabase.from("locations").select("id, name").order("name"),
      supabase
        .from("clients")
        .select("id, client_code, name, email, phone, allowed_leaves_per_month, client_type")
        .order("client_code"),
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
        allowed_leaves_per_month: Number(r.allowed_leaves_per_month ?? 0),
        client_type: (r.client_type ?? "security_services") as ClientType,
        employees: cliCounts[r.id] ?? 0,
      }))
    );

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
      allowed_leaves_per_month: Math.max(0, Math.floor(Number(newClientAllowedLeaves) || 0)),
      client_type: newClientType,
    });
    setSubmitting(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setNewClientName("");
    setNewClientEmail("");
    setNewClientPhone("");
    setNewClientAllowedLeaves(0);
    setNewClientType("security_services");
    setClientAddOpen(false);
    await loadAll();
  };

  const openClientEdit = (row: ClientRow) => {
    setClientEditingId(row.id);
    setEditClientName(row.name);
    setEditClientEmail(row.email ?? "");
    setEditClientPhone(row.phone ?? "");
    setEditClientAllowedLeaves(row.allowed_leaves_per_month ?? 0);
    setEditClientType(row.client_type ?? "security_services");
    setCarryForwardMessage(null);
    setCarryForwardMonth(previousMonthKey());
  };

  const handleSaveClientEdit = async (id: string) => {
    if (!editClientName.trim()) return;
    const { error: upErr } = await supabase
      .from("clients")
      .update({
        name: editClientName.trim(),
        email: editClientEmail.trim() || null,
        phone: editClientPhone.trim() || null,
        allowed_leaves_per_month: Math.max(0, Math.floor(Number(editClientAllowedLeaves) || 0)),
        client_type: editClientType,
      })
      .eq("id", id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setClientEditingId(null);
    await loadAll();
  };

  const handleCarryForward = async (clientId: string, baseAllowed: number) => {
    setCarryForwardSubmitting(true);
    setCarryForwardMessage(null);
    setError(null);
    try {
      const [yStr, mStr] = carryForwardMonth.split("-");
      const sy = Number(yStr);
      const sm = Number(mStr);
      if (!sy || !sm) {
        setError("Pick a valid source month.");
        return;
      }
      const sourceFirst = `${yStr}-${mStr}-01`;
      const sourceLastDay = new Date(sy, sm, 0).getDate();
      const sourceLast = `${yStr}-${mStr}-${String(sourceLastDay).padStart(2, "0")}`;
      const nextDate = new Date(sy, sm, 1);
      const ny = nextDate.getFullYear();
      const nm = nextDate.getMonth() + 1;
      const nextFirst = `${ny}-${String(nm).padStart(2, "0")}-01`;

      const { data: emps, error: empErr } = await supabase
        .from("employees")
        .select("id")
        .eq("client_id", clientId);
      if (empErr) throw empErr;
      const empIds = (emps ?? []).map((e: any) => e.id as string);
      if (empIds.length === 0) {
        setCarryForwardMessage("No employees linked to this client.");
        return;
      }

      const { data: overrides, error: oErr } = await supabase
        .from("monthly_leave_allowances")
        .select("employee_id, allowed_leaves")
        .eq("period_month", sourceFirst)
        .in("employee_id", empIds);
      if (oErr) throw oErr;
      const overrideMap = new Map<string, number>();
      (overrides ?? []).forEach((o: any) =>
        overrideMap.set(o.employee_id, Number(o.allowed_leaves))
      );

      const { data: leaves, error: lErr } = await supabase
        .from("attendance_records")
        .select("employee_id")
        .eq("status", "Leave")
        .gte("attendance_date", sourceFirst)
        .lte("attendance_date", sourceLast)
        .in("employee_id", empIds);
      if (lErr) throw lErr;
      const leaveCount = new Map<string, number>();
      (leaves ?? []).forEach((l: any) => {
        leaveCount.set(l.employee_id, (leaveCount.get(l.employee_id) ?? 0) + 1);
      });

      const upserts = empIds.map((eid) => {
        const sourceAllowed = overrideMap.get(eid) ?? baseAllowed;
        const used = leaveCount.get(eid) ?? 0;
        const unused = Math.max(0, sourceAllowed - used);
        const nextAllowed = baseAllowed + unused;
        return {
          employee_id: eid,
          period_month: nextFirst,
          allowed_leaves: nextAllowed,
          updated_at: new Date().toISOString(),
        };
      });

      const { error: upErr } = await supabase
        .from("monthly_leave_allowances")
        .upsert(upserts, { onConflict: "employee_id,period_month" });
      if (upErr) throw upErr;

      setCarryForwardMessage(
        `Forwarded unused leaves for ${empIds.length} employee${
          empIds.length === 1 ? "" : "s"
        } from ${formatMonthLabel(sourceFirst)} → ${formatMonthLabel(nextFirst)}.`
      );
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setCarryForwardSubmitting(false);
    }
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
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">Allowed Leaves / Month</label>
                      <input
                        type="number"
                        min={0}
                        max={31}
                        value={editClientAllowedLeaves}
                        onChange={(e) => setEditClientAllowedLeaves(Number(e.target.value))}
                        className="w-full px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">Client Type</label>
                      <select
                        value={editClientType}
                        onChange={(e) => setEditClientType(e.target.value as ClientType)}
                        className="w-full px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                      >
                        <option value="security_services">Security Services</option>
                        <option value="guard_deployment">Guard Deployment</option>
                      </select>
                    </div>
                  </div>
                  <div className="border-t border-slate-200 pt-3 space-y-2">
                    <label className="block text-xs text-slate-600">Leave Carry-Forward</label>
                    <div className="flex items-end gap-2 flex-wrap">
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Source Month</label>
                        <input
                          type="month"
                          value={carryForwardMonth}
                          onChange={(e) => setCarryForwardMonth(e.target.value)}
                          className="px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                        />
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={carryForwardSubmitting || !carryForwardMonth}
                        onClick={() =>
                          handleCarryForward(row.id, row.allowed_leaves_per_month)
                        }
                      >
                        {carryForwardSubmitting
                          ? "Forwarding…"
                          : "Forward Unused Leaves"}
                      </Button>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Carries each employee's unused leaves from the source month into the next
                      month's allowance. Idempotent — re-running re-computes from current data.
                    </p>
                    {carryForwardMessage && (
                      <p className="text-xs text-green-700">{carryForwardMessage}</p>
                    )}
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
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 mr-2">
                        {clientTypeLabel(row.client_type)}
                      </span>
                      {row.employees} employees · {row.allowed_leaves_per_month} leaves/mo
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
          <div>
            <label className="block text-sm text-slate-700 mb-1">Client Type</label>
            <select
              value={newClientType}
              onChange={(e) => setNewClientType(e.target.value as ClientType)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            >
              <option value="security_services">Security Services</option>
              <option value="guard_deployment">Guard Deployment</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Allowed Leaves / Month</label>
            <input
              type="number"
              min={0}
              max={31}
              value={newClientAllowedLeaves}
              onChange={(e) => setNewClientAllowedLeaves(Number(e.target.value))}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="0"
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
                setNewClientAllowedLeaves(0);
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
