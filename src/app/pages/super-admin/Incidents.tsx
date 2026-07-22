import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  X,
  Upload,
  FileText,
  ShieldAlert,
} from "lucide-react";
import Header from "../../components/Header";
import { useRegion, withRegion } from "../../lib/region";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { formatDateTime } from "../../lib/date";
import {
  supabase,
  INCIDENT_SEVERITY_LABEL,
  INCIDENT_CATEGORY_LABEL,
  INCIDENT_STATUS_LABEL,
  type Incident,
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentStatus,
  type Client,
  type Post,
  type Employee,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type IncidentRow = Incident & {
  client_name: string | null;
  guard_names: string[];
};

type IncidentForm = {
  occurred_at: string;
  client_id: string;
  post_id: string;
  severity: IncidentSeverity;
  category: IncidentCategory;
  description: string;
  client_notified: boolean;
  client_notified_at: string;
  action_taken: string;
  status: IncidentStatus;
  guard_ids: string[];
};

const emptyForm: IncidentForm = {
  occurred_at: new Date().toISOString().slice(0, 16),
  client_id: "",
  post_id: "",
  severity: "medium",
  category: "other",
  description: "",
  client_notified: false,
  client_notified_at: "",
  action_taken: "",
  status: "open",
  guard_ids: [],
};

const SEVERITY_COLOUR: Record<IncidentSeverity, string> = {
  low: "bg-slate-100 text-slate-700 border-slate-200",
  medium: "bg-warning-50 text-warning-700 border-warning-200",
  high: "bg-danger-50 text-danger-700 border-danger-200",
  critical: "bg-danger-600 text-[#fff] border-danger-700",
};

const STATUS_COLOUR: Record<IncidentStatus, string> = {
  open: "bg-danger-50 text-danger-700 border-danger-200",
  under_investigation: "bg-warning-50 text-warning-700 border-warning-200",
  resolved: "bg-brand-50 text-brand-700 border-brand-200",
  closed: "bg-success-50 text-success-700 border-success-200",
};

export default function Incidents() {
  const { profile, company } = useAuth();
  const { regionId } = useRegion();
  const [rows, setRows] = useState<IncidentRow[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<"all" | IncidentSeverity>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | IncidentStatus>("all");
  const [clientFilter, setClientFilter] = useState<string>("all");

  const [addOpen, setAddOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<IncidentRow | null>(null);
  const [form, setForm] = useState<IncidentForm>(emptyForm);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [incRes, cliRes, postRes, empRes, guardRes] = await Promise.all([
      withRegion(
        supabase.from("incidents").select("*").order("occurred_at", { ascending: false }),
        regionId,
      ),
      supabase.from("clients").select("*").order("name"),
      supabase.from("posts").select("*").order("name"),
      supabase.from("employees").select("id, full_name, employee_code, status, client_id").order("full_name"),
      supabase.from("incident_guards").select("*"),
    ]);
    if (incRes.error) setError(incRes.error.message);
    const cs = (cliRes.data ?? []) as Client[];
    const cliById = new Map(cs.map((c) => [c.id, c]));
    const es = (empRes.data ?? []) as Employee[];
    const empById = new Map(es.map((e) => [e.id, e]));
    const guards = (guardRes.data ?? []) as { incident_id: string; employee_id: string }[];
    const guardsByIncident = new Map<string, string[]>();
    for (const g of guards) {
      const arr = guardsByIncident.get(g.incident_id) ?? [];
      const emp = empById.get(g.employee_id);
      if (emp) arr.push(emp.full_name);
      guardsByIncident.set(g.incident_id, arr);
    }
    setRows(
      ((incRes.data ?? []) as Incident[]).map<IncidentRow>((i) => ({
        ...i,
        client_name: i.client_id ? cliById.get(i.client_id)?.name ?? null : null,
        guard_names: guardsByIncident.get(i.id) ?? [],
      })),
    );
    setClients(cs);
    setPosts((postRes.data ?? []) as Post[]);
    setEmployees(es);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (severityFilter !== "all" && r.severity !== severityFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (clientFilter !== "all" && r.client_id !== clientFilter) return false;
      if (q) {
        const hay = `${r.incident_code} ${r.description ?? ""} ${r.guard_names.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, severityFilter, statusFilter, clientFilter]);

  const counts = useMemo(() => {
    const c = { open: 0, investigating: 0, resolved: 0, closed: 0, critical: 0 };
    for (const r of rows) {
      if (r.status === "open") c.open += 1;
      else if (r.status === "under_investigation") c.investigating += 1;
      else if (r.status === "resolved") c.resolved += 1;
      else if (r.status === "closed") c.closed += 1;
      if (r.severity === "critical") c.critical += 1;
    }
    return c;
  }, [rows]);

  const uploadAttachment = async (incidentId: string, incidentCode: string, file: File): Promise<{
    drive_file_id: string;
    drive_view_url: string;
    file_name: string;
  }> => {
    const effectiveCompanyId =
      profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!effectiveCompanyId || !company?.name) {
      throw new Error("Company not loaded — refresh and try again.");
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("category", "incidents");
    fd.append("company_id", effectiveCompanyId);
    fd.append("company_name", company.name);
    fd.append("entity_id", incidentId);
    fd.append("entity_code", incidentCode);
    fd.append("entity_name", incidentCode);
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    const resp = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gdrive-upload`,
      {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      },
    );
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error ?? "Upload failed");
    return {
      drive_file_id: json.drive_file_id,
      drive_view_url: json.drive_view_url,
      file_name: json.file_name ?? file.name,
    };
  };

  const syncGuards = async (incidentId: string, guardIds: string[]) => {
    // Wipe existing junction rows then re-insert. Small lists; fine.
    await supabase.from("incident_guards").delete().eq("incident_id", incidentId);
    if (guardIds.length > 0) {
      await supabase
        .from("incident_guards")
        .insert(guardIds.map((eid) => ({ incident_id: incidentId, employee_id: eid })));
    }
  };

  const buildPayload = () => ({
    occurred_at: new Date(form.occurred_at).toISOString(),
    client_id: form.client_id || null,
    post_id: form.post_id || null,
    severity: form.severity,
    category: form.category,
    description: form.description.trim() || null,
    client_notified: form.client_notified,
    client_notified_at: form.client_notified && form.client_notified_at ? form.client_notified_at : null,
    action_taken: form.action_taken.trim() || null,
    status: form.status,
  });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { data, error: insErr } = await supabase
        .from("incidents")
        .insert(buildPayload())
        .select()
        .single();
      if (insErr) throw insErr;
      const inserted = data as Incident;
      await syncGuards(inserted.id, form.guard_ids);
      if (pendingFile) {
        const up = await uploadAttachment(inserted.id, inserted.incident_code, pendingFile);
        await supabase
          .from("incidents")
          .update({
            drive_file_id: up.drive_file_id,
            drive_view_url: up.drive_view_url,
            attachment_file_name: up.file_name,
          })
          .eq("id", inserted.id);
      }
      setAddOpen(false);
      setForm(emptyForm);
      setPendingFile(null);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = async (row: IncidentRow) => {
    setEditingRow(row);
    // Re-fetch the guard IDs (we only have names cached).
    const { data: junction } = await supabase
      .from("incident_guards")
      .select("employee_id")
      .eq("incident_id", row.id);
    const guardIds = ((junction ?? []) as { employee_id: string }[]).map((j) => j.employee_id);
    setForm({
      occurred_at: row.occurred_at.slice(0, 16),
      client_id: row.client_id ?? "",
      post_id: row.post_id ?? "",
      severity: row.severity,
      category: row.category,
      description: row.description ?? "",
      client_notified: row.client_notified,
      client_notified_at: row.client_notified_at ?? "",
      action_taken: row.action_taken ?? "",
      status: row.status,
      guard_ids: guardIds,
    });
    setPendingFile(null);
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRow) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from("incidents")
        .update(buildPayload())
        .eq("id", editingRow.id);
      if (upErr) throw upErr;
      await syncGuards(editingRow.id, form.guard_ids);
      if (pendingFile) {
        const up = await uploadAttachment(editingRow.id, editingRow.incident_code, pendingFile);
        // Best-effort cleanup of previous file.
        if (editingRow.drive_file_id) {
          const { data: sess } = await supabase.auth.getSession();
          const token = sess.session?.access_token;
          await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gdrive-delete`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ drive_file_id: editingRow.drive_file_id }),
          });
        }
        await supabase
          .from("incidents")
          .update({
            drive_file_id: up.drive_file_id,
            drive_view_url: up.drive_view_url,
            attachment_file_name: up.file_name,
          })
          .eq("id", editingRow.id);
      }
      setEditingRow(null);
      setForm(emptyForm);
      setPendingFile(null);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (row: IncidentRow) => {
    if (!window.confirm(`Delete incident ${row.incident_code}? This will also remove its guard links.`)) return;
    if (row.drive_file_id) {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gdrive-delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ drive_file_id: row.drive_file_id }),
      });
    }
    const { error: delErr } = await supabase.from("incidents").delete().eq("id", row.id);
    if (delErr) { setError(delErr.message); return; }
    await loadAll();
  };

  const activeGuards = useMemo(() => employees.filter((e) => e.status === "Active"), [employees]);
  // Item 11: only offer guards that belong to the selected client.
  const guardsForClient = useMemo(
    () => (form.client_id ? activeGuards.filter((e) => e.client_id === form.client_id) : []),
    [activeGuards, form.client_id],
  );
  const filteredPosts = useMemo(
    () => (form.client_id ? posts.filter((p) => p.client_id === form.client_id) : posts),
    [posts, form.client_id],
  );

  const renderForm = (onSubmit: (e: React.FormEvent) => void, submitLabel: string) => (
    <form className="space-y-3" onSubmit={onSubmit}>
      {error && (
        <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5" />
          <div className="flex-1">{error}</div>
          <button type="button" onClick={() => setError(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-slate-700 mb-1">Date & Time *</label>
          <input
            required
            type="datetime-local"
            value={form.occurred_at}
            onChange={(e) => setForm({ ...form, occurred_at: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Status</label>
          <ThemedSelect
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as IncidentStatus })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            {(Object.keys(INCIDENT_STATUS_LABEL) as IncidentStatus[]).map((s) => (
              <option key={s} value={s}>{INCIDENT_STATUS_LABEL[s]}</option>
            ))}
          </ThemedSelect>
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Client</label>
          <ThemedSelect
            value={form.client_id}
            onChange={(e) => setForm({ ...form, client_id: e.target.value, post_id: "", guard_ids: [] })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="">— Unspecified —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </ThemedSelect>
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Post / Location</label>
          <ThemedSelect
            value={form.post_id}
            onChange={(e) => setForm({ ...form, post_id: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            disabled={!form.client_id}
          >
            <option value="">— Unspecified —</option>
            {filteredPosts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </ThemedSelect>
          {!form.client_id && (
            <p className="text-[10px] text-slate-500 mt-1">Pick a client first.</p>
          )}
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Severity *</label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
            {(Object.keys(INCIDENT_SEVERITY_LABEL) as IncidentSeverity[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setForm({ ...form, severity: s })}
                className={`px-2 py-1.5 text-xs rounded border transition-colors ${
                  form.severity === s ? SEVERITY_COLOUR[s] : "border-slate-200 hover:bg-slate-50 text-slate-600"
                }`}
              >
                {INCIDENT_SEVERITY_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Category *</label>
          <ThemedSelect
            required
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value as IncidentCategory })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            {(Object.keys(INCIDENT_CATEGORY_LABEL) as IncidentCategory[]).map((c) => (
              <option key={c} value={c}>{INCIDENT_CATEGORY_LABEL[c]}</option>
            ))}
          </ThemedSelect>
        </div>

        <div className="col-span-2">
          <label className="block text-sm text-slate-700 mb-1">Guards Involved</label>
          {!form.client_id ? (
            <p className="text-xs text-slate-500 border border-dashed border-slate-200 rounded-md px-3 py-2">
              Select a client first to choose the guards involved.
            </p>
          ) : (
            <>
              <GuardMultiSelect
                allGuards={guardsForClient}
                selectedIds={form.guard_ids}
                onChange={(ids) => setForm({ ...form, guard_ids: ids })}
              />
              {guardsForClient.length === 0 && (
                <p className="text-xs text-slate-500 mt-1">No active guards are assigned to this client.</p>
              )}
            </>
          )}
        </div>

        <div className="col-span-2">
          <label className="block text-sm text-slate-700 mb-1">Description</label>
          <textarea
            rows={3}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            placeholder="What happened, where, who was there…"
          />
        </div>

        <div className="col-span-2">
          <label className="block text-sm text-slate-700 mb-1">Action Taken</label>
          <textarea
            rows={2}
            value={form.action_taken}
            onChange={(e) => setForm({ ...form, action_taken: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            placeholder="What was done in response"
          />
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm text-slate-700 mb-1">
            <input
              type="checkbox"
              checked={form.client_notified}
              onChange={(e) => setForm({ ...form, client_notified: e.target.checked })}
            />
            Client notified
          </label>
        </div>
        {form.client_notified && (
          <div>
            <label className="block text-sm text-slate-700 mb-1">Notified on</label>
            <input
              type="date"
              value={form.client_notified_at}
              onChange={(e) => setForm({ ...form, client_notified_at: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
        )}

        <div className="col-span-2">
          <label className="block text-sm text-slate-700 mb-1">Attachment (photo / FIR copy)</label>
          {editingRow?.drive_view_url && !pendingFile ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2 border border-slate-200 rounded-md">
              <a
                href={editingRow.drive_view_url}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 text-sm text-brand-600 hover:text-brand-700"
              >
                <FileText className="w-4 h-4" />
                {editingRow.attachment_file_name ?? "Current attachment"}
              </a>
              <label className="cursor-pointer px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50">
                Replace
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setPendingFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          ) : (
            <label className="cursor-pointer inline-flex items-center gap-2 px-3 py-2 text-sm border border-dashed border-slate-300 rounded hover:bg-slate-50 w-full">
              <Upload className="w-4 h-4" />
              {pendingFile ? pendingFile.name : "Upload photo / FIR / CCTV reference"}
              <input
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setPendingFile(f);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
      </div>

      <div className="sticky bottom-0 -mx-6 -mb-6 px-6 py-3 bg-white border-t border-slate-200 flex items-center gap-2">
        <Button variant="primary" size="md" disabled={submitting} className="flex-1">
          {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
          {submitting ? "Saving…" : submitLabel}
        </Button>
        <Button
          variant="secondary"
          size="md"
          onClick={() => {
            setAddOpen(false);
            setEditingRow(null);
            setForm(emptyForm);
            setPendingFile(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );

  return (
    <>
      <Header
        title="Incidents"
        subtitle="Structured log: theft, altercations, no-shows, weapon discharges — with full audit trail per guard and per client"
        actions={
          <Button variant="primary" size="md" onClick={() => { setForm(emptyForm); setPendingFile(null); setAddOpen(true); }}>
            <Plus className="w-4 h-4 mr-2" /> Log Incident
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Summary tiles (clickable filters) */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <SummaryTile
            label="Open"
            value={counts.open}
            colour="bg-danger-500"
            active={statusFilter === "open"}
            onClick={() => setStatusFilter(statusFilter === "open" ? "all" : "open")}
          />
          <SummaryTile
            label="Investigating"
            value={counts.investigating}
            colour="bg-warning-500"
            active={statusFilter === "under_investigation"}
            onClick={() => setStatusFilter(statusFilter === "under_investigation" ? "all" : "under_investigation")}
          />
          <SummaryTile
            label="Resolved"
            value={counts.resolved}
            colour="bg-brand-500"
            active={statusFilter === "resolved"}
            onClick={() => setStatusFilter(statusFilter === "resolved" ? "all" : "resolved")}
          />
          <SummaryTile
            label="Closed"
            value={counts.closed}
            colour="bg-success-500"
            active={statusFilter === "closed"}
            onClick={() => setStatusFilter(statusFilter === "closed" ? "all" : "closed")}
          />
          <SummaryTile
            label="Critical (all status)"
            value={counts.critical}
            colour="bg-danger-600"
            active={severityFilter === "critical"}
            onClick={() => setSeverityFilter(severityFilter === "critical" ? "all" : "critical")}
          />
        </div>

        {/* Filters */}
        <div className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="relative md:col-span-2">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by code, description, or guard…"
              className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <ThemedSelect
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="all">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </ThemedSelect>
        </div>

        {/* Table */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Code</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">When</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Client / Post</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Severity</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Category</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Guards</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Status</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-slate-500 text-sm">
                      <ShieldAlert className="w-5 h-5 inline-block mr-2 text-slate-400" />
                      No incidents match the current filters.
                    </td>
                  </tr>
                )}
                {!loading && filteredRows.map((row) => {
                  const postName = row.post_id ? posts.find((p) => p.id === row.post_id)?.name : null;
                  return (
                    <tr key={row.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 text-xs font-mono text-slate-900">{row.incident_code}</td>
                      <td className="px-4 py-3 text-xs text-slate-700">
                        {formatDateTime(row.occurred_at)}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <div className="text-slate-900">{row.client_name ?? "—"}</div>
                        {postName && <div className="text-xs text-slate-500">{postName}</div>}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <span className={`inline-block px-2 py-0.5 rounded-md text-xs border ${SEVERITY_COLOUR[row.severity]}`}>
                          {INCIDENT_SEVERITY_LABEL[row.severity]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-700">{INCIDENT_CATEGORY_LABEL[row.category]}</td>
                      <td className="px-4 py-3 text-xs text-slate-700 max-w-[180px]">
                        {row.guard_names.length === 0 ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <span title={row.guard_names.join(", ")}>
                            {row.guard_names.slice(0, 2).join(", ")}
                            {row.guard_names.length > 2 && ` +${row.guard_names.length - 2}`}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <span className={`inline-block px-2 py-0.5 rounded-md text-xs border ${STATUS_COLOUR[row.status]}`}>
                          {INCIDENT_STATUS_LABEL[row.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex gap-1 justify-end">
                          {row.drive_view_url && (
                            <a
                              href={row.drive_view_url}
                              target="_blank"
                              rel="noopener"
                              className="p-1.5 rounded text-brand-600 hover:bg-brand-50"
                              title="Attachment"
                            >
                              <FileText className="w-4 h-4" />
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => openEdit(row)}
                            className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                            title="Edit"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(row)}
                            className="p-1.5 rounded text-danger-600 hover:bg-danger-50"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Modal
        isOpen={addOpen}
        onClose={() => { setAddOpen(false); setForm(emptyForm); setPendingFile(null); }}
        title="Log Incident"
        size="lg"
      >
        {renderForm(handleAdd, "Log Incident")}
      </Modal>

      <Modal
        isOpen={editingRow !== null}
        onClose={() => { setEditingRow(null); setForm(emptyForm); setPendingFile(null); }}
        title={`Edit ${editingRow?.incident_code ?? ""}`}
        size="lg"
      >
        {renderForm(handleEdit, "Save Changes")}
      </Modal>
    </>
  );
}

function SummaryTile({
  label,
  value,
  colour,
  active,
  onClick,
}: {
  label: string;
  value: number;
  colour: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left bg-white p-4 rounded-lg border transition-colors ${
        active ? "border-brand-600 ring-2 ring-brand-100" : "border-slate-200 hover:border-slate-300"
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full ${colour}`} />
        <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      </div>
      <div className="text-2xl text-slate-900">{value}</div>
    </button>
  );
}

function GuardMultiSelect({
  allGuards,
  selectedIds,
  onChange,
}: {
  allGuards: Employee[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allGuards.slice(0, 50);
    return allGuards.filter((g) =>
      g.full_name.toLowerCase().includes(q) || g.employee_code.toLowerCase().includes(q),
    ).slice(0, 50);
  }, [allGuards, query]);

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((x) => x !== id));
    else onChange([...selectedIds, id]);
  };

  return (
    <div className="border border-slate-200 rounded-md">
      <div className="p-2 border-b border-slate-200">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search guards…"
          className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
        />
      </div>
      {selectedIds.length > 0 && (
        <div className="p-2 border-b border-slate-200 flex flex-wrap gap-1">
          {selectedIds.map((id) => {
            const emp = allGuards.find((g) => g.id === id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-brand-50 text-brand-700 rounded-full"
              >
                {emp ? emp.full_name : id}
                <button type="button" onClick={() => toggle(id)} className="hover:text-brand-900">
                  <X className="w-3 h-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="max-h-40 overflow-y-auto p-2 space-y-0.5">
        {filtered.length === 0 ? (
          <div className="text-xs text-slate-500 p-2">No matches.</div>
        ) : (
          filtered.map((g) => (
            <label
              key={g.id}
              className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50 cursor-pointer text-sm"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(g.id)}
                onChange={() => toggle(g.id)}
              />
              <span className="text-slate-900">{g.full_name}</span>
              <span className="text-xs text-slate-500 font-mono ml-auto">{g.employee_code}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
