import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Loader2,
  AlertCircle,
  X,
  Plus,
  ChevronLeft,
  ChevronRight,
  Undo2,
  RotateCcw,
  ExternalLink,
  Info,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";
import {
  supabase,
  type ChartAccount,
  type JournalLineRegional,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { useRegion, withRegion } from "../../lib/region";

// JOURNAL
//
// Every posted entry, read from `public.journal_lines_regional`. 0319 put the
// period, the counterparties, the account and both directions of reversal into
// that view so this screen filters and labels by reading rather than by
// deriving.
//
// REVERSALS ARE NOT A STATUS. 0247 removed the 'reversed' status value
// deliberately, and `journal_entries.status` now holds one value for every row.
// So there are two distinct facts and each has its own source:
//   is_reversal — this entry reverses another (the reversing entry).
//   is_reversed — another entry reverses this one, derived in the view from
//                 `reversal_of_entry_id`. Nothing sets a flag; the pointer is
//                 the fact.
// The screen shows both, because "this was reversed" and "this is the
// reversal" are different things to an accountant reading a journal.

const PAGE_SIZE = 50;

const fmtPKR = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;

const monthLabel = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

/**
 * Where a source document lives. Keyed by `journal_entries.source_table`, which
 * is the ledger's own record of what produced the entry — so the map is a
 * translation, not a guess. An unmapped source degrades to no link rather than
 * to a wrong one.
 */
const SOURCE_ROUTE: Record<string, { path: string; label: string }> = {
  invoices: { path: "/super-admin/invoices", label: "Invoice" },
  invoice_payments: { path: "/super-admin/invoices", label: "Invoice payment" },
  payslips: { path: "/super-admin/payroll", label: "Payslip" },
  expenses: { path: "/super-admin/expenses", label: "Expense" },
  advances: { path: "/super-admin/payroll", label: "Advance" },
  cheques: { path: "/super-admin/treasury", label: "Cheque" },
  bank_transfers: { path: "/super-admin/treasury", label: "Bank transfer" },
  custody_transfers: {
    path: "/super-admin/accounting?tab=cash-custody",
    label: "Custody transfer",
  },
  partner_account_entries: { path: "/super-admin/partners", label: "Partner entry" },
  opening_balance_batches: {
    path: "/super-admin/accounting-core?tab=opening",
    label: "Opening balance",
  },
};

type Entry = {
  id: string;
  entry_date: string;
  posting_period: string;
  description: string | null;
  source_table: string | null;
  source_id: string | null;
  manual: boolean;
  is_reversal: boolean;
  is_reversed: boolean;
  reversal_of_entry_id: string | null;
  region_name: string | null;
  lines: JournalLineRegional[];
};

export default function JournalView() {
  const { profile, company } = useAuth();
  const { regionId } = useRegion();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
  const isSuper = profile?.role === "super_admin" || profile?.role === "super_super_admin";

  const [lines, setLines] = useState<JournalLineRegional[]>([]);
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [partners, setPartners] = useState<{ id: string; name: string }[]>([]);
  const [periods, setPeriods] = useState<string[]>([]);

  const [period, setPeriod] = useState("");
  const [accountId, setAccountId] = useState("");
  const [clientId, setClientId] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // Bumped after a manual post so the list re-reads through the SAME filtered
  // query rather than a second ad-hoc one that would ignore the filters.
  const [reloadKey, setReloadKey] = useState(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState({
    entry_date: new Date().toISOString().slice(0, 10),
    description: "",
    debit_account_id: "",
    credit_account_id: "",
    amount: "",
  });
  const [manualSubmitting, setManualSubmitting] = useState(false);

  // Reference lists for the filters.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!companyId) return;
      const [acc, cl, pt, per] = await Promise.all([
        supabase
          .from("chart_of_accounts")
          .select("*")
          .eq("company_id", companyId)
          .order("account_code"),
        supabase.from("clients").select("id, name").eq("company_id", companyId).order("name"),
        supabase.from("partners").select("id, name").eq("company_id", companyId).order("name"),
        supabase
          .from("journal_lines_regional")
          .select("posting_period")
          .eq("company_id", companyId),
      ]);
      if (cancelled) return;
      setAccounts((acc.data ?? []) as ChartAccount[]);
      setClients((cl.data ?? []) as { id: string; name: string }[]);
      setPartners((pt.data ?? []) as { id: string; name: string }[]);
      const set = new Set(
        ((per.data ?? []) as { posting_period: string }[]).map((r) => r.posting_period),
      );
      setPeriods([...set].sort().reverse());
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Any filter change restarts paging — page 3 of the old result set is not
  // page 3 of the new one.
  useEffect(() => {
    setPage(0);
  }, [period, accountId, clientId, partnerId, regionId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!companyId) {
        setLines([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);

      // Paging is over ENTRIES, not lines: a page boundary that splits an entry
      // would show half of a double entry, which is worse than no paging at
      // all.
      //
      // It also pages in the DATABASE, via .range() on journal_entries, rather
      // than fetching every matching line and slicing the array here. Slicing
      // client-side is silently wrong the moment the result exceeds PostgREST's
      // row cap: page 21 would be missing rows the server never sent, and
      // nothing would say so. The line filters (account, client, partner,
      // region) live on journal_lines, so they are applied as an inner-join
      // filter on the embedded relation — the parent is still one row per
      // entry, so .range() counts entries.
      let idq = supabase
        .from("journal_entries")
        .select("id, journal_lines!inner(id)", { count: "exact" })
        .eq("company_id", companyId)
        .order("entry_date", { ascending: false })
        .order("id", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

      if (period) idq = idq.eq("posting_period", period);
      if (accountId) idq = idq.eq("journal_lines.account_id", accountId);
      if (clientId) idq = idq.eq("journal_lines.client_id", clientId);
      if (partnerId) idq = idq.eq("journal_lines.partner_id", partnerId);
      idq = withRegion(idq, regionId, "journal_lines.branch_id");

      const { data: idRows, error: idErr, count } = await idq;
      if (cancelled) return;
      if (idErr) {
        setError(idErr.message);
        setLoading(false);
        return;
      }

      const pageIds = ((idRows ?? []) as { id: string }[]).map((r) => r.id);
      setHasMore((count ?? 0) > (page + 1) * PAGE_SIZE);

      if (pageIds.length === 0) {
        setLines([]);
        setLoading(false);
        return;
      }

      // Deliberately NOT region-filtered: once an entry is on the page, both
      // sides of it are shown. Filtering the lines too would display an
      // unbalanced entry and invite someone to reconcile a half.
      const { data, error: lErr } = await supabase
        .from("journal_lines_regional")
        .select("*")
        .in("journal_entry_id", pageIds);

      if (cancelled) return;
      if (lErr) {
        setError(lErr.message);
        setLoading(false);
        return;
      }
      setLines((data ?? []) as JournalLineRegional[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, regionId, period, accountId, clientId, partnerId, page, reloadKey]);

  const entries = useMemo(() => {
    const m = new Map<string, Entry>();
    for (const l of lines) {
      let e = m.get(l.journal_entry_id);
      if (!e) {
        e = {
          id: l.journal_entry_id,
          entry_date: l.entry_date,
          posting_period: l.posting_period,
          description: l.description,
          source_table: l.source_table,
          source_id: l.source_id,
          manual: l.manual,
          is_reversal: l.is_reversal,
          is_reversed: l.is_reversed,
          reversal_of_entry_id: l.reversal_of_entry_id,
          region_name: l.region_name,
          lines: [],
        };
        m.set(l.journal_entry_id, e);
      }
      e.lines.push(l);
    }
    for (const e of m.values()) {
      e.lines.sort((a, b) => Number(b.debit) - Number(a.debit));
    }
    return [...m.values()].sort((a, b) => {
      if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });
  }, [lines]);

  const handleManualJournal = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(manualForm.amount);
    if (!amt || amt <= 0) {
      setError("Enter a positive amount.");
      return;
    }
    if (!manualForm.debit_account_id || !manualForm.credit_account_id) {
      setError("Select both a debit and a credit account.");
      return;
    }
    if (manualForm.debit_account_id === manualForm.credit_account_id) {
      setError("Debit and credit accounts must differ.");
      return;
    }
    setManualSubmitting(true);
    setError(null);

    // Manual entry stays on post_manual_journal (0220): the entry and its lines
    // are one transaction, so the deferred debits=credits constraint never sees
    // a line-less entry. The active region is passed through so a manual entry
    // lands in the same region the reader is looking at.
    const { error: jeErr } = await supabase.rpc("post_manual_journal", {
      p_entry_date: manualForm.entry_date,
      p_description: manualForm.description.trim() || "Manual adjustment",
      p_debit_account_id: manualForm.debit_account_id,
      p_credit_account_id: manualForm.credit_account_id,
      p_amount: amt,
      p_branch_id: regionId,
    });
    setManualSubmitting(false);
    if (jeErr) {
      setError(jeErr.message);
      return;
    }
    setManualOpen(false);
    setManualForm({
      entry_date: new Date().toISOString().slice(0, 10),
      description: "",
      debit_account_id: "",
      credit_account_id: "",
      amount: "",
    });
    setPage(0);
    setReloadKey((k) => k + 1);
  };

  const filtersActive = !!(period || accountId || clientId || partnerId);

  return (
    <>
      <Header
        title="Journal"
        subtitle="Every posted entry, with its source document"
        actions={
          <div className="flex gap-2">
            {isSuper && (
              <Button variant="secondary" size="md" onClick={() => setManualOpen(true)}>
                <Plus className="w-4 h-4 mr-2" /> Manual Journal Entry
              </Button>
            )}
            <ExportButton
              onExport={() =>
                exportTable({
                  fileName: "Journal.xlsx",
                  sheetName: "Journal",
                  title: "Journal",
                  headers: [
                    "Date",
                    "Period",
                    "Description",
                    "Source",
                    "Account",
                    "Region",
                    "Debit",
                    "Credit",
                    "Reversal",
                  ],
                  rows: entries.flatMap((e) =>
                    e.lines.map((l) => [
                      e.entry_date,
                      e.posting_period,
                      e.description ?? "",
                      e.source_table ?? "manual",
                      `${l.account_code} — ${l.account_name}`,
                      l.region_name ?? "",
                      Number(l.debit),
                      Number(l.credit),
                      e.is_reversal ? "is a reversal" : e.is_reversed ? "was reversed" : "",
                    ]),
                  ),
                })
              }
            />
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-4 md:p-5 border-b border-slate-200 flex flex-wrap items-center gap-3">
            <ThemedSelect
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">All periods</option>
              {periods.map((p) => (
                <option key={p} value={p}>
                  {monthLabel(p)}
                </option>
              ))}
            </ThemedSelect>

            <ThemedSelect
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-md text-sm min-w-[220px]"
            >
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.account_code} — {a.account_name}
                </option>
              ))}
            </ThemedSelect>

            <ThemedSelect
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-md text-sm min-w-[180px]"
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </ThemedSelect>

            <ThemedSelect
              value={partnerId}
              onChange={(e) => setPartnerId(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-md text-sm min-w-[180px]"
            >
              <option value="">All partners</option>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </ThemedSelect>

            {filtersActive && (
              <button
                type="button"
                onClick={() => {
                  setPeriod("");
                  setAccountId("");
                  setClientId("");
                  setPartnerId("");
                }}
                className="text-sm text-brand-600 hover:text-brand-700"
              >
                Clear filters
              </button>
            )}
          </div>

          {loading ? (
            <div className="py-16 text-center text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
            </div>
          ) : entries.length === 0 ? (
            <div className="py-16 px-6 text-center">
              <Info className="w-6 h-6 mx-auto text-slate-400 mb-3" />
              <p className="text-sm text-slate-700">
                {filtersActive
                  ? "No entries match these filters."
                  : "No journal entries yet."}
              </p>
              {!filtersActive && (
                <p className="text-xs text-slate-500 mt-2 max-w-md mx-auto">
                  This is the ledger reporting that nothing has been posted — not
                  a loading failure. Entries appear here as soon as invoices,
                  payroll, expenses or opening balances are entered.
                </p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {entries.map((e) => (
                <EntryBlock key={e.id} entry={e} />
              ))}
            </div>
          )}

          {(page > 0 || hasMore) && (
            <div className="p-4 border-t border-slate-200 flex items-center justify-between text-sm">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
              >
                <ChevronLeft className="w-4 h-4" /> Previous
              </button>
              <span className="text-slate-500">Page {page + 1}</span>
              <button
                type="button"
                disabled={!hasMore}
                onClick={() => setPage((p) => p + 1)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      <Modal
        isOpen={manualOpen}
        error={error}
        onDismissError={() => setError(null)}
        onClose={() => setManualOpen(false)}
        title="Manual Journal Entry"
        size="md"
      >
        <form className="space-y-3" onSubmit={handleManualJournal}>
          <p className="text-xs text-slate-500">
            Post a balanced debit/credit entry. For adjustments, corrections, or
            entries not captured by the auto-journal triggers.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Date *</label>
              <input
                required
                type="date"
                value={manualForm.entry_date}
                onChange={(e) => setManualForm({ ...manualForm, entry_date: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={manualForm.amount}
                onChange={(e) => setManualForm({ ...manualForm, amount: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Debit Account *</label>
              <ThemedSelect
                required
                value={manualForm.debit_account_id}
                onChange={(e) => setManualForm({ ...manualForm, debit_account_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">— Select —</option>
                {accounts
                  .filter((a) => a.active && !a.is_control)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.account_code} — {a.account_name}
                    </option>
                  ))}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Credit Account *</label>
              <ThemedSelect
                required
                value={manualForm.credit_account_id}
                onChange={(e) =>
                  setManualForm({ ...manualForm, credit_account_id: e.target.value })
                }
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">— Select —</option>
                {accounts
                  .filter((a) => a.active && !a.is_control)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.account_code} — {a.account_name}
                    </option>
                  ))}
              </ThemedSelect>
            </div>
            <div className="col-span-full">
              <label className="block text-sm text-slate-700 mb-1">Description</label>
              <input
                type="text"
                value={manualForm.description}
                onChange={(e) => setManualForm({ ...manualForm, description: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="e.g., Reclassify security deposit"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 pt-3 border-t border-slate-200">
            <Button variant="primary" size="md" disabled={manualSubmitting} className="flex-1">
              {manualSubmitting ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-1" />
              )}
              Post Entry
            </Button>
            <Button variant="secondary" size="md" onClick={() => setManualOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function EntryBlock({ entry }: { entry: Entry }) {
  const source = entry.source_table ? SOURCE_ROUTE[entry.source_table] : undefined;
  const totalDebit = entry.lines.reduce((s, l) => s + Number(l.debit), 0);

  return (
    <div className={`p-4 md:p-5 ${entry.is_reversed ? "bg-slate-50/60" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-mono text-slate-500">{entry.entry_date}</span>
            <span className="text-sm text-slate-900">
              {entry.description ?? "—"}
            </span>

            {/* Two different facts, two different badges. */}
            {entry.is_reversal && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-warning-50 text-warning-700 border border-warning-200">
                <Undo2 className="w-3 h-3" /> Reversal
              </span>
            )}
            {entry.is_reversed && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-danger-50 text-danger-700 border border-danger-200">
                <RotateCcw className="w-3 h-3" /> Reversed
              </span>
            )}
            {entry.manual && (
              <span className="px-2 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-600">
                Manual
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span>Period {monthLabel(entry.posting_period)}</span>
            {entry.region_name && <span>{entry.region_name}</span>}
            {source && entry.source_id ? (
              <Link
                to={`${source.path}${source.path.includes("?") ? "&" : "?"}focus=${entry.source_id}`}
                className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700"
              >
                {source.label} <ExternalLink className="w-3 h-3" />
              </Link>
            ) : (
              <span>{entry.source_table ?? "manual"}</span>
            )}
          </div>
        </div>
        <div className="text-sm text-slate-900 font-medium whitespace-nowrap">
          {fmtPKR(totalDebit)}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <tbody className="divide-y divide-slate-100">
            {entry.lines.map((l) => (
              <tr key={l.id}>
                <td className="py-1.5 pr-3 text-xs font-mono text-slate-500 w-20">
                  {l.account_code}
                </td>
                <td className="py-1.5 pr-3 text-sm text-slate-800">
                  <span className={Number(l.credit) > 0 ? "pl-6 inline-block" : ""}>
                    {l.account_name}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-xs text-slate-400 hidden md:table-cell">
                  {l.region_name ?? ""}
                </td>
                <td className="py-1.5 text-right text-sm w-32">
                  {Number(l.debit) !== 0 ? fmtPKR(Number(l.debit)) : ""}
                </td>
                <td className="py-1.5 text-right text-sm w-32">
                  {Number(l.credit) !== 0 ? fmtPKR(Number(l.credit)) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
