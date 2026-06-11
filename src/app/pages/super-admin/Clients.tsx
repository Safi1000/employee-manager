import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  X,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  FileText,
  Eye,
  Upload,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import {
  supabase,
  PAKISTAN_INDUSTRIES,
  type Client,
  type ClientType,
  type ClientFilerStatus,
  type Branch,
  type Contract,
  type Invoice,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type ClientRow = Client & { employees_count: number; contracts_count: number };

type ClientForm = {
  name: string;
  email: string;
  phone: string;
  industry: string;
  ntn: string;
  strn: string;
  filer_status: ClientFilerStatus | "";
  withholding_tax_rate: string;
  client_type: ClientType;
  branch_id: string;
  billing_address: string;
  authorised_signatory: string;
  signatory_cnic: string;
  allowed_leaves_per_month: string;
  leave_carry_forward: boolean;
  eobi_enabled: boolean;
  eobi_amount: string;
  advance_payment: boolean;
};

const emptyForm: ClientForm = {
  name: "",
  email: "",
  phone: "",
  industry: "",
  ntn: "",
  strn: "",
  filer_status: "",
  withholding_tax_rate: "",
  client_type: "security_services",
  branch_id: "",
  billing_address: "",
  authorised_signatory: "",
  signatory_cnic: "",
  allowed_leaves_per_month: "0",
  leave_carry_forward: false,
  eobi_enabled: false,
  eobi_amount: "0",
  advance_payment: false,
};

const formatCnic = (raw: string): string => {
  const digits = raw.replace(/\D/g, "").slice(0, 13);
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
};

/**
 * Collapsible form section. Defined at module scope (NOT inside Clients) so its component
 * identity is stable across renders. When it was declared inside Clients, every keystroke in
 * a field re-created the component, remounting the section and stealing focus from the input.
 */
function Section({
  isOpen,
  onToggle,
  title,
  children,
}: {
  isOpen: boolean;
  onToggle: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="border border-slate-200 rounded-md">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-slate-900 hover:bg-slate-50"
      >
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
        <span className="flex-1 text-left">{title}</span>
      </button>
      {isOpen && <div className="p-4 border-t border-slate-200 space-y-3">{children}</div>}
    </div>
  );
}

export default function Clients() {
  const { profile, company } = useAuth();
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive" | "ended">("all");
  const [industryFilter, setIndustryFilter] = useState("all");

  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<ClientRow | null>(null);
  const [detailTab, setDetailTab] = useState<"overview" | "contracts" | "invoices" | "documents">("overview");

  const [form, setForm] = useState<ClientForm>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    basic: true,
    tax: false,
    billing: false,
    contract: false,
  });

  // Contract document upload state per row.
  const [contractUploadingId, setContractUploadingId] = useState<string | null>(null);
  const [contractError, setContractError] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [clientsRes, branchesRes, contractsRes, invoicesRes, employeesRes] = await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase
        .from("branches")
        .select("*")
        .order("is_head_office", { ascending: false })
        .order("name"),
      supabase.from("contracts").select("*").order("start_date", { ascending: false }),
      supabase.from("invoices").select("*").order("invoice_date", { ascending: false }),
      supabase.from("employees").select("id, client_id, status"),
    ]);
    const emps = (employeesRes.data ?? []) as { id: string; client_id: string | null; status: string }[];
    const cs = (contractsRes.data ?? []) as Contract[];
    const empByClient = new Map<string, number>();
    for (const e of emps) {
      if (!e.client_id) continue;
      if (e.status !== "Active") continue;
      empByClient.set(e.client_id, (empByClient.get(e.client_id) ?? 0) + 1);
    }
    const conByClient = new Map<string, number>();
    for (const c of cs) {
      if (c.status !== "active") continue;
      conByClient.set(c.client_id, (conByClient.get(c.client_id) ?? 0) + 1);
    }
    const list = ((clientsRes.data ?? []) as Client[]).map<ClientRow>((c) => ({
      ...c,
      employees_count: empByClient.get(c.id) ?? 0,
      contracts_count: conByClient.get(c.id) ?? 0,
    }));
    setRows(list);
    setBranches((branchesRes.data ?? []) as Branch[]);
    setContracts(cs);
    setInvoices((invoicesRes.data ?? []) as Invoice[]);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    return rows.filter((r) => {
      if (branchFilter !== "all" && r.branch_id !== branchFilter) return false;
      if (industryFilter !== "all" && (r.industry ?? "") !== industryFilter) return false;
      if (statusFilter === "active" && (r.contract_end && r.contract_end < today)) return false;
      if (statusFilter === "ended" && !(r.contract_end && r.contract_end < today)) return false;
      if (statusFilter === "inactive" && r.employees_count > 0) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.client_code.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, branchFilter, statusFilter, industryFilter]);

  const resetForm = () => {
    setForm(emptyForm);
    setExpanded({ basic: true, tax: false, billing: false, contract: false });
  };

  const populateForm = (row: ClientRow) => {
    setForm({
      name: row.name,
      email: row.email ?? "",
      phone: row.phone ?? "",
      industry: row.industry ?? "",
      ntn: row.ntn ?? "",
      strn: row.strn ?? "",
      filer_status: row.filer_status ?? "",
      withholding_tax_rate: row.withholding_tax_rate != null ? String(row.withholding_tax_rate) : "",
      client_type: row.client_type,
      branch_id: row.branch_id ?? "",
      billing_address: row.billing_address ?? "",
      authorised_signatory: row.authorised_signatory ?? "",
      signatory_cnic: row.signatory_cnic ?? "",
      allowed_leaves_per_month: String(row.allowed_leaves_per_month ?? 0),
      leave_carry_forward: !!row.leave_carry_forward,
      eobi_enabled: !!row.eobi_enabled,
      eobi_amount: String(row.eobi_amount ?? 0),
      advance_payment: !!row.advance_payment,
    });
  };

  const buildPayload = () => ({
    name: form.name.trim(),
    email: form.email.trim() || null,
    phone: form.phone.trim() || null,
    industry: form.industry || null,
    ntn: form.ntn.trim() || null,
    strn: form.strn.trim() || null,
    filer_status: form.filer_status || null,
    withholding_tax_rate: form.withholding_tax_rate === "" ? null : Number(form.withholding_tax_rate),
    client_type: form.client_type,
    branch_id: form.branch_id || null,
    billing_address: form.billing_address.trim() || null,
    authorised_signatory: form.authorised_signatory.trim() || null,
    signatory_cnic: form.signatory_cnic.trim() || null,
    allowed_leaves_per_month: Math.max(0, Math.floor(Number(form.allowed_leaves_per_month) || 0)),
    leave_carry_forward: form.leave_carry_forward,
    eobi_enabled: form.eobi_enabled,
    eobi_amount: form.eobi_enabled ? Math.max(0, Number(form.eobi_amount) || 0) : 0,
    advance_payment: form.advance_payment,
    // Mirror the new withholding_tax_rate into the legacy column so existing
    // auto-invoice logic on the clients table keeps producing the same WHT.
    auto_invoice_withholding:
      form.withholding_tax_rate === "" ? 0 : Math.max(0, Number(form.withholding_tax_rate) || 0),
  });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSubmitting(true);
    setError(null);
    const { error: insErr } = await supabase.from("clients").insert(buildPayload());
    setSubmitting(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    resetForm();
    setAddOpen(false);
    await loadAll();
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    setSubmitting(true);
    setError(null);
    const { error: upErr } = await supabase
      .from("clients")
      .update(buildPayload())
      .eq("id", editingId);
    setSubmitting(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setEditingId(null);
    resetForm();
    await loadAll();
  };

  const handleDelete = async (row: ClientRow) => {
    if (row.employees_count > 0) {
      setError(`Cannot delete ${row.name}: ${row.employees_count} active employee(s) are assigned. Reassign them first.`);
      return;
    }
    if (!window.confirm(`Delete client "${row.name}"? This cannot be undone.`)) return;
    const { error: delErr } = await supabase.from("clients").delete().eq("id", row.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const uploadContract = async (row: ClientRow, file: File) => {
    const effectiveCompanyId =
      profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!effectiveCompanyId || !company?.name) {
      setContractError("Company not loaded — refresh and try again.");
      return;
    }
    setContractUploadingId(row.id);
    setContractError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", "contracts");
      fd.append("company_id", effectiveCompanyId);
      fd.append("company_name", company.name);
      fd.append("entity_id", row.id);
      fd.append("entity_code", row.client_code);
      fd.append("entity_name", row.name);
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
      if (row.contract_drive_file_id) {
        // Best-effort cleanup of the previous file.
        await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gdrive-delete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ drive_file_id: row.contract_drive_file_id }),
        });
      }
      await supabase
        .from("clients")
        .update({
          contract_drive_file_id: json.drive_file_id,
          contract_drive_view_url: json.drive_view_url,
          contract_file_name: json.file_name ?? file.name,
        })
        .eq("id", row.id);
      await loadAll();
    } catch (err: any) {
      setContractError(err.message ?? String(err));
    } finally {
      setContractUploadingId(null);
    }
  };

  const removeContract = async (row: ClientRow) => {
    if (!row.contract_drive_file_id) return;
    if (!window.confirm("Remove the uploaded contract document?")) return;
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gdrive-delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ drive_file_id: row.contract_drive_file_id }),
    });
    await supabase
      .from("clients")
      .update({
        contract_drive_file_id: null,
        contract_drive_view_url: null,
        contract_file_name: null,
      })
      .eq("id", row.id);
    await loadAll();
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

      <Section isOpen={!!expanded.basic} onToggle={() => setExpanded((prev) => ({ ...prev, basic: !prev.basic }))} title="Basic Information">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Client Name *</label>
            <input
              required
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              placeholder="Registered business name"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              placeholder="billing@client.com"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Phone</label>
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              placeholder="+92 21 …"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Industry</label>
            <select
              value={form.industry}
              onChange={(e) => setForm({ ...form, industry: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">— Select —</option>
              {PAKISTAN_INDUSTRIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Client Type</label>
            <select
              value={form.client_type}
              onChange={(e) => setForm({ ...form, client_type: e.target.value as ClientType })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="security_services">Security Services</option>
              <option value="guard_deployment">Guard Deployment</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Default Branch *</label>
            <select
              required
              value={form.branch_id}
              onChange={(e) => setForm({ ...form, branch_id: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">— Select branch —</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}{b.is_head_office ? " (HO)" : ""}</option>
              ))}
            </select>
            <p className="text-xs text-slate-500 mt-1">Inherited by employees of this client.</p>
          </div>
        </div>
      </Section>

      <Section isOpen={!!expanded.tax} onToggle={() => setExpanded((prev) => ({ ...prev, tax: !prev.tax }))} title="Tax Information">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-slate-700 mb-1">NTN</label>
            <input
              type="text"
              value={form.ntn}
              onChange={(e) => setForm({ ...form, ntn: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm font-mono"
              placeholder="National Tax Number"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">STRN</label>
            <input
              type="text"
              value={form.strn}
              onChange={(e) => setForm({ ...form, strn: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm font-mono"
              placeholder="Sales Tax Registration"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Filer Status</label>
            <select
              value={form.filer_status}
              onChange={(e) => setForm({ ...form, filer_status: e.target.value as ClientFilerStatus | "" })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">— Select —</option>
              <option value="filer">Filer</option>
              <option value="non_filer">Non-filer</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Withholding Tax Rate (%)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={form.withholding_tax_rate}
              onChange={(e) => setForm({ ...form, withholding_tax_rate: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              placeholder="e.g. 8"
            />
            <p className="text-[10px] text-slate-500 mt-1">Applied to every invoice for this client.</p>
          </div>
        </div>
      </Section>

      <Section isOpen={!!expanded.billing} onToggle={() => setExpanded((prev) => ({ ...prev, billing: !prev.billing }))} title="Billing & Signatory">
        <div>
          <label className="block text-sm text-slate-700 mb-1">Billing Address</label>
          <textarea
            value={form.billing_address}
            onChange={(e) => setForm({ ...form, billing_address: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            rows={2}
            placeholder="Full billing address (used on invoices)"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Authorised Signatory</label>
            <input
              type="text"
              value={form.authorised_signatory}
              onChange={(e) => setForm({ ...form, authorised_signatory: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              placeholder="Person who signs contracts"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Signatory CNIC</label>
            <input
              type="text"
              value={form.signatory_cnic}
              onChange={(e) => setForm({ ...form, signatory_cnic: formatCnic(e.target.value) })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm font-mono"
              placeholder="XXXXX-XXXXXXX-X"
              maxLength={15}
            />
          </div>
        </div>
      </Section>

      <Section isOpen={!!expanded.contract} onToggle={() => setExpanded((prev) => ({ ...prev, contract: !prev.contract }))} title="Contract Defaults">
        <p className="text-xs text-slate-500">
          These defaults are inherited by all employees of this client. Per-contract overrides go on the Contracts page.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Allowed Leaves / month</label>
            <input
              type="number"
              min="0"
              value={form.allowed_leaves_per_month}
              onChange={(e) => setForm({ ...form, allowed_leaves_per_month: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.leave_carry_forward}
                onChange={(e) => setForm({ ...form, leave_carry_forward: e.target.checked })}
              />
              Carry forward unused leaves
            </label>
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm text-slate-700 mb-1">
              <input
                type="checkbox"
                checked={form.eobi_enabled}
                onChange={(e) => setForm({ ...form, eobi_enabled: e.target.checked })}
              />
              EOBI deduction enabled
            </label>
            {form.eobi_enabled && (
              <input
                type="number"
                min="0"
                value={form.eobi_amount}
                onChange={(e) => setForm({ ...form, eobi_amount: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="EOBI amount per employee"
              />
            )}
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.advance_payment}
                onChange={(e) => setForm({ ...form, advance_payment: e.target.checked })}
              />
              Pays in advance
            </label>
          </div>
        </div>
      </Section>

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
            setEditingId(null);
            resetForm();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );

  const today = new Date().toISOString().slice(0, 10);
  const isContractEnded = (r: ClientRow) => r.contract_end && r.contract_end < today;

  return (
    <>
      <Header
        title="Clients"
        subtitle="Master records — every employee, contract and invoice anchors here"
        actions={
          <Button variant="primary" size="md" onClick={() => { resetForm(); setAddOpen(true); }}>
            <Plus className="w-4 h-4 mr-2" />
            Add Client
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

        {/* Filters */}
        <div className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or client code…"
              className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="all">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select
            value={industryFilter}
            onChange={(e) => setIndustryFilter(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="all">All industries</option>
            {PAKISTAN_INDUSTRIES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <div className="md:col-span-4 flex flex-wrap gap-2">
            {([
              { v: "all", label: "All" },
              { v: "active", label: "Active" },
              { v: "inactive", label: "No employees" },
              { v: "ended", label: "Contract ended" },
            ] as const).map((s) => (
              <button
                key={s.v}
                type="button"
                onClick={() => setStatusFilter(s.v)}
                className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                  statusFilter === s.v
                    ? "border-brand-600 bg-brand-50 text-brand-700"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Client</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Industry</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Branch</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Employees</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Contracts</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Status</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500 text-sm">
                      No clients match the current filters.
                    </td>
                  </tr>
                )}
                {!loading && filteredRows.map((row) => {
                  const branchName = branches.find((b) => b.id === row.branch_id)?.name ?? "—";
                  const ended = isContractEnded(row);
                  return (
                    <tr key={row.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 text-sm">
                        <div className="text-slate-900">{row.name}</div>
                        <div className="text-xs text-slate-500 font-mono">{row.client_code}</div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{row.industry ?? "—"}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{branchName}</td>
                      <td className="px-4 py-3 text-sm text-right text-slate-900">{row.employees_count}</td>
                      <td className="px-4 py-3 text-sm text-right text-slate-900">{row.contracts_count}</td>
                      <td className="px-4 py-3 text-sm">
                        {ended ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-danger-50 text-danger-700 border border-danger-200">
                            Contract ended
                          </span>
                        ) : row.employees_count === 0 ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-warning-50 text-warning-700 border border-warning-200">
                            No employees
                          </span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-success-50 text-success-700 border border-success-200">
                            Active
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex gap-1 justify-end">
                          <button
                            type="button"
                            onClick={() => {
                              setDetailRow(row);
                              setDetailTab("overview");
                            }}
                            className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                            title="View details"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              populateForm(row);
                              setEditingId(row.id);
                              setExpanded({ basic: true, tax: false, billing: false, contract: false });
                            }}
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

      {/* Add modal */}
      <Modal
        isOpen={addOpen}
        onClose={() => { setAddOpen(false); resetForm(); }}
        title="Add Client"
        size="lg"
      >
        {renderForm(handleAdd, "Add Client")}
      </Modal>

      {/* Edit modal */}
      <Modal
        isOpen={editingId !== null}
        onClose={() => { setEditingId(null); resetForm(); }}
        title="Edit Client"
        size="lg"
      >
        {renderForm(handleEdit, "Save Changes")}
      </Modal>

      {/* Detail modal with tabs */}
      <Modal
        isOpen={detailRow !== null}
        onClose={() => setDetailRow(null)}
        title={detailRow?.name ?? ""}
        size="lg"
      >
        {detailRow && (
          <div className="space-y-4">
            <div className="flex gap-1 border-b border-slate-200">
              {([
                { v: "overview", label: "Overview" },
                { v: "contracts", label: `Contracts (${contracts.filter((c) => c.client_id === detailRow.id).length})` },
                { v: "invoices", label: `Invoices (${invoices.filter((i) => i.client_id === detailRow.id).length})` },
                { v: "documents", label: "Documents" },
              ] as const).map((t) => (
                <button
                  key={t.v}
                  type="button"
                  onClick={() => setDetailTab(t.v)}
                  className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                    detailTab === t.v
                      ? "border-brand-600 text-brand-700"
                      : "border-transparent text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {detailTab === "overview" && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <Field label="Code"><span className="font-mono">{detailRow.client_code}</span></Field>
                <Field label="Industry">{detailRow.industry ?? "—"}</Field>
                <Field label="Email">{detailRow.email ?? "—"}</Field>
                <Field label="Phone">{detailRow.phone ?? "—"}</Field>
                <Field label="NTN">{detailRow.ntn ?? "—"}</Field>
                <Field label="STRN">{detailRow.strn ?? "—"}</Field>
                <Field label="Filer status">
                  {detailRow.filer_status === "filer" ? "Filer" : detailRow.filer_status === "non_filer" ? "Non-filer" : "—"}
                </Field>
                <Field label="Withholding tax">
                  {detailRow.withholding_tax_rate != null ? `${detailRow.withholding_tax_rate}%` : "—"}
                </Field>
                <Field label="Authorised signatory">{detailRow.authorised_signatory ?? "—"}</Field>
                <Field label="Signatory CNIC">{detailRow.signatory_cnic ?? "—"}</Field>
                <div className="col-span-2">
                  <Field label="Billing address">{detailRow.billing_address ?? "—"}</Field>
                </div>
                <Field label="Active employees">{detailRow.employees_count}</Field>
                <Field label="Active contracts">{detailRow.contracts_count}</Field>
              </div>
            )}

            {detailTab === "contracts" && (
              <div className="space-y-2">
                {contracts.filter((c) => c.client_id === detailRow.id).length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No contracts yet. Add one from the Contracts page.
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left px-2 py-2 text-xs text-slate-500 uppercase">Code</th>
                        <th className="text-left px-2 py-2 text-xs text-slate-500 uppercase">Type</th>
                        <th className="text-left px-2 py-2 text-xs text-slate-500 uppercase">Period</th>
                        <th className="text-right px-2 py-2 text-xs text-slate-500 uppercase">Guards</th>
                        <th className="text-right px-2 py-2 text-xs text-slate-500 uppercase">Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {contracts.filter((c) => c.client_id === detailRow.id).map((c) => (
                        <tr key={c.id}>
                          <td className="px-2 py-2 font-mono text-xs">{c.contract_code}</td>
                          <td className="px-2 py-2 text-xs">{c.contract_type}</td>
                          <td className="px-2 py-2 text-xs">{c.start_date}{c.end_date ? ` → ${c.end_date}` : ""}</td>
                          <td className="px-2 py-2 text-xs text-right">{c.number_of_guards}</td>
                          <td className="px-2 py-2 text-xs text-right">PKR {Number(c.rate_per_guard_per_month).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {detailTab === "invoices" && (
              <div className="space-y-2">
                {invoices.filter((i) => i.client_id === detailRow.id).length === 0 ? (
                  <p className="text-sm text-slate-500">No invoices for this client yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left px-2 py-2 text-xs text-slate-500 uppercase">Invoice</th>
                        <th className="text-left px-2 py-2 text-xs text-slate-500 uppercase">Date</th>
                        <th className="text-right px-2 py-2 text-xs text-slate-500 uppercase">Amount</th>
                        <th className="text-right px-2 py-2 text-xs text-slate-500 uppercase">Received</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {invoices.filter((i) => i.client_id === detailRow.id).slice(0, 50).map((inv) => (
                        <tr key={inv.id}>
                          <td className="px-2 py-2 font-mono text-xs">{inv.invoice_number}</td>
                          <td className="px-2 py-2 text-xs">{inv.invoice_date}</td>
                          <td className="px-2 py-2 text-xs text-right">PKR {Number(inv.invoice_amount).toLocaleString()}</td>
                          <td className="px-2 py-2 text-xs text-right text-success-700">PKR {Number(inv.amount_received).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {detailTab === "documents" && (
              <div className="space-y-3">
                {contractError && (
                  <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5" />
                    <div className="flex-1">{contractError}</div>
                    <button onClick={() => setContractError(null)}>
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
                <div className="border border-slate-200 rounded-md p-3">
                  <div className="text-sm text-slate-900 mb-1">Master contract document</div>
                  {detailRow.contract_drive_view_url ? (
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <a
                        href={detailRow.contract_drive_view_url}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700"
                      >
                        <FileText className="w-4 h-4" />
                        {detailRow.contract_file_name ?? "View contract"}
                      </a>
                      <div className="flex gap-1">
                        <label className="cursor-pointer px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50">
                          {contractUploadingId === detailRow.id ? "Uploading…" : "Replace"}
                          <input
                            type="file"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) uploadContract(detailRow, f);
                              e.target.value = "";
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => removeContract(detailRow)}
                          className="px-2 py-1 text-xs border border-danger-200 text-danger-600 rounded hover:bg-danger-50"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <label className="cursor-pointer inline-flex items-center gap-2 px-3 py-2 text-sm border border-dashed border-slate-300 rounded hover:bg-slate-50">
                      <Upload className="w-4 h-4" />
                      {contractUploadingId === detailRow.id ? "Uploading…" : "Upload contract document"}
                      <input
                        type="file"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) uploadContract(detailRow, f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-slate-900">{children}</div>
    </div>
  );
}
