import { useEffect, useState } from "react";
import { Plus, Loader2, AlertCircle, X, Trash2, FileText, Upload } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import { useAuth } from "../lib/auth";
import { formatDate } from "../lib/date";
import {
  supabase,
  CONTRACT_TYPE_LABEL,
  CONTRACT_STATUS_LABEL,
  CONTRACT_LINE_CATEGORY_LABEL,
  CONTRACT_LINE_CATEGORY_ORDER,
  ADDENDUM_CHANGE_TYPE_LABEL,
  ADDENDUM_SOURCE_LABEL,
  contractLinesValue,
  contractLinesCommitted,
  type Client,
  type Contract,
  type ContractLine,
  type ContractLineCategory,
  type ContractAddendum,
  type AddendumChangeType,
  type AddendumSource,
  type ContractStatus,
  type ContractType,
} from "../lib/supabase";

type ContractFormState = {
  client_id: string;
  contract_type: ContractType;
  start_date: string;
  end_date: string;
  // Main's per-shift guard counts — kept as informational SHIFT DETAIL only
  // (the guard count/rate now lives in Contract Lines below).
  day_guards: string;
  night_guards: string;
  evening_guards: string;
  allowed_leaves_per_month: string;
  eobi_deduction: boolean;
  eobi_amount: string;
  annual_escalation_pct: string;
  renewal_terms: string;
  status: ContractStatus;
};

// One editable row in the Contract Lines table.
type LineDraft = {
  id?: string; // existing contract_lines.id — absent for new rows
  category: ContractLineCategory;
  label: string;
  location: string;
  committed_count: string;
  unit_rate: string;
  taxable: boolean;
};

const blankForm = (clientId: string): ContractFormState => ({
  client_id: clientId,
  contract_type: "services",
  start_date: new Date().toISOString().slice(0, 10),
  end_date: "",
  day_guards: "0",
  night_guards: "0",
  evening_guards: "0",
  allowed_leaves_per_month: "",
  eobi_deduction: false,
  eobi_amount: "",
  annual_escalation_pct: "",
  renewal_terms: "",
  status: "active",
});

const fromContract = (c: Contract): ContractFormState => ({
  client_id: c.client_id,
  contract_type: c.contract_type,
  start_date: c.start_date,
  end_date: c.end_date ?? "",
  day_guards: String(c.day_guards ?? 0),
  night_guards: String(c.night_guards ?? 0),
  evening_guards: String(c.evening_guards ?? 0),
  allowed_leaves_per_month: c.allowed_leaves_per_month != null ? String(c.allowed_leaves_per_month) : "",
  eobi_deduction: c.eobi_deduction,
  eobi_amount: c.eobi_amount != null ? String(c.eobi_amount) : "",
  annual_escalation_pct: c.annual_escalation_pct != null ? String(c.annual_escalation_pct) : "",
  renewal_terms: c.renewal_terms ?? "",
  status: c.status,
});

// A blank draft row for a category.
const blankLine = (category: ContractLineCategory): LineDraft => ({
  category,
  label: CONTRACT_LINE_CATEGORY_LABEL[category],
  location: "",
  committed_count: "0",
  unit_rate: "0",
  taxable: true,
});

// Seed the standard category rows, overlaying any existing lines for that
// category. Extra existing lines (duplicate categories, custom rows) are
// appended after the defaults so nothing is lost on edit.
const seedLines = (existing: ContractLine[]): LineDraft[] => {
  const rows: LineDraft[] = [];
  const usedIds = new Set<string>();
  for (const cat of CONTRACT_LINE_CATEGORY_ORDER) {
    const match = existing.find((l) => l.category === cat && !usedIds.has(l.id));
    if (match) {
      usedIds.add(match.id);
      rows.push({
        id: match.id,
        category: match.category,
        label: match.label ?? CONTRACT_LINE_CATEGORY_LABEL[match.category],
        location: match.location ?? "",
        committed_count: String(match.committed_count),
        unit_rate: String(match.unit_rate),
        taxable: match.taxable,
      });
    } else {
      rows.push(blankLine(cat));
    }
  }
  for (const l of existing) {
    if (usedIds.has(l.id)) continue;
    rows.push({
      id: l.id,
      category: l.category,
      label: l.label ?? CONTRACT_LINE_CATEGORY_LABEL[l.category],
      location: l.location ?? "",
      committed_count: String(l.committed_count),
      unit_rate: String(l.unit_rate),
      taxable: l.taxable,
    });
  }
  return rows;
};

