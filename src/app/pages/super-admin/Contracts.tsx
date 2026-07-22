import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Search,
  Eye,
  Pencil,
  Loader2,
  AlertCircle,
  X,
  FileText,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import ContractEditorModal from "../../components/ContractEditorModal";
import ContractViewModal from "../../components/ContractViewModal";
import ContractStatusBadge from "../../components/ContractStatusBadge";
import { formatDate } from "../../lib/date";
import {
  supabase,
  CONTRACT_TYPE_LABEL,
  CONTRACT_STATUS_LABEL,
  CONTRACT_LINE_CATEGORY_LABEL,
  CONTRACT_LINE_CATEGORY_ORDER,
  contractLinesValue,
  effectiveCommittedByCategory,
  activeCountByCategory,
  type Branch,
  type Client,
  type Contract,
  type ContractLine,
  type ContractAddendum,
  type ContractLineCategory,
  type ContractStatus,
  type Employee,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { useRegion } from "../../lib/region";

type ContractRow = Contract & { client_name: string; client_code: string };
type EmployeeAssignment = Pick<
  Employee,
  "status" | "contract_id" | "contract_line_id" | "assignment_effective_from" | "assignment_effective_to"
>;

const today = () => new Date().toISOString().slice(0, 10);

export default function Contracts() {
  const { profile, company } = useAuth();
  const { regionId } = useRegion();
  const [rows, setRows] = useState<ContractRow[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [linesByContract, setLinesByContract] = useState<Map<string, ContractLine[]>>(new Map());
  const [addendumsByContract, setAddendumsByContract] = useState<Map<string, ContractAddendum[]>>(new Map());
  const [employeesByContract, setEmployeesByContract] = useState<Map<string, EmployeeAssignment[]>>(new Map());
  const [lineCategoryById, setLineCategoryById] = useState<Map<string, ContractLineCategory>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ContractStatus>("all");
  const [clientFilter, setClientFilter] = useState("all");

  const [addOpen, setAddOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<ContractRow | null>(null);
  const [viewingRow, setViewingRow] = useState<ContractRow | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [contractsRes, clientsRes, empRes, linesRes, addendumsRes, branchesRes] = await Promise.all([
      supabase.from("contracts").select("*").order("start_date", { ascending: false }),
      supabase.from("clients").select("*").order("name"),
      supabase
        .from("employees")
        .select("status, contract_id, contract_line_id, assignment_effective_from, assignment_effective_to"),
      supabase.from("contract_lines").select("*"),
      supabase.from("contract_addendums").select("*"),
      supabase.from("branches").select("*"),
    ]);
    setBranches((branchesRes.data ?? []) as Branch[]);
    const cs = (clientsRes.data ?? []) as Client[];
    const byId = new Map(cs.map((c) => [c.id, c]));
    const list = ((contractsRes.data ?? []) as Contract[]).map<ContractRow>((c) => ({
      ...c,
      client_name: byId.get(c.client_id)?.name ?? "(deleted)",
      client_code: byId.get(c.client_id)?.client_code ?? "—",
    }));
    // Per-category committed counts/rates now live in contract_lines.
    const linesMap = new Map<string, ContractLine[]>();
    const catById = new Map<string, ContractLineCategory>();
    for (const l of (linesRes.data ?? []) as ContractLine[]) {
      if (!linesMap.has(l.contract_id)) linesMap.set(l.contract_id, []);
      linesMap.get(l.contract_id)!.push(l);
      catById.set(l.id, l.category);
    }
    setLinesByContract(linesMap);
    setLineCategoryById(catById);
    const addMap = new Map<string, ContractAddendum[]>();
    for (const a of (addendumsRes.data ?? []) as ContractAddendum[]) {
      if (!addMap.has(a.contract_id)) addMap.set(a.contract_id, []);
      addMap.get(a.contract_id)!.push(a);
    }
    setAddendumsByContract(addMap);
    // Per-contract employee assignments — drive per-category active counts.
    const empMap = new Map<string, EmployeeAssignment[]>();
    for (const e of (empRes.data ?? []) as EmployeeAssignment[]) {
      if (!e.contract_id) continue;
      if (!empMap.has(e.contract_id)) empMap.set(e.contract_id, []);
      empMap.get(e.contract_id)!.push(e);
    }
    setEmployeesByContract(empMap);
    setRows(list);
    setClients(cs);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  // Contracts carry no branch_id of their own; a contract's home region is its
  // client's region (spec §1 inheritance). Filter by the parent client's
  // branch_id so the global region selector scopes this page too.
  const clientBranchById = useMemo(
    () => new Map(clients.map((c) => [c.id, c.branch_id ?? null])),
    [clients],
  );

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (regionId && clientBranchById.get(r.client_id) !== regionId) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (clientFilter !== "all" && r.client_id !== clientFilter) return false;
      if (q && !r.client_name.toLowerCase().includes(q) && !r.contract_code.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, statusFilter, clientFilter, regionId, clientBranchById]);

  const uploadDocument = async (
    contractId: string,
    contractCode: string,
    file: File,
    existingDriveFileId: string | null,
  ) => {
    const effectiveCompanyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
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
    const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gdrive-upload`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: fd,
    });
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

  // §23 contract lock: contracts can never be deleted once created. Changes go
  // through addendums (Edit modal). The Delete action was removed from the list.

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

  return (
    <>
      <Header
        title="Contracts"
        subtitle="One client can have multiple contracts — each with per-category committed headcount and rates"
        actions={
          <Button variant="primary" size="md" onClick={() => setAddOpen(true)}>
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
          <ThemedSelect
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="all">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </ThemedSelect>
          <ThemedSelect
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | ContractStatus)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="all">All statuses</option>
            {(["active", "expired", "terminated", "draft"] as const).map((s) => (
              <option key={s} value={s}>{CONTRACT_STATUS_LABEL[s]}</option>
            ))}
          </ThemedSelect>
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
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Committed by category</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Guards (active/allotted)</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Value/mo</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Status</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Document</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading && (
                  <tr>
                    <td colSpan={10} className="px-4 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-10 text-center text-slate-500 text-sm">
                      No contracts match the current filters.
                    </td>
                  </tr>
                )}
                {!loading && filteredRows.map((row) => {
                  const dleft = daysUntilEnd(row.end_date);
                  const endingSoon = dleft != null && dleft <= 90 && dleft >= 0;
                  const lines = linesByContract.get(row.id) ?? [];
                  const addendums = addendumsByContract.get(row.id) ?? [];
                  const contractEmps = employeesByContract.get(row.id) ?? [];
                  // Effective per-category committed = base lines + addendums as of today.
                  const committedByCat = effectiveCommittedByCategory(lines, addendums, today());
                  // Per-category ACTIVE from real contract-line assignments (Phase 4).
                  const activeByCat = activeCountByCategory(contractEmps, lineCategoryById, today());
                  let totalCommitted = 0;
                  for (const n of committedByCat.values()) totalCommitted += n;
                  let activeGuards = 0;
                  for (const n of activeByCat.values()) activeGuards += n;
                  const valuePerMonth = contractLinesValue(lines);
                  // Exceeded when any category's active exceeds its committed.
                  const overStaffed = [...activeByCat.entries()].some(
                    ([cat, n]) => n > (committedByCat.get(cat) ?? 0),
                  );
                  return (
                    <tr key={row.id} className={`hover:bg-slate-50 transition-colors ${overStaffed ? "bg-danger-50/40" : ""}`}>
                      <td className="px-4 py-3 text-xs font-mono text-slate-900">{row.contract_code}</td>
                      <td className="px-4 py-3 text-sm text-slate-900">
                        <div>{row.client_name}</div>
                        <div className="text-xs text-slate-500 font-mono">{row.client_code}</div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{CONTRACT_TYPE_LABEL[row.contract_type]}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">
                        <div>{formatDate(row.start_date)}</div>
                        {row.is_infinite ? (
                          // No end_date, so it can never read as "ending soon" — say why.
                          <div className="text-xs text-slate-500">
                            → No end date
                            {row.notice_period_days != null && ` (${row.notice_period_days}d notice)`}
                          </div>
                        ) : (
                          row.end_date && (
                            <div className={endingSoon ? "text-warning-700 text-xs" : "text-xs text-slate-500"}>
                              → {formatDate(row.end_date)}
                              {endingSoon && ` (${dleft}d)`}
                            </div>
                          )
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">
                        {committedByCat.size === 0 ? (
                          <span className="text-slate-400 text-xs">No lines</span>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {CONTRACT_LINE_CATEGORY_ORDER.filter((cat) => committedByCat.has(cat)).map((cat) => {
                              const committed = committedByCat.get(cat) ?? 0;
                              const active = activeByCat.get(cat) ?? 0;
                              const over = active > committed;
                              return (
                                <span key={cat} className="text-xs">
                                  <span className="text-slate-500">{CONTRACT_LINE_CATEGORY_LABEL[cat]}:</span>{" "}
                                  <span className={over ? "text-danger-700 font-medium" : "text-slate-900 font-medium"}>
                                    {active}/{committed}
                                  </span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-right">
                        <span className={overStaffed ? "text-danger-700 font-medium" : "text-slate-900"}>
                          {activeGuards} / {totalCommitted}
                        </span>
                        {overStaffed && (
                          <div className="text-[10px] text-danger-600">over by {activeGuards - totalCommitted}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-slate-900">
                        PKR {valuePerMonth.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <div className="flex flex-col items-start gap-1">
                          <ContractStatusBadge status={row.status} />
                          {overStaffed && (
                            <span className="inline-block px-2 py-0.5 rounded-md text-xs bg-danger-50 text-danger-700 border border-danger-200">
                              Guards exceeded
                            </span>
                          )}
                        </div>
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
                            onClick={() => setViewingRow(row)}
                            className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                            title="View"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingRow(row)}
                            className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                            title="Edit"
                          >
                            <Pencil className="w-4 h-4" />
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

      {/* Add — client picked inside the modal */}
      <ContractEditorModal
        isOpen={addOpen}
        clients={clients}
        contract={null}
        onClose={() => setAddOpen(false)}
        onSaved={() => { setAddOpen(false); loadAll(); }}
      />

      {/* Edit — client fixed to the row's client */}
      {editingRow && (
        <ContractEditorModal
          isOpen={editingRow !== null}
          clientId={editingRow.client_id}
          clientName={editingRow.client_name}
          contract={editingRow}
          onClose={() => setEditingRow(null)}
          onSaved={() => { setEditingRow(null); loadAll(); }}
        />
      )}

      {/* View — read-only overview */}
      {viewingRow && (
        <ContractViewModal
          isOpen={viewingRow !== null}
          contract={viewingRow}
          client={clients.find((c) => c.id === viewingRow.client_id) ?? null}
          branch={branches.find((b) => b.id === clients.find((c) => c.id === viewingRow.client_id)?.branch_id) ?? null}
          lines={linesByContract.get(viewingRow.id) ?? []}
          addendums={addendumsByContract.get(viewingRow.id) ?? []}
          employees={employeesByContract.get(viewingRow.id) ?? []}
          onClose={() => setViewingRow(null)}
        />
      )}
    </>
  );
}

