import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useMemo, useState } from "react";
import { Search, FileText, Download, AlertCircle, Loader2, X, Upload } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import {
  supabase,
  EMPLOYEE_DOCS_BUCKET,
  type Client,
  type Employee,
  type EmployeeDocument,
  type Location,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type EmployeeRow = Employee & {
  location_name: string | null;
  client_name: string | null;
  doc_count: number;
  last_updated: string | null;
};

type DocumentWithUrl = EmployeeDocument & { publicUrl: string | null };

type EditForm = {
  cnic?: File;
  police_verification?: File;
  other?: FileList;
};

const formatDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
};

export default function Documents() {
  const { profile, company } = useAuth();
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState("all");
  const [shiftFilter, setShiftFilter] = useState<"all" | "day" | "night">("all");

  const [viewing, setViewing] = useState<EmployeeRow | null>(null);
  const [viewDocs, setViewDocs] = useState<DocumentWithUrl[]>([]);
  const [viewLoading, setViewLoading] = useState(false);

  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({});
  const [editSubmitting, setEditSubmitting] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [locRes, cliRes, empRes, docRes] = await Promise.all([
      supabase.from("locations").select("*").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase
        .from("employees")
        .select("*, location:location_id(name), client:client_id(name)")
        .order("full_name"),
      supabase.from("employee_documents").select("employee_id, uploaded_at"),
    ]);

    if (locRes.error) setError(locRes.error.message);
    if (cliRes.error) setError(cliRes.error.message);
    if (empRes.error) setError(empRes.error.message);
    if (docRes.error) setError(docRes.error.message);

    const agg = new Map<string, { count: number; latest: string | null }>();
    for (const d of (docRes.data ?? []) as any[]) {
      const cur = agg.get(d.employee_id) ?? { count: 0, latest: null };
      cur.count += 1;
      if (!cur.latest || (d.uploaded_at && d.uploaded_at > cur.latest)) {
        cur.latest = d.uploaded_at ?? cur.latest;
      }
      agg.set(d.employee_id, cur);
    }

    setLocations(locRes.data ?? []);
    setClients(cliRes.data ?? []);
    setEmployees(
      ((empRes.data ?? []) as any[]).map((e) => {
        const a = agg.get(e.id);
        return {
          ...e,
          location_name: e.location?.name ?? null,
          client_name: e.client?.name ?? null,
          doc_count: a?.count ?? 0,
          last_updated: a?.latest ?? null,
        } as EmployeeRow;
      })
    );
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      if (
        q &&
        !e.full_name.toLowerCase().includes(q) &&
        !e.employee_code.toLowerCase().includes(q) &&
        !(e.phone ?? "").toLowerCase().includes(q)
      )
        return false;
      if (locationFilter !== "all" && e.location_id !== locationFilter) return false;
      if (clientFilter !== "all" && e.client_id !== clientFilter) return false;
      if (shiftFilter !== "all" && e.shift !== shiftFilter) return false;
      return true;
    });
  }, [employees, search, locationFilter, clientFilter, shiftFilter]);

  type EmpRef = { id: string; employee_code: string; full_name: string };

  const uploadDoc = async (employee: EmpRef, docType: string, file: File) => {
    const effectiveCompanyId =
      profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!effectiveCompanyId || !company?.name) {
      throw new Error("Company not loaded — refresh and try again.");
    }
    const form = new FormData();
    form.append("file", file);
    form.append("category", "employees");
    form.append("company_id", effectiveCompanyId);
    form.append("company_name", company.name);
    form.append("entity_id", employee.id);
    form.append("entity_code", employee.employee_code);
    form.append("entity_name", employee.full_name);
    form.append("doc_type", docType);
    const { data, error: fnErr } = await supabase.functions.invoke(
      "gdrive-upload",
      { body: form },
    );
    if (fnErr) {
      let detail = fnErr.message;
      try {
        const ctx = (fnErr as { context?: Response }).context;
        if (ctx) {
          const body = await ctx.clone().json();
          if (body?.error) detail = String(body.error);
        }
      } catch {}
      throw new Error(`Drive upload failed: ${detail}`);
    }
    if (!data?.drive_file_id) throw new Error(data?.error ?? "Upload failed");
    const { error: insErr } = await supabase.from("employee_documents").insert({
      employee_id: employee.id,
      doc_type: docType,
      file_name: data.file_name ?? file.name,
      storage_path: null,
      drive_file_id: data.drive_file_id,
      drive_view_url: data.drive_view_url,
      mime_type: data.mime_type ?? file.type,
      size_bytes: data.size_bytes ?? file.size,
    });
    if (insErr) throw insErr;
  };

  const deleteDocFiles = async (
    rows: { drive_file_id?: string | null; storage_path?: string | null }[],
  ) => {
    const drivePromises = rows
      .filter((r) => r.drive_file_id)
      .map((r) =>
        supabase.functions.invoke("gdrive-delete", {
          body: { drive_file_id: r.drive_file_id },
        }),
      );
    const legacyPaths = rows
      .map((r) => r.storage_path)
      .filter((p): p is string => !!p);
    const storagePromise =
      legacyPaths.length > 0
        ? supabase.storage.from(EMPLOYEE_DOCS_BUCKET).remove(legacyPaths)
        : Promise.resolve();
    await Promise.all([...drivePromises, storagePromise]);
  };

  const replaceDoc = async (employee: EmpRef, docType: string, file: File) => {
    const { data: existing } = await supabase
      .from("employee_documents")
      .select("id, storage_path, drive_file_id")
      .eq("employee_id", employee.id)
      .eq("doc_type", docType);
    if (existing && existing.length > 0) {
      await deleteDocFiles(existing as any[]);
      await supabase
        .from("employee_documents")
        .delete()
        .in(
          "id",
          existing.map((d: any) => d.id)
        );
    }
    await uploadDoc(employee, docType, file);
  };

  const loadDocs = async (emp: EmployeeRow) => {
    setViewLoading(true);
    const { data } = await supabase
      .from("employee_documents")
      .select("*")
      .eq("employee_id", emp.id)
      .order("uploaded_at", { ascending: false });
    const docs: DocumentWithUrl[] = ((data ?? []) as EmployeeDocument[]).map((d) => {
      if (d.drive_view_url) return { ...d, publicUrl: d.drive_view_url };
      if (d.storage_path) {
        const { data: urlData } = supabase.storage
          .from(EMPLOYEE_DOCS_BUCKET)
          .getPublicUrl(d.storage_path);
        return { ...d, publicUrl: urlData.publicUrl };
      }
      return { ...d, publicUrl: null };
    });
    setViewDocs(docs);
    setViewLoading(false);
  };

  const openView = async (emp: EmployeeRow) => {
    setViewing(emp);
    setViewDocs([]);
    await loadDocs(emp);
  };

  const openEdit = (emp: EmployeeRow) => {
    setEditing(emp);
    setEditForm({});
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    if (!editForm.cnic && !editForm.police_verification && (!editForm.other || editForm.other.length === 0)) {
      setEditing(null);
      return;
    }
    setEditSubmitting(true);
    setError(null);
    try {
      const empRef: EmpRef = {
        id: editing.id,
        employee_code: editing.employee_code,
        full_name: editing.full_name,
      };
      if (editForm.cnic) await replaceDoc(empRef, "CNIC", editForm.cnic);
      if (editForm.police_verification) await replaceDoc(empRef, "Police Verification", editForm.police_verification);
      if (editForm.other) {
        for (let i = 0; i < editForm.other.length; i++) {
          await uploadDoc(empRef, "Other", editForm.other[i]);
        }
      }
      setEditing(null);
      setEditForm({});
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setEditSubmitting(false);
    }
  };

  const downloadDoc = async (doc: DocumentWithUrl) => {
    setError(null);
    try {
      if (doc.drive_file_id) {
        // Drive download endpoint � alt=media streams the file directly.
        // Since we set "anyone with link" permission on upload, this works
        // without an access token.
        const url = `https://drive.google.com/uc?export=download&id=${doc.drive_file_id}`;
        window.open(url, "_blank");
        return;
      }
      if (!doc.storage_path) throw new Error("No storage path or Drive ID on this document.");
      const { data, error: dlErr } = await supabase.storage
        .from(EMPLOYEE_DOCS_BUCKET)
        .download(doc.storage_path);
      if (dlErr) throw dlErr;
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.file_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };

  const deleteDoc = async (doc: DocumentWithUrl) => {
    if (!viewing) return;
    if (!window.confirm(`Delete "${doc.file_name}"?`)) return;
    setError(null);
    try {
      await deleteDocFiles([doc]);
      const { error: delErr } = await supabase.from("employee_documents").delete().eq("id", doc.id);
      if (delErr) throw delErr;
      await loadDocs(viewing);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };

  return (
    <>
      <Header title="Documents" subtitle="Employee document repository (Google Drive)" />

      <div className="flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-[240px] relative">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
                  strokeWidth={1.5}
                />
                <input
                  type="text"
                  placeholder="Search by employee ID, name, or phone..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <ThemedSelect
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Locations</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </ThemedSelect>
              <ClientFilterSelect
                clients={clients}
                value={clientFilter}
                onChange={setClientFilter}
                allValue="all"
              />
              <ThemedSelect
                value={shiftFilter}
                onChange={(e) => setShiftFilter(e.target.value as "all" | "day" | "night")}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Shifts</option>
                <option value="day">Day</option>
                <option value="night">Night</option>
              </ThemedSelect>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Employee ID</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Name</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Phone</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Location</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Shift</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Documents</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Last Updated</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading && (
                  <tr>
                    <td colSpan={9} className="px-6 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-6 py-10 text-center text-slate-500 text-sm">
                      No employees match the current filters.
                    </td>
                  </tr>
                )}
                {!loading &&
                  filtered.map((emp) => (
                    <tr key={emp.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 text-sm text-slate-600 font-mono">
                        {emp.employee_code}
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-900">{emp.full_name}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{emp.phone ?? "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {emp.location_name ?? "—"}
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {emp.client_name ?? "—"}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs capitalize ${
                            emp.shift === "day"
                              ? "bg-warning-50 text-warning-700"
                              : "bg-indigo-50 text-indigo-700"
                          }`}
                        >
                          {emp.shift}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-slate-400" strokeWidth={1.5} />
                          <span className="text-sm text-slate-600">
                            {emp.doc_count === 0 ? "No documents" : `${emp.doc_count} file${emp.doc_count === 1 ? "" : "s"}`}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {formatDate(emp.last_updated)}
                      </td>
                      <td className="px-6 py-4 flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => openView(emp)}>
                          View
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(emp)}>
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Modal
        isOpen={viewing !== null}
        onClose={() => {
          setViewing(null);
          setViewDocs([]);
        }}
        title="Employee Documents"
        size="lg"
      >
        {viewing && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-slate-500 mb-1">Employee ID</p>
                <p className="text-slate-900 font-mono">{viewing.employee_code}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Name</p>
                <p className="text-slate-900">{viewing.full_name}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Phone</p>
                <p className="text-slate-900">{viewing.phone ?? "—"}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Shift</p>
                <p className="text-slate-900 capitalize">{viewing.shift}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Location</p>
                <p className="text-slate-900">{viewing.location_name ?? "—"}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Client</p>
                <p className="text-slate-900">{viewing.client_name ?? "—"}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Last Updated</p>
                <p className="text-slate-900">{formatDate(viewing.last_updated)}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Total Documents</p>
                <p className="text-slate-900">{viewing.doc_count}</p>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200">
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-sm text-slate-900">Documents</h4>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    openEdit(viewing);
                    setViewing(null);
                    setViewDocs([]);
                  }}
                >
                  <Upload className="w-4 h-4 mr-2" strokeWidth={1.5} />
                  Upload / Replace
                </Button>
              </div>
              {viewLoading ? (
                <div className="text-sm text-slate-500 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                </div>
              ) : viewDocs.length === 0 ? (
                <p className="text-sm text-slate-500">No documents uploaded yet.</p>
              ) : (
                <div className="space-y-2">
                  {viewDocs.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between p-3 border border-slate-200 rounded-lg"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <FileText className="w-4 h-4 text-slate-400 mt-0.5" strokeWidth={1.5} />
                        <div className="min-w-0">
                          <p className="text-sm text-slate-900 truncate">{d.file_name}</p>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {d.doc_type} · Uploaded {formatDate(d.uploaded_at ?? null)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {d.publicUrl && (
                          <a
                            href={d.publicUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center px-2.5 py-1.5 rounded-md text-sm text-slate-700 hover:bg-slate-100"
                          >
                            View
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => downloadDoc(d)}
                          className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-slate-700 hover:bg-slate-100"
                          title="Download"
                        >
                          <Download className="w-4 h-4" strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteDoc(d)}
                          className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-danger-700 hover:bg-danger-50"
                          title="Delete"
                        >
                          <X className="w-4 h-4" strokeWidth={1.5} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
              <Button
                variant="secondary"
                size="md"
                className="flex-1"
                onClick={() => {
                  setViewing(null);
                  setViewDocs([]);
                }}
              >
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={editing !== null}
        onClose={() => {
          setEditing(null);
          setEditForm({});
        }}
        title="Upload Documents"
        size="md"
      >
        {editing && (
          <form className="space-y-4" onSubmit={handleEditSubmit}>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-md text-sm">
              <p className="text-slate-900">{editing.full_name}</p>
              <p className="text-slate-500 text-xs mt-0.5 font-mono">{editing.employee_code}</p>
            </div>

            <p className="text-xs text-slate-500">
              Uploading a CNIC or Police Verification replaces the existing one. "Other" documents are appended.
              Leave fields empty to skip them.
            </p>

            <div>
              <label className="block text-sm text-slate-700 mb-1">CNIC</label>
              <input
                type="file"
                onChange={(e) => setEditForm({ ...editForm, cnic: e.target.files?.[0] })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Police Verification</label>
              <input
                type="file"
                onChange={(e) => setEditForm({ ...editForm, police_verification: e.target.files?.[0] })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Other Documents</label>
              <input
                type="file"
                multiple
                onChange={(e) => setEditForm({ ...editForm, other: e.target.files ?? undefined })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>

            <div className="flex items-center gap-3 pt-4">
              <Button variant="primary" size="md" className="flex-1" disabled={editSubmitting}>
                {editSubmitting ? "Uploading…" : "Save Documents"}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setEditing(null);
                  setEditForm({});
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
