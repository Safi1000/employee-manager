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
import ContractEditorModal from "../../components/ContractEditorModal";
import { formatDate } from "../../lib/date";
import {
  supabase,
  PAKISTAN_INDUSTRIES,
  TAX_BASE_LABEL,
  TAX_DIRECTION_LABEL,
  CLIENT_BILLING_TYPE_LABEL,
  CLIENT_INVOICE_GROUP_LABEL,
  effectiveCommittedByCategory,
  assignmentActiveOn,
  type Client,
  type ContractLine,
  type ContractAddendum,
  type Employee,
  type ClientType,
  type ClientFilerStatus,
  type ClientBillingType,
  type ClientInvoiceGroup,
  type TaxLine,
  type TaxBase,
  type TaxDirection,
  type RemitAccount,
  type Branch,
  type Contract,
  type Invoice,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type ClientRow = Client & { employees_count: number; contracts_count: number };
type EmployeeAssignmentRow = Pick<
  Employee,
  "id" | "client_id" | "status" | "contract_id" | "contract_line_id" | "assignment_effective_from" | "assignment_effective_to"
>;

type ClientForm = {
  name: string;
  email: string;
  phone: string;
  industry: string;
  ntn: string;
  strn: string;
  filer_status: ClientFilerStatus | "";
  tax_profile: TaxLine[];
  billing_type: ClientBillingType;
  invoice_group: ClientInvoiceGroup;
  remit_accounts: RemitAccount[];
  client_type: ClientType;
  branch_id: string;
  billing_address: string;
  authorised_signatory: string;
  signatory_cnic: string;
  allowed_leaves_per_month: string;
  leave_carry_forward: boolean;
  leave_carry_start: string;
  eobi_enabled: boolean;
  eobi_amount: string;
  advance_payment: boolean;
  auto_invoice_enabled: boolean;
  auto_invoice_amount: string;
};

const emptyForm: ClientForm = {
  name: "",
  email: "",
  phone: "",
  industry: "",
  ntn: "",
  strn: "",
  filer_status: "",
  tax_profile: [],
  billing_type: "STANDARD",
  invoice_group: "FIXED",
  remit_accounts: [],
  client_type: "security_services",
  branch_id: "",
  billing_address: "",
  authorised_signatory: "",
  signatory_cnic: "",
  allowed_leaves_per_month: "0",
  leave_carry_forward: false,
  leave_carry_start: "",
  eobi_enabled: false,
  eobi_amount: "0",
  advance_payment: false,
  auto_invoice_enabled: false,
  auto_invoice_amount: "0",
};

const formatCnic = (raw: string): string => {
  const digits = raw.replace(/\D/g, "").slice(0, 13);
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
};

// Drop empty tax rows and coerce rate to a number.
const sanitizeTaxProfile = (rows: TaxLine[]): TaxLine[] =>
  rows
    .filter((t) => t.name.trim() !== "")
    .map((t) => ({
      name: t.name.trim(),
      rate: Math.max(0, Number(t.rate) || 0),
      base: t.base,
      direction: t.direction,
      ...(t.component ? { component: t.component.trim() } : {}),
    }));

// Drop empty remit rows; guarantee exactly one default when any exist.
const sanitizeRemitAccounts = (rows: RemitAccount[]): RemitAccount[] => {
  const cleaned = rows
    .filter((r) => r.account_title.trim() !== "" || r.account_number.trim() !== "")
    .map((r) => ({
      account_title: r.account_title.trim(),
      account_number: r.account_number.trim(),
      bank_name: r.bank_name.trim(),
      is_default: !!r.is_default,
    }));
  if (cleaned.length && !cleaned.some((r) => r.is_default)) cleaned[0].is_default = true;
  // Collapse to a single default (first wins) if the UI ever produced more.
  let seen = false;
  for (const r of cleaned) {
    if (r.is_default && !seen) seen = true;
    else r.is_default = false;
  }
  return cleaned;
};

const firstWithheldRate = (rows: TaxLine[]): number | null => {
  const w = rows.find((t) => t.direction === "WITHHELD" && Number(t.rate) > 0);
  return w ? Number(w.rate) : null;
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
  const [postedByClientId, setPostedByClientId] = useState<Map<string, number>>(new Map());
  // Phase 4: per-client committed slots vs active line assignments.
  const [committedByClientId, setCommittedByClientId] = useState<Map<string, number>>(new Map());
  const [activeAssignedByClientId, setActiveAssignedByClientId] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
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

  // Item 1: add/edit contracts directly from the Clients page.
  const [contractEditorOpen, setContractEditorOpen] = useState(false);
  const [editingContract, setEditingContract] = useState<Contract | null>(null);

  // Item 9: in-form prompt for the leave carry-forward roll-over choice.
  const [carryPromptOpen, setCarryPromptOpen] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [clientsRes, branchesRes, contractsRes, invoicesRes, employeesRes, rosterRes, linesRes, addendumsRes] = await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase
        .from("branches")
        .select("*")
        .order("is_head_office", { ascending: false })
        .order("name"),
      supabase.from("contracts").select("*").order("start_date", { ascending: false }),
      supabase.from("invoices").select("*").order("invoice_date", { ascending: false }),
      supabase
        .from("employees")
        .select("id, client_id, status, contract_id, contract_line_id, assignment_effective_from, assignment_effective_to"),
      supabase.from("roster_assignments").select("employee_id, client_id").eq("assignment_date", new Date().toISOString().slice(0, 10)),
      supabase.from("contract_lines").select("*"),
      supabase.from("contract_addendums").select("*"),
    ]);
    const emps = (employeesRes.data ?? []) as EmployeeAssignmentRow[];
    const cs = (contractsRes.data ?? []) as Contract[];
    const allLines = (linesRes.data ?? []) as ContractLine[];
    const allAddendums = (addendumsRes.data ?? []) as ContractAddendum[];
    const empByClient = new Map<string, number>();
    for (const e of emps) {
      if (!e.client_id) continue;
      if (e.status !== "Active") continue;
      empByClient.set(e.client_id, (empByClient.get(e.client_id) ?? 0) + 1);
    }
    // "Posted" guards per client = distinct employees rostered for the client TODAY
    // (future-dated assignments don't count). Compared against assigned employees
    // for the understaffed flag (item 17).
    const roster = (rosterRes.data ?? []) as { employee_id: string; client_id: string | null }[];
    const postedByClient = new Map<string, Set<string>>();
    for (const a of roster) {
      if (!a.client_id) continue;
      if (!postedByClient.has(a.client_id)) postedByClient.set(a.client_id, new Set());
      postedByClient.get(a.client_id)!.add(a.employee_id);
    }
    const postedCount = new Map<string, number>();
    for (const [cid, set] of postedByClient) postedCount.set(cid, set.size);
    setPostedByClientId(postedCount);
    const conByClient = new Map<string, number>();
    for (const c of cs) {
      if (c.status !== "active") continue;
      conByClient.set(c.client_id, (conByClient.get(c.client_id) ?? 0) + 1);
    }

    // Per-client committed slots (effective, as of today) across ACTIVE contracts,
    // and active line assignments — the per-category logic behind "Understaffed".
    const todayStr = new Date().toISOString().slice(0, 10);
    const linesByContract = new Map<string, ContractLine[]>();
    for (const l of allLines) {
      if (!linesByContract.has(l.contract_id)) linesByContract.set(l.contract_id, []);
      linesByContract.get(l.contract_id)!.push(l);
    }
    const addsByContract = new Map<string, ContractAddendum[]>();
    for (const a of allAddendums) {
      if (!addsByContract.has(a.contract_id)) addsByContract.set(a.contract_id, []);
      addsByContract.get(a.contract_id)!.push(a);
    }
    const committedByClient = new Map<string, number>();
    for (const c of cs) {
      if (c.status !== "active") continue;
      const committed = effectiveCommittedByCategory(
        linesByContract.get(c.id) ?? [],
        addsByContract.get(c.id) ?? [],
        todayStr,
      );
      let total = 0;
      for (const n of committed.values()) total += n;
      committedByClient.set(c.client_id, (committedByClient.get(c.client_id) ?? 0) + total);
    }
    setCommittedByClientId(committedByClient);
    const activeAssignedByClient = new Map<string, number>();
    for (const e of emps) {
      if (!e.client_id || !e.contract_line_id) continue;
      if (!assignmentActiveOn(e, todayStr)) continue;
      activeAssignedByClient.set(e.client_id, (activeAssignedByClient.get(e.client_id) ?? 0) + 1);
    }
    setActiveAssignedByClientId(activeAssignedByClient);
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

  // A client is Active when it has at least one contract that is currently valid:
  // status = active AND today within [start_date, end_date] (open-ended if no end).
  const activeClientIds = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const s = new Set<string>();
    for (const c of contracts) {
      if (
        c.status === "active" &&
        c.start_date <= today &&
        (c.end_date == null || c.end_date >= today)
      ) {
        s.add(c.client_id);
      }
    }
    return s;
  }, [contracts]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (branchFilter !== "all" && r.branch_id !== branchFilter) return false;
      if (industryFilter !== "all" && (r.industry ?? "") !== industryFilter) return false;
      if (statusFilter === "active" && !activeClientIds.has(r.id)) return false;
      if (statusFilter === "inactive" && activeClientIds.has(r.id)) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.client_code.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, branchFilter, statusFilter, industryFilter, activeClientIds]);

  const resetForm = () => {
    setForm(emptyForm);
    setExpanded({ basic: true, tax: false, billing: false, contract: false });
  };

  // Item 9: when carry-forward is switched on, let the user choose whether to
  // roll over employees' existing reserve or start accruing fresh from this month.
  const monthStart = (offsetMonths: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() + offsetMonths, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  };
  const onToggleCarry = (checked: boolean) => {
    if (!checked) {
      setForm((f) => ({ ...f, leave_carry_forward: false, leave_carry_start: "" }));
      return;
    }
    // Open the in-form prompt instead of a browser confirm; carry is only switched
    // on once the user picks a roll-over option.
    setCarryPromptOpen(true);
  };
  const applyCarryChoice = (rollover: boolean) => {
    setForm((f) => ({
      ...f,
      leave_carry_forward: true,
      leave_carry_start: rollover ? monthStart(-12) : monthStart(0),
    }));
    setCarryPromptOpen(false);
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
      tax_profile: Array.isArray(row.tax_profile) ? row.tax_profile : [],
      billing_type: row.billing_type ?? "STANDARD",
      invoice_group: row.invoice_group ?? "FIXED",
      remit_accounts: Array.isArray(row.remit_accounts) ? row.remit_accounts : [],
      client_type: row.client_type,
      branch_id: row.branch_id ?? "",
      billing_address: row.billing_address ?? "",
      authorised_signatory: row.authorised_signatory ?? "",
      signatory_cnic: row.signatory_cnic ?? "",
      allowed_leaves_per_month: String(row.allowed_leaves_per_month ?? 0),
      leave_carry_forward: !!row.leave_carry_forward,
      leave_carry_start: row.leave_carry_start ?? "",
      eobi_enabled: !!row.eobi_enabled,
      eobi_amount: String(row.eobi_amount ?? 0),
      advance_payment: !!row.advance_payment,
      auto_invoice_enabled: !!row.auto_invoice_enabled,
      auto_invoice_amount: String(row.auto_invoice_amount ?? 0),
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
    tax_profile: sanitizeTaxProfile(form.tax_profile),
    remit_accounts: sanitizeRemitAccounts(form.remit_accounts),
    billing_type: form.billing_type,
    invoice_group: form.invoice_group,
    // Keep the legacy single rate in sync = first WITHHELD tax (or null).
    withholding_tax_rate: firstWithheldRate(form.tax_profile),
    client_type: form.client_type,
    branch_id: form.branch_id || null,
    billing_address: form.billing_address.trim() || null,
    authorised_signatory: form.authorised_signatory.trim() || null,
    signatory_cnic: form.signatory_cnic.trim() || null,
    allowed_leaves_per_month: Math.max(0, Math.floor(Number(form.allowed_leaves_per_month) || 0)),
    leave_carry_forward: form.leave_carry_forward,
    leave_carry_start: form.leave_carry_forward ? (form.leave_carry_start || null) : null,
    eobi_enabled: form.eobi_enabled,
    eobi_amount: form.eobi_enabled ? Math.max(0, Number(form.eobi_amount) || 0) : 0,
    advance_payment: form.advance_payment,
    auto_invoice_enabled: form.auto_invoice_enabled,
    auto_invoice_amount: form.auto_invoice_enabled
      ? Math.max(0, Number(form.auto_invoice_amount) || 0)
      : 0,
    // Mirror the first WITHHELD tax into the legacy column so existing
    // auto-invoice logic on the clients table keeps producing the same WHT.
    auto_invoice_withholding: firstWithheldRate(form.tax_profile) ?? 0,
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
        </div>

        {/* Repeatable tax profile — replaces the single withholding rate */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-sm text-slate-700">Taxes</label>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  tax_profile: [
                    ...f.tax_profile,
                    { name: "", rate: 0, base: "WHOLE_INVOICE", direction: "WITHHELD" },
                  ],
                }))
              }
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> Add Tax
            </Button>
          </div>
          {form.tax_profile.length === 0 ? (
            <p className="text-[11px] text-slate-500">
              No taxes configured. Add withholding and/or sales taxes — each applies to every invoice per its base and direction.
            </p>
          ) : (
            <div className="space-y-2">
              {form.tax_profile.map((t, idx) => {
                const patch = (p: Partial<TaxLine>) =>
                  setForm((f) => ({
                    ...f,
                    tax_profile: f.tax_profile.map((x, i) => (i === idx ? { ...x, ...p } : x)),
                  }));
                return (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                    <input
                      type="text"
                      value={t.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      placeholder="Tax name (e.g. Sales Tax)"
                      className="col-span-4 px-2 py-1.5 border border-slate-200 rounded text-sm"
                    />
                    <div className="col-span-2 relative">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={t.rate}
                        onChange={(e) => patch({ rate: Number(e.target.value) })}
                        className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm text-right pr-5"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-400">%</span>
                    </div>
                    <select
                      value={t.base}
                      onChange={(e) => patch({ base: e.target.value as TaxBase })}
                      className="col-span-3 px-2 py-1.5 border border-slate-200 rounded text-sm"
                    >
                      {(["WHOLE_INVOICE", "SPECIFIC_COMPONENT", "COMPOUND"] as const).map((b) => (
                        <option key={b} value={b}>{TAX_BASE_LABEL[b]}</option>
                      ))}
                    </select>
                    <select
                      value={t.direction}
                      onChange={(e) => patch({ direction: e.target.value as TaxDirection })}
                      className="col-span-2 px-2 py-1.5 border border-slate-200 rounded text-sm"
                    >
                      {(["ADDED", "WITHHELD"] as const).map((d) => (
                        <option key={d} value={d}>{TAX_DIRECTION_LABEL[d]}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, tax_profile: f.tax_profile.filter((_, i) => i !== idx) }))}
                      className="col-span-1 p-1 rounded text-danger-600 hover:bg-danger-50 justify-self-center"
                      title="Remove tax"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    {t.base === "SPECIFIC_COMPONENT" && (
                      <input
                        type="text"
                        value={t.component ?? ""}
                        onChange={(e) => patch({ component: e.target.value })}
                        placeholder="Component (placeholder until SLA components exist)"
                        className="col-span-12 px-2 py-1.5 border border-slate-200 rounded text-sm"
                      />
                    )}
                  </div>
                );
              })}
              <p className="text-[10px] text-slate-500">
                Added taxes increase the invoice total; withheld taxes reduce Total Due (shown net of withholding).
              </p>
            </div>
          )}
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
          <div>
            <label className="block text-sm text-slate-700 mb-1">Billing Type</label>
            <select
              value={form.billing_type}
              onChange={(e) => setForm({ ...form, billing_type: e.target.value as ClientBillingType })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              {(["STANDARD", "SLA"] as const).map((b) => (
                <option key={b} value={b}>{CLIENT_BILLING_TYPE_LABEL[b]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Invoice Group</label>
            <select
              value={form.invoice_group}
              onChange={(e) => setForm({ ...form, invoice_group: e.target.value as ClientInvoiceGroup })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              {(["FIXED", "VARIABLE", "SLA"] as const).map((g) => (
                <option key={g} value={g}>{CLIENT_INVOICE_GROUP_LABEL[g]}</option>
              ))}
            </select>
            <p className="text-[10px] text-slate-500 mt-1">Buckets this client on the Invoices → Generate tab.</p>
          </div>
        </div>

        {/* Remit accounts — one marked default */}
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between">
            <label className="block text-sm text-slate-700">Remit Accounts</label>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  remit_accounts: [
                    ...f.remit_accounts,
                    { account_title: "", account_number: "", bank_name: "", is_default: f.remit_accounts.length === 0 },
                  ],
                }))
              }
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> Add Account
            </Button>
          </div>
          {form.remit_accounts.length === 0 ? (
            <p className="text-[11px] text-slate-500">No remit accounts yet. Invoices select which account to show from this list.</p>
          ) : (
            <div className="space-y-2">
              {form.remit_accounts.map((r, idx) => {
                const patch = (p: Partial<RemitAccount>) =>
                  setForm((f) => ({
                    ...f,
                    remit_accounts: f.remit_accounts.map((x, i) => (i === idx ? { ...x, ...p } : x)),
                  }));
                const makeDefault = () =>
                  setForm((f) => ({
                    ...f,
                    remit_accounts: f.remit_accounts.map((x, i) => ({ ...x, is_default: i === idx })),
                  }));
                return (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                    <input
                      type="text"
                      value={r.account_title}
                      onChange={(e) => patch({ account_title: e.target.value })}
                      placeholder="Account title"
                      className="col-span-3 px-2 py-1.5 border border-slate-200 rounded text-sm"
                    />
                    <input
                      type="text"
                      value={r.account_number}
                      onChange={(e) => patch({ account_number: e.target.value })}
                      placeholder="Account no. / IBAN"
                      className="col-span-4 px-2 py-1.5 border border-slate-200 rounded text-sm font-mono"
                    />
                    <input
                      type="text"
                      value={r.bank_name}
                      onChange={(e) => patch({ bank_name: e.target.value })}
                      placeholder="Bank"
                      className="col-span-3 px-2 py-1.5 border border-slate-200 rounded text-sm"
                    />
                    <label className="col-span-1 flex items-center justify-center" title="Default account">
                      <input type="radio" name="remit_default" checked={r.is_default} onChange={makeDefault} />
                    </label>
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, remit_accounts: f.remit_accounts.filter((_, i) => i !== idx) }))}
                      className="col-span-1 p-1 rounded text-danger-600 hover:bg-danger-50 justify-self-center"
                      title="Remove account"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
              <p className="text-[10px] text-slate-500">The selected radio marks the default remit account.</p>
            </div>
          )}
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
                onChange={(e) => onToggleCarry(e.target.checked)}
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

      <Section
        isOpen={!!expanded.autoInvoice}
        onToggle={() => setExpanded((prev) => ({ ...prev, autoInvoice: !prev.autoInvoice }))}
        title="Auto-Invoicing"
      >
        <p className="text-xs text-slate-500">
          When enabled, a monthly invoice is auto-issued on the 1st for the fixed amount below —
          but only while this client has an <span className="text-slate-700">active contract</span> covering
          that month. Timing follows the "Pays in advance" setting above (advance = current month, otherwise
          previous month in arrears). The client's withholding tax rate is applied automatically.
        </p>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.auto_invoice_enabled}
            onChange={(e) => setForm({ ...form, auto_invoice_enabled: e.target.checked })}
          />
          Enable monthly auto-invoicing
        </label>
        {form.auto_invoice_enabled && (
          <div>
            <label className="block text-sm text-slate-700 mb-1">Monthly Invoice Amount (PKR)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.auto_invoice_amount}
              onChange={(e) => setForm({ ...form, auto_invoice_amount: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              placeholder="e.g. 250000"
            />
            <p className="text-[10px] text-slate-500 mt-1">
              Flat amount billed each month. Withholding tax is added from the Tax Information section.
            </p>
          </div>
        )}
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
              { v: "inactive", label: "Inactive" },
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
                  const isActive = activeClientIds.has(row.id);
                  // Per-category slot logic (Phase 4): committed slots vs active
                  // line assignments across the client's active contracts.
                  const committed = committedByClientId.get(row.id) ?? 0;
                  const activeAssigned = activeAssignedByClientId.get(row.id) ?? 0;
                  const understaffed = committed > 0 && activeAssigned < committed;
                  return (
                    <tr key={row.id} className={`hover:bg-slate-50 transition-colors ${understaffed ? "bg-warning-50/40" : ""}`}>
                      <td className="px-4 py-3 text-sm">
                        <div className="text-slate-900">{row.name}</div>
                        <div className="text-xs text-slate-500 font-mono">{row.client_code}</div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{row.industry ?? "—"}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{branchName}</td>
                      <td className="px-4 py-3 text-sm text-right text-slate-900">{row.employees_count}</td>
                      <td className="px-4 py-3 text-sm text-right text-slate-900">{row.contracts_count}</td>
                      <td className="px-4 py-3 text-sm">
                        <div className="flex flex-col items-start gap-1">
                          {isActive ? (
                            <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-success-50 text-success-700 border border-success-200">
                              Active
                            </span>
                          ) : (
                            <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600 border border-slate-200">
                              Inactive
                            </span>
                          )}
                          {understaffed && (
                            <span
                              className="inline-block px-2 py-0.5 rounded-full text-xs bg-warning-50 text-warning-700 border border-warning-200"
                              title={`${activeAssigned} active line assignment(s) vs ${committed} committed slot(s)`}
                            >
                              Understaffed {activeAssigned}/{committed}
                            </span>
                          )}
                        </div>
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
                <div className="flex justify-end">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setEditingContract(null);
                      setContractEditorOpen(true);
                    }}
                  >
                    <Plus className="w-4 h-4 mr-1" /> Add Contract
                  </Button>
                </div>
                {contracts.filter((c) => c.client_id === detailRow.id).length === 0 ? (
                  <p className="text-sm text-slate-500">No contracts yet. Use “Add Contract” above.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left px-2 py-2 text-xs text-slate-500 uppercase">Code</th>
                        <th className="text-left px-2 py-2 text-xs text-slate-500 uppercase">Type</th>
                        <th className="text-left px-2 py-2 text-xs text-slate-500 uppercase">Period</th>
                        <th className="text-left px-2 py-2 text-xs text-slate-500 uppercase">Status</th>
                        <th className="text-right px-2 py-2 text-xs text-slate-500 uppercase">Guards</th>
                        <th className="text-right px-2 py-2 text-xs text-slate-500 uppercase">Rate</th>
                        <th className="text-right px-2 py-2 text-xs text-slate-500 uppercase">Edit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {contracts.filter((c) => c.client_id === detailRow.id).map((c) => (
                        <tr key={c.id}>
                          <td className="px-2 py-2 font-mono text-xs">{c.contract_code}</td>
                          <td className="px-2 py-2 text-xs">{c.contract_type}</td>
                          <td className="px-2 py-2 text-xs">{formatDate(c.start_date)}{c.end_date ? ` → ${formatDate(c.end_date)}` : ""}</td>
                          <td className="px-2 py-2 text-xs capitalize">{c.status}</td>
                          <td className="px-2 py-2 text-xs text-right">{c.number_of_guards}</td>
                          <td className="px-2 py-2 text-xs text-right">PKR {Number(c.rate_per_guard_per_month).toLocaleString()}</td>
                          <td className="px-2 py-2 text-xs text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingContract(c);
                                setContractEditorOpen(true);
                              }}
                              className="p-1 rounded text-slate-600 hover:bg-slate-100"
                              title="Edit contract"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                          </td>
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
                          <td className="px-2 py-2 text-xs">{formatDate(inv.invoice_date)}</td>
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

      {detailRow && (
        <ContractEditorModal
          isOpen={contractEditorOpen}
          clientId={detailRow.id}
          clientName={detailRow.name}
          contract={editingContract}
          onClose={() => setContractEditorOpen(false)}
          onSaved={loadAll}
        />
      )}

      {/* Item 9: leave carry-forward roll-over choice (in-form, not a browser popup) */}
      <Modal
        isOpen={carryPromptOpen}
        onClose={() => setCarryPromptOpen(false)}
        title="Carry forward unused leaves"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Roll over employees' existing leave reserve, or start accruing fresh from this month?
          </p>
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => applyCarryChoice(true)}
              className="w-full text-left px-4 py-3 rounded-md border border-slate-200 hover:border-brand-400 hover:bg-brand-50/40"
            >
              <div className="text-sm text-slate-900">Roll over existing reserve</div>
              <div className="text-xs text-slate-500">Include the reserve accrued over the last 12 months.</div>
            </button>
            <button
              type="button"
              onClick={() => applyCarryChoice(false)}
              className="w-full text-left px-4 py-3 rounded-md border border-slate-200 hover:border-brand-400 hover:bg-brand-50/40"
            >
              <div className="text-sm text-slate-900">Start fresh from this month</div>
              <div className="text-xs text-slate-500">No backlog — begin accruing carry from this month onward.</div>
            </button>
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={() => setCarryPromptOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
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
