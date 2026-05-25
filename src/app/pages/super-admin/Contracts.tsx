import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  X,
  FileText,
  Upload,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import {
  supabase,
  CONTRACT_TYPE_LABEL,
  CONTRACT_SHIFT_LABEL,
  CONTRACT_STATUS_LABEL,
  type Client,
  type Contract,
  type ContractShiftPattern,
  type ContractStatus,
  type ContractType,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type ContractRow = Contract & { client_name: string; client_code: string };

type ContractForm = {
  client_id: string;
  contract_type: ContractType;
  start_date: string;
  end_date: string;
  number_of_guards: string;
  shift_pattern: ContractShiftPattern;
  rate_per_guard_per_month: string;
  allowed_leaves_per_month: string;
  eobi_deduction: boolean;
  eobi_amount: string;
  annual_escalation_pct: string;
  auto_invoice_enabled: boolean;
  renewal_terms: string;
  status: ContractStatus;
};

const emptyForm: ContractForm = {
  client_id: "",
  contract_type: "static",
  start_date: new Date().toISOString().slice(0, 10),
  end_date: "",
  number_of_guards: "0",
  shift_pattern: "day",
  rate_per_guard_per_month: "0",
  allowed_leaves_per_month: "",
  eobi_deduction: false,
  eobi_amount: "",
  annual_escalation_pct: "",
  auto_invoice_enabled: false,
  renewal_terms: "",
  status: "active",
};

const today = () => new Date().toISOString().slice(0, 10);

export default function Contracts() {
  const { profile, company } = useAuth();
  const [rows, setRows] = useState<ContractRow[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ContractStatus>("all");
  const [clientFilter, setClientFilter] = useState("all");

  const [addOpen, setAddOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<ContractRow | null>(null);
  const [form, setForm] = useState<ContractForm>(emptyForm);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [contractsRes, clientsRes] = await Promise.all([
      supabase.from("contracts").select("*").order("start_date", { ascending: false }),
      supabase.from("clients").select("*").order("name"),
    ]);
    const cs = (clientsRes.data ?? []) as Client[];
    const byId = new Map(cs.map((c) => [c.id, c]));
    const list = ((contractsRes.data ?? []) as Contract[]).map<ContractRow>((c) => ({
      ...c,
      client_name: byId.get(c.client_id)?.name ?? "(deleted)",
      client_code: byId.get(c.client_id)?.client_code ?? "—",
    }));
    setRows(list);
    setClients(cs);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (clientFilter !== "all" && r.client_id !== clientFilter) return false;
      if (q && !r.client_name.toLowerCase().includes(q) && !r.contract_code.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, statusFilter, clientFilter]);

  const buildPayload = () => ({
    client_id: form.client_id,
    contract_type: form.contract_type,
    start_date: form.start_date,
    end_date: form.end_date || null,
    number_of_guards: Math.max(0, Math.floor(Number(form.number_of_guards) || 0)),
    shift_pattern: form.shift_pattern,
    rate_per_guard_per_month: Math.max(0, Number(form.rate_per_guard_per_month) || 0),
    allowed_leaves_per_month: form.allowed_leaves_per_month === "" ? null : Math.max(0, Math.floor(Number(form.allowed_leaves_per_month) || 0)),
    eobi_deduction: form.eobi_deduction,
    eobi_amount: form.eobi_deduction && form.eobi_amount !== "" ? Number(form.eobi_amount) : null,
    annual_escalation_pct: form.annual_escalation_pct === "" ? null : Number(form.annual_escalation_pct),
    auto_invoice_enabled: form.auto_invoice_enabled,
    renewal_terms: form.renewal_terms.trim() || null,
    status: form.status,
  });

  const uploadDocument = async (
    contractId: string,
    contractCode: string,
    file: File,
    existingDriveFileId: string | null,
  ) => {
    const effectiveCompanyId =
      profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!effectiveCompanyId || !company?.name) {
      throw new Error("Company not loaded — refresh and try again.");
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("category", "contracts");
    fd.append("company_id", effectiveCompanyId);
    fd.append("company_name", company.name);
    fd.append("entity_id", contractId);
    fd.append("entity_code", contractCode);
    fd.append("entity_name", contractCode);
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
    if (existingDriveFileId) {
      await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gdrive-delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ drive_file_id: existingDriveFileId }),
      });
    }
    await supabase
      .from("contracts")
      .update({
        drive_file_id: json.drive_file_id,
        drive_view_url: json.drive_view_url,
        contract_file_name: json.file_name ?? file.name,
      })
      .eq("id", contractId);
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.client_id) {
      setError("Select a client.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { data, error: insErr } = await supabase
        .from("contracts")
        .insert(buildPayload())
        .select()
        .single();
      if (insErr) throw insErr;
      const inserted = data as Contract;
      if (pendingFile) {
        await uploadDocument(inserted.id, inserted.contract_code, pendingFile, null);
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

  const openEdit = (row: ContractRow) => {
    setEditingRow(row);
    setForm({
      client_id: row.client_id,
      contract_type: row.contract_type,
      start_date: row.start_date,
      end_date: row.end_date ?? "",
      number_of_guards: String(row.number_of_guards),
      shift_pattern: row.shift_pattern,
      rate_per_guard_per_month: String(row.rate_per_guard_per_month),
      allowed_leaves_per_month: row.allowed_leaves_per_month != null ? String(row.allowed_leaves_per_month) : "",
      eobi_deduction: row.eobi_deduction,
      eobi_amount: row.eobi_amount != null ? String(row.eobi_amount) : "",
      annual_escalation_pct: row.annual_escalation_pct != null ? String(row.annual_escalation_pct) : "",
      auto_invoice_enabled: row.auto_invoice_enabled,
      renewal_terms: row.renewal_terms ?? "",
      status: row.status,
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
        .from("contracts")
        .update(buildPayload())
        .eq("id", editingRow.id);
      if (upErr) throw upErr;
      if (pendingFile) {
        await uploadDocument(editingRow.id, editingRow.contract_code, pendingFile, editingRow.drive_file_id);
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

  const handleDelete = async (row: ContractRow) => {
    if (!window.confirm(`Delete contract ${row.contract_code} for ${row.client_name}?`)) return;
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
    const { error: delErr } = await supabase.from("contracts").delete().eq("id", row.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const uploadFromRow = async (row: ContractRow, file: File) => {
    setUploadingId(row.id);
    setError(null);
    try {
      await uploadDocument(row.id, row.contract_code, file, row.drive_file_id);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setUploadingId(null);
    }
  };

  const daysUntilEnd = (end: string | null): number | null => {
    if (!end) return null;
    const a = new Date(end + "T00:00:00").getTime();
    const b = new Date(today() + "T00:00:00").getTime();
    return Math.round((a - b) / 86400000);
  };

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
        <div className="col-span-2">
          <label className="block text-sm text-slate-700 mb-1">Client *</label>
          <select
            required
            value={form.client_id}
            onChange={(e) => setForm({ ...form, client_id: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            disabled={editingRow !== null}
          >
            <option value="">— Select client —</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.client_code})</option>
            ))}
          </select>
          {editingRow && (
            <p className="text-[10px] text-slate-500 mt-1">Client cannot be changed after creation.</p>
          )}
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Contract Type *</label>
          <select
            required
            value={form.contract_type}
            onChange={(e) => setForm({ ...form, contract_type: e.target.value as ContractType })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            {(["static", "mobile_patrol", "event", "reliever_pool"] as const).map((t) => (
              <option key={t} value={t}>{CONTRACT_TYPE_LABEL[t]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Status</label>
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as ContractStatus })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            {(["active", "expired", "terminated", "draft"] as const).map((s) => (
              <option key={s} value={s}>{CONTRACT_STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Start Date *</label>
          <input
            required
            type="date"
            value={form.start_date}
            onChange={(e) => setForm({ ...form, start_date: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">End Date</label>
          <input
            type="date"
            value={form.end_date}
            onChange={(e) => setForm({ ...form, end_date: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          />
          <p className="text-[10px] text-slate-500 mt-1">Triggers 90/60/30-day renewal alerts.</p>
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Number of Guards *</label>
          <input
            required
            type="number"
            min="0"
            value={form.number_of_guards}
            onChange={(e) => setForm({ ...form, number_of_guards: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Shift Pattern *</label>
          <select
            required
            value={form.shift_pattern}
            onChange={(e) => setForm({ ...form, shift_pattern: e.target.value as ContractShiftPattern })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            {(["day", "night", "both", "custom"] as const).map((s) => (
              <option key={s} value={s}>{CONTRACT_SHIFT_LABEL[s]}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Rate per Guard / month (PKR) *</label>
          <input
            required
            type="number"
            min="0"
            step="0.01"
            value={form.rate_per_guard_per_month}
            onChange={(e) => setForm({ ...form, rate_per_guard_per_month: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Allowed Leaves / month</label>
          <input
            type="number"
            min="0"
            value={form.allowed_leaves_per_month}
            onChange={(e) => setForm({ ...form, allowed_leaves_per_month: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            placeholder="Inherits client default if blank"
          />
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm text-slate-700 mb-1">
            <input
              type="checkbox"
              checked={form.eobi_deduction}
              onChange={(e) => setForm({ ...form, eobi_deduction: e.target.checked })}
            />
            EOBI deduction
          </label>
          {form.eobi_deduction && (
            <input
              type="number"
              min="0"
              value={form.eobi_amount}
              onChange={(e) => setForm({ ...form, eobi_amount: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              placeholder="Per-employee EOBI"
            />
          )}
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Annual Escalation %</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.annual_escalation_pct}
            onChange={(e) => setForm({ ...form, annual_escalation_pct: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            placeholder="e.g. 10"
          />
        </div>

        <div className="col-span-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.auto_invoice_enabled}
              onChange={(e) => setForm({ ...form, auto_invoice_enabled: e.target.checked })}
            />
            Auto-generate monthly invoice on the 1st
          </label>
        </div>

        <div className="col-span-2">
          <label className="block text-sm text-slate-700 mb-1">Renewal Terms</label>
          <textarea
            value={form.renewal_terms}
            onChange={(e) => setForm({ ...form, renewal_terms: e.target.value })}
            rows={2}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            placeholder="Free text for special clauses"
          />
        </div>

        <div className="col-span-2">
          <label className="block text-sm text-slate-700 mb-1">Contract Document</label>
          {editingRow?.drive_view_url && !pendingFile ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2 border border-slate-200 rounded-md">
              <a
                href={editingRow.drive_view_url}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 text-sm text-brand-600 hover:text-brand-700"
              >
                <FileText className="w-4 h-4" />
                {editingRow.contract_file_name ?? "Current document"}
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
              {pendingFile ? pendingFile.name : "Choose scanned contract (uploads to Drive on Save)"}
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
        title="Contracts"
        subtitle="One client can have multiple contracts — each with its own rate, term and guard count"
        actions={
          <Button variant="primary" size="md" onClick={() => { setForm(emptyForm); setPendingFile(null); setAddOpen(true); }}>
            <Plus className="w-4 h-4 mr-2" />
            Add Contract
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

        <div className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by client or code…"
              className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="all">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | ContractStatus)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="all">All statuses</option>
            {(["active", "expired", "terminated", "draft"] as const).map((s) => (
              <option key={s} value={s}>{CONTRACT_STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Code</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Client</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Type</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Period</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Guards</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Rate/mo</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Status</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Document</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-slate-500 text-sm">
                      No contracts match the current filters.
                    </td>
                  </tr>
                )}
                {!loading && filteredRows.map((row) => {
                  const dleft = daysUntilEnd(row.end_date);
                  const endingSoon = dleft != null && dleft <= 90 && dleft >= 0;
                  return (
                    <tr key={row.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 text-xs font-mono text-slate-900">{row.contract_code}</td>
                      <td className="px-4 py-3 text-sm text-slate-900">
                        <div>{row.client_name}</div>
                        <div className="text-xs text-slate-500 font-mono">{row.client_code}</div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{CONTRACT_TYPE_LABEL[row.contract_type]}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">
                        <div>{row.start_date}</div>
                        {row.end_date && (
                          <div className={endingSoon ? "text-warning-700 text-xs" : "text-xs text-slate-500"}>
                            → {row.end_date}
                            {endingSoon && ` (${dleft}d)`}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-slate-900">{row.number_of_guards}</td>
                      <td className="px-4 py-3 text-sm text-right text-slate-900">
                        PKR {Number(row.rate_per_guard_per_month).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {row.drive_view_url ? (
                          <a
                            href={row.drive_view_url}
                            target="_blank"
                            rel="noopener"
                            className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 text-xs"
                          >
                            <FileText className="w-3 h-3" />
                            View
                          </a>
                        ) : (
                          <label className="cursor-pointer text-xs text-slate-500 hover:text-slate-900">
                            {uploadingId === row.id ? "Uploading…" : "Upload"}
                            <input
                              type="file"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) uploadFromRow(row, f);
                                e.target.value = "";
                              }}
                            />
                          </label>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex gap-1 justify-end">
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
        title="Add Contract"
        size="lg"
      >
        {renderForm(handleAdd, "Add Contract")}
      </Modal>

      <Modal
        isOpen={editingRow !== null}
        onClose={() => { setEditingRow(null); setForm(emptyForm); setPendingFile(null); }}
        title={`Edit ${editingRow?.contract_code ?? ""}`}
        size="lg"
      >
        {renderForm(handleEdit, "Save Changes")}
      </Modal>
    </>
  );
}

function StatusBadge({ status }: { status: ContractStatus }) {
  const style: Record<ContractStatus, string> = {
    active: "bg-success-50 text-success-700 border-success-200",
    expired: "bg-slate-100 text-slate-600 border-slate-200",
    terminated: "bg-danger-50 text-danger-700 border-danger-200",
    draft: "bg-warning-50 text-warning-700 border-warning-200",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs border ${style[status]}`}>
      {CONTRACT_STATUS_LABEL[status]}
    </span>
  );
}