const num = (s: string) => Number(s) || 0;
const isMeaningful = (l: LineDraft) => num(l.committed_count) > 0 || num(l.unit_rate) > 0;

// New-addendum form (Edit Contract only).
type AddendumForm = {
  target: string; // a contract_lines.id, or "__new__" for a brand-new line
  category: ContractLineCategory; // used when target = "__new__"
  change_type: AddendumChangeType;
  count_delta: string;
  new_rate: string;
  effective_from: string;
  source: AddendumSource;
  reference: string;
};

const blankAddendum = (): AddendumForm => ({
  target: "__new__",
  category: "GUARD",
  change_type: "ADD_HEADCOUNT",
  count_delta: "0",
  new_rate: "",
  effective_from: new Date().toISOString().slice(0, 10),
  source: "SIGNED_CONTRACT",
  reference: "",
});

/**
 * Shared add/edit contract modal (Phase 1). Used from both the Clients page
 * (client fixed) and the Contracts page (client picked from `clients`). The
 * per-category "Guards per Shift" / "Rates per Guard Type" fields are replaced
 * by a single unified Contract Lines table: one row per category with a
 * committed count and a monthly rate. Contract value = Σ(count × rate).
 */
export default function ContractEditorModal({
  isOpen,
  clientId,
  clientName,
  clients,
  contract,
  enableDocument = true,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  /** Fixed client (Clients page). Omit and pass `clients` to show a picker. */
  clientId?: string;
  clientName?: string;
  /** When provided (Contracts page), a client picker is shown in add mode. */
  clients?: Client[];
  contract: Contract | null;
  /** Show the contract-document upload row. Default true. */
  enableDocument?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { profile, company } = useAuth();
  const [form, setForm] = useState<ContractFormState>(blankForm(clientId ?? ""));
  const [lines, setLines] = useState<LineDraft[]>(seedLines([]));
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [loadingLines, setLoadingLines] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Phase 2 — addendums (Edit Contract only).
  const [addendums, setAddendums] = useState<ContractAddendum[]>([]);
  const [addForm, setAddForm] = useState<AddendumForm>(blankAddendum());
  const [addFile, setAddFile] = useState<File | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);

  const loadAddendums = (contractId: string) =>
    supabase
      .from("contract_addendums")
      .select("*")
      .eq("contract_id", contractId)
      .order("effective_from", { ascending: false })
      .then(({ data }) => setAddendums((data ?? []) as ContractAddendum[]));

  useEffect(() => {
    if (!isOpen) return;
    setForm(contract ? fromContract(contract) : blankForm(clientId ?? ""));
    setPendingFile(null);
    setError(null);
    setAddForm(blankAddendum());
    setAddFile(null);
    setAddendums([]);
    // Load existing lines for edit; seed defaults for add.
    if (contract) {
      setLoadingLines(true);
      supabase
        .from("contract_lines")
        .select("*")
        .eq("contract_id", contract.id)
        .order("created_at", { ascending: true })
        .then(({ data, error: err }) => {
          if (err) setError(err.message);
          setLines(seedLines((data ?? []) as ContractLine[]));
          setLoadingLines(false);
        });
      loadAddendums(contract.id);
    } else {
      setLines(seedLines([]));
    }
  }, [isOpen, contract, clientId]);

  const totalCommitted = contractLinesCommitted(
    lines.map((l) => ({ committed_count: num(l.committed_count) })),
  );
  const totalValue = contractLinesValue(
    lines.map((l) => ({ committed_count: num(l.committed_count), unit_rate: num(l.unit_rate) })),
  );

  const updateLine = (idx: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const addLine = () => setLines((prev) => [...prev, blankLine("GUARD")]);
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));

  // Legacy scalar columns are still read by a few display spots; keep them in
  // sync with the lines so nothing downstream shows stale numbers.
  const legacyGuardRate = (() => {
    const guard = lines.find((l) => l.category === "GUARD" && isMeaningful(l));
    const firstMeaningful = lines.find((l) => isMeaningful(l));
    return num((guard ?? firstMeaningful)?.unit_rate ?? "0");
  })();

  const buildContractPayload = (effClientId: string) => ({
    client_id: effClientId,
    contract_type: form.contract_type,
    start_date: form.start_date,
    end_date: form.end_date || null,
    // number_of_guards/rate_per_guard_per_month kept in sync for legacy readers;
    // the source of truth is contract_lines. guard_rates is deprecated (0065) and
    // deliberately NOT written here.
    number_of_guards: totalCommitted,
    day_guards: Math.max(0, Math.floor(num(form.day_guards))),
    night_guards: Math.max(0, Math.floor(num(form.night_guards))),
    evening_guards: Math.max(0, Math.floor(num(form.evening_guards))),
    rate_per_guard_per_month: legacyGuardRate,
    allowed_leaves_per_month:
      form.allowed_leaves_per_month === "" ? null : Math.max(0, Math.floor(num(form.allowed_leaves_per_month))),
    eobi_deduction: form.eobi_deduction,
    eobi_amount: form.eobi_deduction && form.eobi_amount !== "" ? Number(form.eobi_amount) : null,
    annual_escalation_pct: form.annual_escalation_pct === "" ? null : Number(form.annual_escalation_pct),
    renewal_terms: form.renewal_terms.trim() || null,
    status: form.status,
  });

  // Reconcile the draft lines against what's stored: insert new meaningful
  // rows, update changed ones, delete rows that became empty.
  const persistLines = async (contractId: string, existingIds: string[]) => {
    const meaningful = lines.filter(isMeaningful);
    const keptIds = new Set(meaningful.map((l) => l.id).filter(Boolean) as string[]);

    const toInsert = meaningful
      .filter((l) => !l.id)
      .map((l) => ({
        contract_id: contractId,
        category: l.category,
        label: l.label.trim() || CONTRACT_LINE_CATEGORY_LABEL[l.category],
        location: l.location.trim() || null,
        committed_count: Math.max(0, Math.floor(num(l.committed_count))),
        unit_rate: Math.max(0, num(l.unit_rate)),
        taxable: l.taxable,
      }));
    if (toInsert.length) {
      const { error: insErr } = await supabase.from("contract_lines").insert(toInsert);
      if (insErr) throw insErr;
    }

    for (const l of meaningful.filter((x) => x.id)) {
      const { error: upErr } = await supabase
        .from("contract_lines")
        .update({
          category: l.category,
          label: l.label.trim() || CONTRACT_LINE_CATEGORY_LABEL[l.category],
          location: l.location.trim() || null,
          committed_count: Math.max(0, Math.floor(num(l.committed_count))),
          unit_rate: Math.max(0, num(l.unit_rate)),
          taxable: l.taxable,
        })
        .eq("id", l.id!);
      if (upErr) throw upErr;
    }

    const toDelete = existingIds.filter((id) => !keptIds.has(id));
    if (toDelete.length) {
      const { error: delErr } = await supabase.from("contract_lines").delete().in("id", toDelete);
      if (delErr) throw delErr;
    }
  };

  // Upload a file under the contract's Drive folder; returns Drive metadata.
  const uploadToDrive = async (contractId: string, contractCode: string, file: File) => {
    const effectiveCompanyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!effectiveCompanyId || !company?.name) throw new Error("Company not loaded — refresh and try again.");
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
    return json as { drive_file_id: string; drive_view_url: string; file_name?: string };
  };

  const deleteFromDrive = async (driveFileId: string) => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gdrive-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ drive_file_id: driveFileId }),
    });
  };

  const uploadDocument = async (contractId: string, contractCode: string, file: File, existingDriveFileId: string | null) => {
    const json = await uploadToDrive(contractId, contractCode, file);
    if (existingDriveFileId) await deleteFromDrive(existingDriveFileId);
    await supabase
      .from("contracts")
      .update({ drive_file_id: json.drive_file_id, drive_view_url: json.drive_view_url, contract_file_name: json.file_name ?? file.name })
      .eq("id", contractId);
  };

  const handleAddAddendum = async () => {
    if (!contract) return;
    setAddSubmitting(true);
    setError(null);
    try {
      const isNewLine = addForm.target === "__new__";
      const payload: Record<string, unknown> = {
        contract_id: contract.id,
        contract_line_id: isNewLine ? null : addForm.target,
        category: isNewLine ? addForm.category : null,
        change_type: addForm.change_type,
        count_delta: addForm.change_type === "RATE_CHANGE" ? 0 : Math.abs(Math.floor(num(addForm.count_delta))),
        new_rate: addForm.change_type === "RATE_CHANGE" && addForm.new_rate !== "" ? num(addForm.new_rate) : null,
        effective_from: addForm.effective_from,
        source: addForm.source,
        reference: addForm.reference.trim() || null,
      };
      const { data: ins, error: insErr } = await supabase
        .from("contract_addendums")
        .insert(payload)
        .select()
        .single();
      if (insErr) throw insErr;
      if (addFile) {
        const json = await uploadToDrive(contract.id, contract.contract_code, addFile);
        await supabase
          .from("contract_addendums")
          .update({
            drive_file_id: json.drive_file_id,
            drive_view_url: json.drive_view_url,
            reference_file_name: json.file_name ?? addFile.name,
          })
          .eq("id", (ins as ContractAddendum).id);
      }
      setAddForm(blankAddendum());
      setAddFile(null);
      await loadAddendums(contract.id);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setAddSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const effClientId = clientId ?? form.client_id;
    if (!effClientId) {
      setError("Select a client.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (contract) {
        const { error: upErr } = await supabase.from("contracts").update(buildContractPayload(effClientId)).eq("id", contract.id);
        if (upErr) throw upErr;
        const { data: existing } = await supabase.from("contract_lines").select("id").eq("contract_id", contract.id);
        await persistLines(contract.id, ((existing ?? []) as { id: string }[]).map((r) => r.id));
        if (pendingFile) await uploadDocument(contract.id, contract.contract_code, pendingFile, contract.drive_file_id);
      } else {
        const { data, error: insErr } = await supabase
          .from("contracts")
          .insert(buildContractPayload(effClientId))
          .select()
          .single();
        if (insErr) throw insErr;
        const inserted = data as Contract;
        await persistLines(inserted.id, []);
        if (pendingFile) await uploadDocument(inserted.id, inserted.contract_code, pendingFile, null);
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const showClientPicker = !clientId && !!clients && !contract;
  const title = contract
    ? `Edit ${contract.contract_code}`
    : `Add Contract${clientName ? ` — ${clientName}` : ""}`;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="lg">
      <form className="space-y-3" onSubmit={handleSubmit}>
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
          {showClientPicker && (
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Client *</label>
              <select
                required
                value={form.client_id}
                onChange={(e) => setForm({ ...form, client_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">— Select client —</option>
                {clients!.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.client_code})</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm text-slate-700 mb-1">Contract Type *</label>
            <select
              required
              value={form.contract_type}
              onChange={(e) => setForm({ ...form, contract_type: e.target.value as ContractType })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              {(["services", "guard_deployment"] as const).map((t) => (
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
        </div>

        {/* Shift detail — informational per-shift headcount. NOT the guard count
            (that lives in Contract Lines below). Kept from main's schema. */}
        <div className="border border-slate-200 rounded-md p-3">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm font-medium text-slate-700">Shift detail</span>
            <span className="text-[11px] text-slate-500">Informational only — guard count &amp; rate are set in Contract Lines below.</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Day guards</label>
              <input type="number" min="0" value={form.day_guards}
                onChange={(e) => setForm({ ...form, day_guards: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-right" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Night guards</label>
              <input type="number" min="0" value={form.night_guards}
                onChange={(e) => setForm({ ...form, night_guards: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-right" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Evening guards</label>
              <input type="number" min="0" value={form.evening_guards}
                onChange={(e) => setForm({ ...form, evening_guards: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-right" />
            </div>
          </div>
        </div>

        {/* Contract Lines — per-category committed count + monthly rate */}
        <div className="border border-slate-200 rounded-md overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
            <span className="text-sm font-medium text-slate-700">Contract Lines</span>
            <Button type="button" variant="secondary" size="sm" onClick={addLine}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add Line
            </Button>
          </div>
          {loadingLines ? (
            <div className="px-3 py-6 text-center text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" /> Loading lines…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-500 uppercase border-b border-slate-200">
                    <th className="text-left px-3 py-2">Category</th>
                    <th className="text-left px-3 py-2">Location</th>
                    <th className="text-right px-3 py-2 w-28">Committed</th>
                    <th className="text-right px-3 py-2 w-36">Rate / month</th>
                    <th className="text-right px-3 py-2 w-32">Line value</th>
                    <th className="px-2 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lines.map((l, idx) => (
                    <tr key={l.id ?? `new-${idx}`}>
                      <td className="px-3 py-1.5">
                        <select
                          value={l.category}
                          onChange={(e) => {
                            const cat = e.target.value as ContractLineCategory;
                            updateLine(idx, {
                              category: cat,
                              // Keep a custom label if the user set one, else follow the category.
                              label:
                                l.label === CONTRACT_LINE_CATEGORY_LABEL[l.category]
                                  ? CONTRACT_LINE_CATEGORY_LABEL[cat]
                                  : l.label,
                            });
                          }}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                        >
                          {CONTRACT_LINE_CATEGORY_ORDER.map((cat) => (
                            <option key={cat} value={cat}>{CONTRACT_LINE_CATEGORY_LABEL[cat]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="text"
                          value={l.location}
                          onChange={(e) => updateLine(idx, { location: e.target.value })}
                          placeholder="Optional"
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="number"
                          min="0"
                          value={l.committed_count}
                          onChange={(e) => updateLine(idx, { committed_count: e.target.value })}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm text-right"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={l.unit_rate}
                          onChange={(e) => updateLine(idx, { unit_rate: e.target.value })}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm text-right"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right text-slate-600 tabular-nums">
                        {(num(l.committed_count) * num(l.unit_rate)).toLocaleString()}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => removeLine(idx)}
                          className="p-1 rounded text-danger-600 hover:bg-danger-50"
                          title="Remove line"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50 font-medium text-slate-800">
                    <td className="px-3 py-2" colSpan={2}>Total</td>
                    <td className="px-3 py-2 text-right tabular-nums">{totalCommitted}</td>
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2 text-right tabular-nums">PKR {totalValue.toLocaleString()}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <p className="px-3 py-2 text-[11px] text-slate-500">
            Contract value = Σ (committed count × rate). Only rows with a count or rate are saved.
          </p>
        </div>

        {/* Addendums — only for existing contracts (can't addend what isn't created) */}
        {contract && (
          <div className="border border-slate-200 rounded-md overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
              <span className="text-sm font-medium text-slate-700">Addendums</span>
              <span className="text-[11px] text-slate-500 ml-2">
                Dated changes to committed count / rate — the contract's base lines are never altered.
              </span>
            </div>

            {addendums.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-500 uppercase border-b border-slate-200">
                      <th className="text-left px-3 py-2">Effective</th>
                      <th className="text-left px-3 py-2">Change</th>
                      <th className="text-left px-3 py-2">Category / Line</th>
                      <th className="text-left px-3 py-2">Source</th>
                      <th className="text-left px-3 py-2">Reference</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {addendums.map((a) => {
                      const lineCat = a.contract_line_id
                        ? lines.find((l) => l.id === a.contract_line_id)?.category
                        : a.category;
                      return (
                        <tr key={a.id}>
                          <td className="px-3 py-1.5 text-slate-700">{formatDate(a.effective_from)}</td>
                          <td className="px-3 py-1.5 text-slate-700">
                            {ADDENDUM_CHANGE_TYPE_LABEL[a.change_type]}
                            {a.change_type === "RATE_CHANGE"
                              ? a.new_rate != null && ` → PKR ${Number(a.new_rate).toLocaleString()}`
                              : ` (${a.change_type === "REDUCE_HEADCOUNT" ? "−" : "+"}${a.count_delta})`}
                          </td>
                          <td className="px-3 py-1.5 text-slate-600">
                            {lineCat ? CONTRACT_LINE_CATEGORY_LABEL[lineCat] : "—"}
                            {!a.contract_line_id && <span className="text-[10px] text-slate-400 ml-1">(new line)</span>}
                          </td>
                          <td className="px-3 py-1.5 text-slate-600">{ADDENDUM_SOURCE_LABEL[a.source]}</td>
                          <td className="px-3 py-1.5">
                            {a.drive_view_url ? (
                              <a
                                href={a.drive_view_url}
                                target="_blank"
                                rel="noopener"
                                className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
                              >
                                <FileText className="w-3 h-3" />
                                {a.reference_file_name ?? "Document"}
                              </a>
                            ) : (
                              <span className="text-xs text-slate-500">{a.reference ?? "—"}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Add-addendum form */}
            <div className="p-3 border-t border-slate-200 bg-slate-50/50 grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] text-slate-600 mb-1">Applies to</label>
                <select
                  value={addForm.target}
                  onChange={(e) => setAddForm({ ...addForm, target: e.target.value })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                >
                  <option value="__new__">New line…</option>
                  {lines
                    .filter((l) => l.id)
                    .map((l) => (
                      <option key={l.id} value={l.id!}>
                        {CONTRACT_LINE_CATEGORY_LABEL[l.category]}
                        {l.location ? ` — ${l.location}` : ""}
                      </option>
                    ))}
                </select>
              </div>
              {addForm.target === "__new__" && (
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">New line category</label>
                  <select
                    value={addForm.category}
                    onChange={(e) => setAddForm({ ...addForm, category: e.target.value as ContractLineCategory })}
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                  >
                    {CONTRACT_LINE_CATEGORY_ORDER.map((cat) => (
                      <option key={cat} value={cat}>{CONTRACT_LINE_CATEGORY_LABEL[cat]}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-[11px] text-slate-600 mb-1">Change type</label>
                <select
                  value={addForm.change_type}
                  onChange={(e) => setAddForm({ ...addForm, change_type: e.target.value as AddendumChangeType })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                >
                  {(["ADD_HEADCOUNT", "REDUCE_HEADCOUNT", "RATE_CHANGE"] as const).map((t) => (
                    <option key={t} value={t}>{ADDENDUM_CHANGE_TYPE_LABEL[t]}</option>
                  ))}
                </select>
              </div>
              {addForm.change_type === "RATE_CHANGE" ? (
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">New rate / month</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={addForm.new_rate}
                    onChange={(e) => setAddForm({ ...addForm, new_rate: e.target.value })}
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm text-right"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">Headcount delta</label>
                  <input
                    type="number"
                    min="0"
                    value={addForm.count_delta}
                    onChange={(e) => setAddForm({ ...addForm, count_delta: e.target.value })}
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm text-right"
                  />
                </div>
              )}
              <div>
                <label className="block text-[11px] text-slate-600 mb-1">Effective from</label>
                <input
                  type="date"
                  value={addForm.effective_from}
                  onChange={(e) => setAddForm({ ...addForm, effective_from: e.target.value })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-600 mb-1">Source</label>
                <select
                  value={addForm.source}
                  onChange={(e) => setAddForm({ ...addForm, source: e.target.value as AddendumSource })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                >
                  {(["SIGNED_CONTRACT", "EMAIL", "VERBAL", "OTHER"] as const).map((s) => (
                    <option key={s} value={s}>{ADDENDUM_SOURCE_LABEL[s]}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-[11px] text-slate-600 mb-1">Reference (text)</label>
                <input
                  type="text"
                  value={addForm.reference}
                  onChange={(e) => setAddForm({ ...addForm, reference: e.target.value })}
                  placeholder="e.g. Email dated 2026-05-01, or note"
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                />
              </div>
              <div className="col-span-2 flex items-center justify-between gap-2">
                <label className="cursor-pointer inline-flex items-center gap-2 px-3 py-1.5 text-xs border border-dashed border-slate-300 rounded hover:bg-slate-50">
                  <Upload className="w-3.5 h-3.5" />
                  {addFile ? addFile.name : "Attach reference document (optional)"}
                  <input
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setAddFile(f);
                      e.target.value = "";
                    }}
                  />
                </label>
                <Button type="button" variant="secondary" size="sm" disabled={addSubmitting} onClick={handleAddAddendum}>
                  {addSubmitting ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
                  Add Addendum
                </Button>
              </div>
            </div>
          </div>
        )}

        <div>
          <label className="block text-sm text-slate-700 mb-1">Renewal Terms</label>
          <textarea
            value={form.renewal_terms}
            onChange={(e) => setForm({ ...form, renewal_terms: e.target.value })}
            rows={2}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            placeholder="Free text for special clauses"
          />
        </div>

        {enableDocument && (
          <div>
            <label className="block text-sm text-slate-700 mb-1">Contract Document</label>
            {contract?.drive_view_url && !pendingFile ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2 border border-slate-200 rounded-md">
                <a
                  href={contract.drive_view_url}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex items-center gap-1 text-sm text-brand-600 hover:text-brand-700"
                >
                  <FileText className="w-4 h-4" />
                  {contract.contract_file_name ?? "Current document"}
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
        )}

        <div className="sticky bottom-0 -mx-6 -mb-6 px-6 py-3 bg-white border-t border-slate-200 flex items-center gap-2">
          <Button variant="primary" size="md" disabled={submitting} className="flex-1">
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
            {submitting ? "Saving…" : contract ? "Save Changes" : "Add Contract"}
          </Button>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
