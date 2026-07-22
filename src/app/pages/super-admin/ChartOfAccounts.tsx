import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  X,
  Search,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";
import {
  supabase,
  ACCOUNT_TYPE_LABEL,
  ACCOUNT_TYPE_ORDER,
  type ChartAccount,
  type AccountType,
  type AccountNormalSide,
  type JournalEntry,
  type JournalLine,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type Tab = "coa" | "tb" | "gl";

type GLRow = {
  entry_date: string;
  description: string | null;
  source_table: string | null;
  is_reversal: boolean;
  debit: number;
  credit: number;
};

const fmtPKR = (n: number) =>
  `PKR ${Math.round(n).toLocaleString()}`;

const todayISO = () => new Date().toISOString().slice(0, 10);
const monthStartISO = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};
const yearStartISO = () => `${new Date().getFullYear()}-01-01`;

export default function ChartOfAccounts() {
  const { profile } = useAuth();
  const isSuper = profile?.role === "super_admin" || profile?.role === "super_super_admin";

  const [tab, setTab] = useState<Tab>("coa");
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Period for TB / GL.
  const [periodStart, setPeriodStart] = useState<string>(yearStartISO());
  const [periodEnd, setPeriodEnd] = useState<string>(todayISO());

  // Journal-derived balances: Map<accountId, {debit, credit}>
  const [accountBalances, setAccountBalances] = useState<Map<string, { debit: number; credit: number }>>(new Map());
  // GL entries for a single account.
  const [glRows, setGlRows] = useState<GLRow[]>([]);
  const [txLoading, setTxLoading] = useState(false);

  // CoA form state
  const [addOpen, setAddOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<ChartAccount | null>(null);
  const [form, setForm] = useState({
    account_code: "",
    account_name: "",
    account_type: "expense" as AccountType,
    normal_side: "debit" as AccountNormalSide,
    parent_id: "",
    active: true,
  });
  const [submitting, setSubmitting] = useState(false);

  // Manual journal entry state
  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState({
    entry_date: todayISO(),
    description: "",
    debit_account_id: "",
    credit_account_id: "",
    amount: "",
  });
  const [manualSubmitting, setManualSubmitting] = useState(false);

  // GL drill-down
  const [glAccountId, setGlAccountId] = useState<string | null>(null);

  // Filters
  const [coaSearch, setCoaSearch] = useState("");
  const [tbHideZero, setTbHideZero] = useState(true);

  const loadAccounts = async () => {
    setLoading(true);
    const { data, error: cErr } = await supabase
      .from("chart_of_accounts")
      .select("*")
      .order("account_code");
    if (cErr) setError(cErr.message);
    setAccounts((data ?? []) as ChartAccount[]);
    setLoading(false);
  };

  useEffect(() => {
    loadAccounts();
  }, []);

  // Load aggregated balances from journal_lines for the TB.
  const loadBalances = async () => {
    setTxLoading(true);
    setError(null);
    // Join journal_lines → journal_entries to filter by date, then SUM per account.
    const { data, error: qErr } = await supabase
      .from("journal_lines")
      .select("account_id, debit, credit, journal_entry:journal_entry_id(entry_date)")
      .gte("journal_entry.entry_date", periodStart)
      .lte("journal_entry.entry_date", periodEnd);

    if (qErr) {
      setError(qErr.message);
      setTxLoading(false);
      return;
    }

    const map = new Map<string, { debit: number; credit: number }>();
    for (const row of (data ?? []) as unknown as { account_id: string; debit: number; credit: number; journal_entry: { entry_date: string } | null }[]) {
      if (!row.journal_entry) continue;
      const existing = map.get(row.account_id) ?? { debit: 0, credit: 0 };
      existing.debit += Number(row.debit);
      existing.credit += Number(row.credit);
      map.set(row.account_id, existing);
    }
    setAccountBalances(map);
    setTxLoading(false);
  };

  // Load GL entries for a specific account.
  const loadGL = async (accountId: string) => {
    setTxLoading(true);
    setError(null);
    const { data, error: qErr } = await supabase
      .from("journal_lines")
      .select("debit, credit, journal_entry:journal_entry_id(entry_date, description, source_table, is_reversal)")
      .eq("account_id", accountId)
      .gte("journal_entry.entry_date", periodStart)
      .lte("journal_entry.entry_date", periodEnd)
      .order("journal_entry(entry_date)", { ascending: true });

    if (qErr) {
      setError(qErr.message);
      setTxLoading(false);
      return;
    }

    const rows: GLRow[] = [];
    for (const r of (data ?? []) as unknown as { debit: number; credit: number; journal_entry: { entry_date: string; description: string | null; source_table: string | null; is_reversal: boolean } | null }[]) {
      if (!r.journal_entry) continue;
      rows.push({
        entry_date: r.journal_entry.entry_date,
        description: r.journal_entry.description,
        source_table: r.journal_entry.source_table,
        is_reversal: r.journal_entry.is_reversal,
        debit: Number(r.debit),
        credit: Number(r.credit),
      });
    }
    setGlRows(rows);
    setTxLoading(false);
  };

  useEffect(() => {
    if (tab === "tb") loadBalances();
    if (tab === "gl" && glAccountId) loadGL(glAccountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, periodStart, periodEnd, glAccountId]);

  const filteredAccounts = useMemo(() => {
    const q = coaSearch.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(
      (a) =>
        a.account_code.toLowerCase().includes(q) ||
        a.account_name.toLowerCase().includes(q),
    );
  }, [accounts, coaSearch]);

  const accountsByType = useMemo(() => {
    const m = new Map<AccountType, ChartAccount[]>();
    for (const t of ACCOUNT_TYPE_ORDER) m.set(t, []);
    for (const a of filteredAccounts) m.get(a.account_type)!.push(a);
    return m;
  }, [filteredAccounts]);

  // TB rows: one per active account with nonzero balance.
  const tbRows = useMemo(() => {
    return accounts
      .filter((a) => a.active)
      .map((a) => {
        const bal = accountBalances.get(a.id) ?? { debit: 0, credit: 0 };
        return { account: a, debit: bal.debit, credit: bal.credit };
      })
      .filter((r) => !tbHideZero || r.debit !== 0 || r.credit !== 0)
      .sort((a, b) => a.account.account_code.localeCompare(b.account.account_code));
  }, [accounts, accountBalances, tbHideZero]);

  const tbTotals = useMemo(() => {
    let d = 0;
    let c = 0;
    for (const r of tbRows) { d += r.debit; c += r.credit; }
    return { d, c };
  }, [tbRows]);

  // GL running balance.
  const glRunning = useMemo(() => {
    if (!glAccountId) return [] as { row: GLRow; running: number }[];
    const acct = accounts.find((a) => a.id === glAccountId);
    if (!acct) return [];
    let r = 0;
    return glRows.map((row) => {
      const delta = acct.normal_side === "debit" ? row.debit - row.credit : row.credit - row.debit;
      r += delta;
      return { row, running: r };
    });
  }, [glAccountId, glRows, accounts]);

  // -- CoA CRUD --
  const resetForm = () => {
    setForm({ account_code: "", account_name: "", account_type: "expense", normal_side: "debit", parent_id: "", active: true });
  };

  const openEdit = (a: ChartAccount) => {
    setEditingRow(a);
    setForm({
      account_code: a.account_code,
      account_name: a.account_name,
      account_type: a.account_type,
      normal_side: a.normal_side,
      parent_id: a.parent_id ?? "",
      active: a.active,
    });
    setAddOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const payload = {
      account_code: form.account_code.trim(),
      account_name: form.account_name.trim(),
      account_type: form.account_type,
      normal_side: form.normal_side,
      parent_id: form.parent_id || null,
      active: form.active,
    };
    if (editingRow) {
      const { error: upErr } = await supabase.from("chart_of_accounts").update(payload).eq("id", editingRow.id);
      if (upErr) { setError(upErr.message); setSubmitting(false); return; }
    } else {
      const { error: insErr } = await supabase.from("chart_of_accounts").insert(payload);
      if (insErr) { setError(insErr.message); setSubmitting(false); return; }
    }
    setSubmitting(false);
    setAddOpen(false);
    resetForm();
    setEditingRow(null);
    await loadAccounts();
  };

  const handleDelete = async (a: ChartAccount) => {
    if (a.system_account) { setError(`"${a.account_name}" is a system account — deactivate instead.`); return; }
    if (!window.confirm(`Delete account "${a.account_code} — ${a.account_name}"?`)) return;
    const { error: delErr } = await supabase.from("chart_of_accounts").delete().eq("id", a.id);
    if (delErr) { setError(delErr.message); return; }
    await loadAccounts();
  };

  // -- Manual journal entry --
  const handleManualJournal = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(manualForm.amount);
    if (!amt || amt <= 0) { setError("Enter a positive amount."); return; }
    if (!manualForm.debit_account_id || !manualForm.credit_account_id) { setError("Select both a debit and credit account."); return; }
    if (manualForm.debit_account_id === manualForm.credit_account_id) { setError("Debit and credit accounts must differ."); return; }
    setManualSubmitting(true);
    setError(null);

    // Insert journal_entry with manual=true, then two journal_lines.
    const { data: entry, error: jeErr } = await supabase
      .from("journal_entries")
      .insert({
        entry_date: manualForm.entry_date,
        description: manualForm.description.trim() || "Manual adjustment",
        source_table: null,
        source_id: null,
        is_reversal: false,
        manual: true,
        posted_by: profile?.id ?? null,
      })
      .select()
      .single();

    if (jeErr) { setError(jeErr.message); setManualSubmitting(false); return; }
    const entryId = (entry as JournalEntry).id;

    const { error: jlErr } = await supabase
      .from("journal_lines")
      .insert([
        { journal_entry_id: entryId, account_id: manualForm.debit_account_id, debit: amt, credit: 0 },
        { journal_entry_id: entryId, account_id: manualForm.credit_account_id, debit: 0, credit: amt },
      ]);
    if (jlErr) { setError(jlErr.message); setManualSubmitting(false); return; }

    setManualSubmitting(false);
    setManualOpen(false);
    setManualForm({ entry_date: todayISO(), description: "", debit_account_id: "", credit_account_id: "", amount: "" });
    if (tab === "tb") loadBalances();
  };

  return (
    <>
      <Header
        title="Chart of Accounts"
        subtitle="Editable account list, Trial Balance (from double-entry journal), and General Ledger drill-down"
        actions={
          <div className="flex gap-2">
            {(tab === "tb" || tab === "gl") && isSuper && (
              <Button variant="secondary" size="md" onClick={() => setManualOpen(true)}>
                <Plus className="w-4 h-4 mr-2" /> Manual Journal Entry
              </Button>
            )}
            <ExportButton
              onExport={() => {
                if (tab === "coa") {
                  exportTable({
                    fileName: "Chart of Accounts.xlsx",
                    sheetName: "CoA",
                    title: "Chart of Accounts",
                    headers: ["Code", "Name", "Type", "Normal Side", "Active"],
                    rows: accounts.map((a) => [a.account_code, a.account_name, ACCOUNT_TYPE_LABEL[a.account_type], a.normal_side, a.active ? "Yes" : "No"]),
                  });
                } else if (tab === "tb") {
                  exportTable({
                    fileName: `Trial Balance ${periodStart} to ${periodEnd}.xlsx`,
                    sheetName: "Trial Balance",
                    title: `Trial Balance — ${periodStart} to ${periodEnd}`,
                    headers: ["Code", "Account", "Type", "Debit (PKR)", "Credit (PKR)"],
                    rows: [...tbRows.map((r) => [r.account.account_code, r.account.account_name, ACCOUNT_TYPE_LABEL[r.account.account_type], r.debit, r.credit]), ["", "TOTAL", "", tbTotals.d, tbTotals.c]],
                  });
                } else if (glAccountId) {
                  const acct = accounts.find((a) => a.id === glAccountId);
                  exportTable({
                    fileName: `GL ${acct?.account_code ?? ""}.xlsx`,
                    sheetName: "General Ledger",
                    title: `General Ledger — ${acct?.account_code} ${acct?.account_name}`,
                    headers: ["Date", "Source", "Description", "Debit", "Credit", "Running"],
                    rows: glRunning.map((r) => [r.row.entry_date, r.row.source_table ?? "manual", r.row.description ?? "", r.row.debit, r.row.credit, r.running]),
                  });
                }
              }}
            />
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        <div className="bg-white rounded-lg border border-slate-200">
          {/* Tabs + period range */}
          <div className="p-4 md:p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              {([
                { v: "coa", label: "Chart of Accounts" },
                { v: "tb", label: "Trial Balance" },
                { v: "gl", label: "General Ledger" },
              ] as const).map((t) => (
                <button
                  key={t.v}
                  onClick={() => setTab(t.v)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${tab === t.v ? "bg-brand-600 text-[#fff]" : "text-slate-600 hover:bg-slate-100"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {(tab === "tb" || tab === "gl") && (
              <div className="flex items-center gap-2 text-sm">
                <label className="text-slate-600">From</label>
                <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="px-2 py-1 border border-slate-200 rounded text-sm" />
                <label className="text-slate-600">To</label>
                <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="px-2 py-1 border border-slate-200 rounded text-sm" />
                <button type="button" onClick={() => { setPeriodStart(monthStartISO()); setPeriodEnd(todayISO()); }} className="px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50">MTD</button>
                <button type="button" onClick={() => { setPeriodStart(yearStartISO()); setPeriodEnd(todayISO()); }} className="px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50">YTD</button>
              </div>
            )}
          </div>

          {/* CoA tab */}
          {tab === "coa" && (
            <div className="p-4 md:p-6 space-y-4">
              <div className="flex flex-wrap items-center gap-2 justify-between">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input type="text" value={coaSearch} onChange={(e) => setCoaSearch(e.target.value)} placeholder="Search…" className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-md text-sm" />
                </div>
                {isSuper && (
                  <Button variant="primary" size="md" onClick={() => { resetForm(); setEditingRow(null); setAddOpen(true); }}>
                    <Plus className="w-4 h-4 mr-2" /> Add Account
                  </Button>
                )}
              </div>
              {loading ? (
                <div className="py-10 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…</div>
              ) : (
                <div className="space-y-5">
                  {ACCOUNT_TYPE_ORDER.map((type) => {
                    const rows = accountsByType.get(type) ?? [];
                    if (rows.length === 0) return null;
                    return <CoaTypeSection key={type} type={type} rows={rows} isSuper={isSuper} onEdit={openEdit} onDelete={handleDelete} />;
                  })}
                </div>
              )}
            </div>
          )}

          {/* Trial Balance tab */}
          {tab === "tb" && (
            <div className="p-4 md:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-slate-600">
                  Balances from the double-entry journal. Every entry has matching debits and credits by construction.
                </p>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={tbHideZero} onChange={(e) => setTbHideZero(e.target.checked)} />
                  Hide zero balances
                </label>
              </div>
              {txLoading ? (
                <div className="py-10 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Computing…</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50">
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Code</th>
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Account</th>
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Type</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Debit</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Credit</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {tbRows.length === 0 && (
                        <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500 text-sm">No activity in this period.</td></tr>
                      )}
                      {tbRows.map((r) => (
                        <tr key={r.account.id} className="hover:bg-slate-50">
                          <td className="px-4 py-2 text-xs font-mono text-slate-900">{r.account.account_code}</td>
                          <td className="px-4 py-2 text-sm text-slate-900">{r.account.account_name}</td>
                          <td className="px-4 py-2 text-xs text-slate-500">{ACCOUNT_TYPE_LABEL[r.account.account_type]}</td>
                          <td className="px-4 py-2 text-right text-sm">{r.debit !== 0 ? fmtPKR(r.debit) : ""}</td>
                          <td className="px-4 py-2 text-right text-sm">{r.credit !== 0 ? fmtPKR(r.credit) : ""}</td>
                          <td className="px-4 py-2 text-right">
                            <button onClick={() => { setGlAccountId(r.account.id); setTab("gl"); }} className="text-xs text-brand-600 hover:text-brand-700">
                              View ledger →
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-slate-300 bg-slate-50">
                        <td colSpan={3} className="px-4 py-3 text-sm text-slate-900 font-medium text-right">TOTAL</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-900 font-medium">{fmtPKR(tbTotals.d)}</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-900 font-medium">{fmtPKR(tbTotals.c)}</td>
                        <td></td>
                      </tr>
                      <tr>
                        <td colSpan={6} className="px-4 py-2 text-xs text-right">
                          Difference:{" "}
                          <span className={Math.abs(tbTotals.d - tbTotals.c) < 1 ? "text-success-700 font-medium" : "text-danger-700"}>
                            {fmtPKR(tbTotals.d - tbTotals.c)}
                          </span>
                          {Math.abs(tbTotals.d - tbTotals.c) < 1 && (
                            <span className="text-success-700 ml-2">✓ Balanced</span>
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* General Ledger tab */}
          {tab === "gl" && (
            <div className="p-4 md:p-6 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => setTab("tb")} className="text-sm text-brand-600 hover:text-brand-700 inline-flex items-center gap-1">
                  <ChevronLeft className="w-4 h-4" /> Back to Trial Balance
                </button>
                <ThemedSelect value={glAccountId ?? ""} onChange={(e) => setGlAccountId(e.target.value || null)} className="px-3 py-2 border border-slate-200 rounded-md text-sm min-w-[280px]">
                  <option value="">— Select an account —</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_code} — {a.account_name}</option>)}
                </ThemedSelect>
              </div>
              {!glAccountId ? (
                <p className="text-sm text-slate-500">Pick an account above (or click "View ledger" from the Trial Balance).</p>
              ) : txLoading ? (
                <div className="py-10 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50">
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Date</th>
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Source</th>
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Description</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Debit</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Credit</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Running</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {glRunning.length === 0 && (
                        <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500 text-sm">No entries in this period.</td></tr>
                      )}
                      {glRunning.map((r, i) => (
                        <tr key={i} className={`hover:bg-slate-50 ${r.row.is_reversal ? "opacity-60 italic" : ""}`}>
                          <td className="px-4 py-2 text-xs text-slate-700">{r.row.entry_date}</td>
                          <td className="px-4 py-2 text-xs text-slate-700">{r.row.source_table ?? "manual"}{r.row.is_reversal ? " (rev)" : ""}</td>
                          <td className="px-4 py-2 text-sm text-slate-900">{r.row.description ?? "—"}</td>
                          <td className="px-4 py-2 text-right text-sm">{r.row.debit ? fmtPKR(r.row.debit) : ""}</td>
                          <td className="px-4 py-2 text-right text-sm">{r.row.credit ? fmtPKR(r.row.credit) : ""}</td>
                          <td className="px-4 py-2 text-right text-sm text-slate-900">{fmtPKR(r.running)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* CoA add/edit modal */}
      <Modal isOpen={addOpen} onClose={() => { setAddOpen(false); setEditingRow(null); resetForm(); }} title={editingRow ? `Edit ${editingRow.account_code}` : "Add Account"} size="md">
        <form className="space-y-3" onSubmit={handleSubmit}>
          {editingRow?.system_account && (
            <div className="text-xs text-warning-700 bg-warning-50 border border-warning-200 rounded p-2">
              System account — rename is fine; changing type is not recommended.
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account Code *</label>
              <input required type="text" value={form.account_code} onChange={(e) => setForm({ ...form, account_code: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm font-mono" placeholder="e.g., 6400" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account Type *</label>
              <ThemedSelect
                value={form.account_type}
                onChange={(e) => {
                  const t = e.target.value as AccountType;
                  setForm({ ...form, account_type: t, normal_side: t === "asset" || t === "expense" ? "debit" : "credit" });
                }}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                {ACCOUNT_TYPE_ORDER.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABEL[t]}</option>)}
              </ThemedSelect>
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Account Name *</label>
              <input required type="text" value={form.account_name} onChange={(e) => setForm({ ...form, account_name: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Normal Side</label>
              <ThemedSelect value={form.normal_side} onChange={(e) => setForm({ ...form, normal_side: e.target.value as AccountNormalSide })} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm">
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </ThemedSelect>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                Active
              </label>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-3 border-t border-slate-200">
            <Button variant="primary" size="md" disabled={submitting} className="flex-1">
              {submitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {editingRow ? "Save Changes" : "Add Account"}
            </Button>
            <Button variant="secondary" size="md" onClick={() => { setAddOpen(false); resetForm(); setEditingRow(null); }}>Cancel</Button>
          </div>
        </form>
      </Modal>

      {/* Manual journal entry modal */}
      <Modal isOpen={manualOpen} onClose={() => setManualOpen(false)} title="Manual Journal Entry" size="md">
        <form className="space-y-3" onSubmit={handleManualJournal}>
          <p className="text-xs text-slate-500">
            Post a balanced debit/credit entry. For adjustments, corrections, or entries not captured by the auto-journal triggers.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Date *</label>
              <input required type="date" value={manualForm.entry_date} onChange={(e) => setManualForm({ ...manualForm, entry_date: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
              <input required type="number" min="0.01" step="0.01" value={manualForm.amount} onChange={(e) => setManualForm({ ...manualForm, amount: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Debit Account *</label>
              <ThemedSelect required value={manualForm.debit_account_id} onChange={(e) => setManualForm({ ...manualForm, debit_account_id: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm">
                <option value="">— Select —</option>
                {accounts.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.account_code} — {a.account_name}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Credit Account *</label>
              <ThemedSelect required value={manualForm.credit_account_id} onChange={(e) => setManualForm({ ...manualForm, credit_account_id: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm">
                <option value="">— Select —</option>
                {accounts.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.account_code} — {a.account_name}</option>)}
              </ThemedSelect>
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Description</label>
              <input type="text" value={manualForm.description} onChange={(e) => setManualForm({ ...manualForm, description: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" placeholder="e.g., Opening balance adjustment" />
            </div>
          </div>
          <div className="flex items-center gap-2 pt-3 border-t border-slate-200">
            <Button variant="primary" size="md" disabled={manualSubmitting} className="flex-1">
              {manualSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
              Post Entry
            </Button>
            <Button variant="secondary" size="md" onClick={() => setManualOpen(false)}>Cancel</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function CoaTypeSection({ type, rows, isSuper, onEdit, onDelete }: {
  type: AccountType;
  rows: ChartAccount[];
  isSuper: boolean;
  onEdit: (a: ChartAccount) => void;
  onDelete: (a: ChartAccount) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-slate-200 rounded-md overflow-hidden">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-4 py-2.5 bg-slate-50 hover:bg-slate-100 text-sm text-slate-900 transition-colors">
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <span className="flex-1 text-left">{ACCOUNT_TYPE_LABEL[type]}</span>
        <span className="text-xs text-slate-500">{rows.length} account{rows.length === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <table className="w-full">
          <tbody className="divide-y divide-slate-100">
            {rows.map((a) => (
              <tr key={a.id} className={a.active ? "" : "opacity-50"}>
                <td className="px-4 py-2 text-xs font-mono text-slate-700 w-20">{a.account_code}</td>
                <td className="px-4 py-2 text-sm text-slate-900">
                  {a.account_name}
                  {a.system_account && <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">system</span>}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500 capitalize w-20">{a.normal_side}</td>
                <td className="px-4 py-2 text-right">
                  {isSuper && (
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => onEdit(a)} className="p-1.5 rounded text-slate-600 hover:bg-slate-100" title="Edit"><Pencil className="w-4 h-4" /></button>
                      {!a.system_account && <button onClick={() => onDelete(a)} className="p-1.5 rounded text-danger-600 hover:bg-danger-50" title="Delete"><Trash2 className="w-4 h-4" /></button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
