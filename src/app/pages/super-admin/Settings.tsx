import { useEffect, useState } from "react";
import { Plus, Loader2, AlertCircle, X, Trash2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { supabase } from "../../lib/supabase";

type Row = { id: string; name: string; employees: number };

type Entity = {
  key: "location" | "client";
  label: string;
  table: "locations" | "clients";
  fk: "location_id" | "client_id";
  placeholder: string;
};

const ENTITIES: Entity[] = [
  { key: "location", label: "Location", table: "locations", fk: "location_id", placeholder: "e.g., F-10 Islamabad" },
  { key: "client", label: "Client", table: "clients", fk: "client_id", placeholder: "e.g., Acme Corp" },
];

export default function Settings() {
  const [data, setData] = useState<Record<Entity["key"], Row[]>>({ location: [], client: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addModal, setAddModal] = useState<Entity | null>(null);
  const [newName, setNewName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const loadAll = async () => {
    setLoading(true);
    const { data: empRows } = await supabase.from("employees").select("location_id, client_id");
    const counts: Record<string, Record<string, number>> = { location_id: {}, client_id: {} };
    (empRows ?? []).forEach((e: any) => {
      if (e.location_id) counts.location_id[e.location_id] = (counts.location_id[e.location_id] ?? 0) + 1;
      if (e.client_id) counts.client_id[e.client_id] = (counts.client_id[e.client_id] ?? 0) + 1;
    });

    const next: Record<Entity["key"], Row[]> = { location: [], client: [] };
    for (const ent of ENTITIES) {
      const { data: rows, error: err } = await supabase.from(ent.table).select("id, name").order("name");
      if (err) {
        setError(err.message);
        continue;
      }
      next[ent.key] = (rows ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        employees: counts[ent.fk][r.id] ?? 0,
      }));
    }
    setData(next);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addModal || !newName.trim()) return;
    setSubmitting(true);
    setError(null);
    const { error: insErr } = await supabase.from(addModal.table).insert({ name: newName.trim() });
    setSubmitting(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setNewName("");
    setAddModal(null);
    await loadAll();
  };

  const rowKey = (entKey: Entity["key"], id: string) => `${entKey}:${id}`;

  const handleSaveEdit = async (ent: Entity, id: string) => {
    if (!editingName.trim()) return;
    const { error: upErr } = await supabase
      .from(ent.table)
      .update({ name: editingName.trim() })
      .eq("id", id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setEditingKey(null);
    setEditingName("");
    await loadAll();
  };

  const handleDelete = async (ent: Entity, row: Row) => {
    const msg =
      row.employees > 0
        ? `Delete "${row.name}"? ${row.employees} employee${row.employees === 1 ? "" : "s"} assigned to this ${ent.label.toLowerCase()} will have their ${ent.label.toLowerCase()} cleared.`
        : `Delete "${row.name}"?`;
    if (!window.confirm(msg)) return;
    const { error: delErr } = await supabase.from(ent.table).delete().eq("id", row.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const renderSection = (ent: Entity) => {
    const rows = data[ent.key];
    return (
      <div key={ent.key} className="bg-white rounded-lg border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-base text-slate-900">{ent.label} Management</h3>
          <Button variant="primary" size="sm" onClick={() => setAddModal(ent)}>
            <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
            Add {ent.label}
          </Button>
        </div>
        <div className="space-y-3">
          {loading && (
            <div className="text-sm text-slate-500 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {!loading && rows.length === 0 && (
            <p className="text-sm text-slate-500">
              No {ent.label.toLowerCase()}s yet. Add one to get started.
            </p>
          )}
          {!loading &&
            rows.map((row) => {
              const k = rowKey(ent.key, row.id);
              return (
                <div
                  key={row.id}
                  className="p-4 border border-slate-200 rounded-lg flex items-center justify-between"
                >
                  {editingKey === k ? (
                    <>
                      <input
                        autoFocus
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="flex-1 mr-3 px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                      />
                      <div className="flex gap-2">
                        <Button variant="primary" size="sm" onClick={() => handleSaveEdit(ent, row.id)}>
                          Save
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingKey(null);
                            setEditingName("");
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
                            setEditingKey(k);
                            setEditingName(row.name);
                          }}
                        >
                          Edit
                        </Button>
                        <button
                          type="button"
                          onClick={() => handleDelete(ent, row)}
                          className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-red-700 hover:bg-red-50"
                          title={`Delete ${ent.label.toLowerCase()}`}
                        >
                          <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    );
  };

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
          {ENTITIES.map(renderSection)}
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6">
          <h3 className="text-base mb-6 text-slate-900">Salary Rules</h3>
          <div className="space-y-4 max-w-lg">
            <div>
              <label className="block text-sm text-slate-700 mb-2">Working Days per Month</label>
              <input
                type="number"
                defaultValue={22}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
            <div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" defaultChecked className="rounded border-slate-300" />
                <span>Deduct salary for absent days</span>
              </label>
            </div>
            <div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" defaultChecked className="rounded border-slate-300" />
                <span>Count leave as paid</span>
              </label>
            </div>
            <Button variant="primary" size="md" className="mt-4">
              Save Rules
            </Button>
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
        isOpen={addModal !== null}
        onClose={() => {
          setAddModal(null);
          setNewName("");
        }}
        title={addModal ? `Add ${addModal.label}` : ""}
        size="sm"
      >
        {addModal && (
          <form className="space-y-4" onSubmit={handleAdd}>
            <div>
              <label className="block text-sm text-slate-700 mb-1">{addModal.label} Name</label>
              <input
                required
                autoFocus
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                placeholder={addModal.placeholder}
              />
            </div>
            <div className="flex items-center gap-3 pt-4">
              <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
                {submitting ? "Saving…" : `Add ${addModal.label}`}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setAddModal(null);
                  setNewName("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
