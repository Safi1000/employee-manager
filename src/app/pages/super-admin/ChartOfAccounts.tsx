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
  Landmark,
  Wallet,
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
  type TrialBalanceAccountRow,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { useRegion } from "../../lib/region";

// CHART OF ACCOUNTS
//
// The account tree, its control-account flags, the per-location and per-bank
// sub-accounts, and each account's balance.
//
// The balance is READ from the ledger via `trial_balance_for` (0320), which
// answers at the region grain this screen is looking at, over `trial_balance`
// — 0299's single source, given a period by 0319. This screen used to host a
// Trial Balance tab and a General Ledger tab that pulled every journal line and
// summed them in the browser. Those are now their own screens reading the ledger; the tabs are
// gone rather than left beside their replacements, so the old shape cannot
// come back by habit.

const fmtPKR = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;

/** A cash or bank sub-account, named by the location it belongs to. */
type SubAccountLabel = { name: string; kind: "bank" | "cash" };

export default function ChartOfAccounts() {
  const { profile, company } = useAuth();
  const { regionId, region } = useRegion();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
  const isSuper = profile?.role === "super_admin" || profile?.role === "super_super_admin";

  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [balances, setBalances] = useState<Map<string, { debit: number; credit: number }>>(
    new Map(),
  );
  const [subAccounts, setSubAccounts] = useState<Map<string, SubAccountLabel>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  const [coaSearch, setCoaSearch] = useState("");

  // What 0342 will refuse, computed once for the edit dialog. See the note in
  // the dialog for why this keys on system_key rather than system_account.
  const isSystemControl = !!editingRow?.system_key;
  // A proxy for "carries posted journal lines": the trial balance only lists
  // accounts that have them. The DATABASE is authoritative — the trigger scans
  // journal_lines directly — so a rare account whose lines net to zero may not
  // be flagged here and will still be refused on save. That is the safe
  // direction to be wrong in.
  const hasPostedLines = !!editingRow && balances.has(editingRow.id);
  const lockStructure = isSystemControl || hasPostedLines;

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

  // Which leaf accounts are the cash and bank sub-accounts, and what they are
  // sub-accounts OF. `cash_locations` is the table that owns that fact — 0268
  // is the reason a cash movement has to name one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!companyId) return;
      const { data } = await supabase
        .from("cash_locations")
        .select("name, location_type, coa_account_id, bank_account_id")
        .eq("company_id", companyId);
      if (cancelled) return;
      const m = new Map<string, SubAccountLabel>();
      for (const r of (data ?? []) as {
        name: string;
        location_type: string | null;
        coa_account_id: string | null;
        bank_account_id: string | null;
      }[]) {
        if (!r.coa_account_id) continue;
        m.set(r.coa_account_id, {
          name: r.name,
          kind: r.bank_account_id ? "bank" : "cash",
        });
      }
      setSubAccounts(m);
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Balances, read from the ledger. Cumulative across every period — the
  // period-by-period view is the Trial Balance screen's job, not this one's.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!companyId) return;
      // 0320 returns one row per account at the requested grain. A null period
      // is every period, which is what a chart of accounts wants; the region
      // comes from the selector. Nothing is added up here — the earlier version
      // of this screen folded the view's branch and period rows itself, which
      // is a second implementation of a total the ledger already has.
      const { data, error: bErr } = await supabase.rpc("trial_balance_for", {
        p_company_id: companyId,
        p_period: null,
        p_branch_id: regionId,
      });
      if (cancelled) return;
      if (bErr) {
        setError(bErr.message);
        return;
      }
      const m = new Map<string, { debit: number; credit: number }>();
      for (const r of (data ?? []) as TrialBalanceAccountRow[]) {
        m.set(r.account_id, {
          debit: Number(r.total_debit),
          credit: Number(r.total_credit),
        });
      }
      setBalances(m);
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, regionId]);

  const filteredAccounts = useMemo(() => {
    const q = coaSearch.trim().toLowerCase();
    if (!q) return accounts;
    // A matching child keeps its parent visible, otherwise a search for a
    // custodian's cash account shows it floating with no control account above
    // it and no indication of what it rolls up into.
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const keep = new Set<string>();
    for (const a of accounts) {
      if (
        a.account_code.toLowerCase().includes(q) ||
        a.account_name.toLowerCase().includes(q)
      ) {
        keep.add(a.id);
        let p = a.parent_id;
        while (p && !keep.has(p)) {
          keep.add(p);
          p = byId.get(p)?.parent_id ?? null;
        }
      }
    }
    return accounts.filter((a) => keep.has(a.id));
  }, [accounts, coaSearch]);

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, ChartAccount[]>();
    for (const a of filteredAccounts) {
      const key = a.parent_id ?? null;
      const arr = m.get(key) ?? [];
      arr.push(a);
      m.set(key, arr);
    }
    for (const arr of m.values()) {
      arr.sort((x, y) => x.account_code.localeCompare(y.account_code));
    }
    return m;
  }, [filteredAccounts]);

  const visibleIds = useMemo(
    () => new Set(filteredAccounts.map((a) => a.id)),
    [filteredAccounts],
  );

  // Roots per type: an account with no parent, or one whose parent is filtered
  // out — otherwise a matched child would vanish along with its hidden parent.
  const rootsByType = useMemo(() => {
    const m = new Map<AccountType, ChartAccount[]>();
    for (const t of ACCOUNT_TYPE_ORDER) m.set(t, []);
    for (const a of filteredAccounts) {
      if (!a.parent_id || !visibleIds.has(a.parent_id)) m.get(a.account_type)?.push(a);
    }
    for (const arr of m.values()) {
      arr.sort((x, y) => x.account_code.localeCompare(y.account_code));
    }
    return m;
  }, [filteredAccounts, visibleIds]);

  const resetForm = () =>
    setForm({
      account_code: "",
      account_name: "",
      account_type: "expense",
      normal_side: "debit",
      parent_id: "",
      active: true,
    });

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
      const { error: upErr } = await supabase
        .from("chart_of_accounts")
        .update(payload)
        .eq("id", editingRow.id);
      if (upErr) {
        setError(upErr.message);
        setSubmitting(false);
        return;
      }
    } else {
      const { error: insErr } = await supabase.from("chart_of_accounts").insert(payload);
      if (insErr) {
        setError(insErr.message);
        setSubmitting(false);
        return;
      }
    }
    setSubmitting(false);
    setAddOpen(false);
    resetForm();
    setEditingRow(null);
    await loadAccounts();
  };

  const handleDelete = async (a: ChartAccount) => {
    if (a.system_account) {
      setError(`"${a.account_name}" is a system account — deactivate instead.`);
      return;
    }
    if (!window.confirm(`Delete account "${a.account_code} — ${a.account_name}"?`)) return;
    const { error: delErr } = await supabase.from("chart_of_accounts").delete().eq("id", a.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAccounts();
  };

  return (
    <>
      <Header
        title="Chart of Accounts"
        subtitle={`The account tree, with balances read from the ledger${
          region ? ` — ${region.name}` : ""
        }`}
        actions={
          <ExportButton
            onExport={() =>
              exportTable({
                fileName: "Chart of Accounts.xlsx",
                sheetName: "CoA",
                title: "Chart of Accounts",
                headers: [
                  "Code",
                  "Name",
                  "Type",
                  "Normal Side",
                  "Control",
                  "Sub-account of",
                  "Debit (PKR)",
                  "Credit (PKR)",
                  "Net (PKR)",
                  "Side",
                  "Active",
                ],
                rows: accounts.map((a) => {
                  const b = balances.get(a.id) ?? { debit: 0, credit: 0 };
                  return [
                    a.account_code,
                    a.account_name,
                    ACCOUNT_TYPE_LABEL[a.account_type],
                    a.normal_side,
                    a.is_control ? "Yes" : "",
                    subAccounts.get(a.id)?.name ?? "",
                    b.debit,
                    b.credit,
                    Math.abs(b.debit - b.credit),
                    b.debit - b.credit === 0 ? "" : b.debit - b.credit > 0 ? "Dr" : "Cr",
                    a.active ? "Yes" : "No",
                  ];
                }),
              })
            }
          />
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

        <div className="bg-white rounded-lg border border-slate-200 p-4 md:p-6 space-y-4">
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={coaSearch}
                onChange={(e) => setCoaSearch(e.target.value)}
                placeholder="Search code or name…"
                className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            {isSuper && (
              <Button
                variant="primary"
                size="md"
                onClick={() => {
                  resetForm();
                  setEditingRow(null);
                  setAddOpen(true);
                }}
              >
                <Plus className="w-4 h-4 mr-2" /> Add Account
              </Button>
            )}
          </div>

          {loading ? (
            <div className="py-10 text-center text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
            </div>
          ) : (
            <div className="space-y-5">
              {ACCOUNT_TYPE_ORDER.map((type) => {
                const roots = rootsByType.get(type) ?? [];
                if (roots.length === 0) return null;
                return (
                  <CoaTypeSection
                    key={type}
                    type={type}
                    roots={roots}
                    childrenOf={childrenOf}
                    balances={balances}
                    subAccounts={subAccounts}
                    isSuper={isSuper}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      <Modal
        isOpen={addOpen}
        error={error}
        onDismissError={() => setError(null)}
        onClose={() => {
          setAddOpen(false);
          setEditingRow(null);
          resetForm();
        }}
        title={editingRow ? `Edit ${editingRow.account_code}` : "Add Account"}
        size="md"
      >
        <form className="space-y-3" onSubmit={handleSubmit}>
          {/* These flags MIRROR what 0342 enforces in the database; they do not
              implement it. `chart_of_accounts` has more than one writer, so the
              trigger is the control and this is the explanation — the fields are
              disabled so the refusal is visible before the save, not after it.

              Keyed on system_key, NOT system_account. They are different sets:
              the 53 accounts with a system_key are the real control accounts
              (1000, 1010, 1100, 3200 …); the 7 with system_account but no key
              are the per-bank and per-custodian leaves (1010.01, 1000.02 …),
              which may legitimately be restructured. Using system_account here
              would disable fields the database allows. */}
          {isSystemControl && (
            <div className="text-xs text-warning-700 bg-warning-50 border border-warning-200 rounded p-2">
              <span className="font-medium">System control account — name only.</span> Its code, type,
              normal side and parent are fixed and the database refuses changes to them. Other objects
              address this account by its code, and nesting it under another control account would put
              its whole subtree into that account&rsquo;s balance.
            </div>
          )}
          {!isSystemControl && hasPostedLines && (
            <div className="text-xs text-warning-700 bg-warning-50 border border-warning-200 rounded p-2">
              <span className="font-medium">This account already carries posted journal lines.</span> Its
              parent and type are fixed — moving it would move a balance with no entry behind the move.
              Post a correcting entry instead.
            </div>
          )}
          {editingRow?.is_control && (
            <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded p-2">
              Control account. Entries post to its children; its balance is their
              total.
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account Code *</label>
              <input
                required
                type="text"
                disabled={isSystemControl}
                title={isSystemControl ? "System control account — other objects address it by this code." : undefined}
                value={form.account_code}
                onChange={(e) => setForm({ ...form, account_code: e.target.value })}
                className={`w-full px-3 py-2 border border-slate-200 rounded-md text-sm font-mono ${isSystemControl ? "bg-slate-50 text-slate-500" : ""}`}
                placeholder="e.g., 6400"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account Type *</label>
              <ThemedSelect
                value={form.account_type}
                disabled={lockStructure}
                title={
                  isSystemControl
                    ? "System control account — its type is fixed."
                    : hasPostedLines
                      ? "This account carries posted journal lines — changing its type would move a balance to the other side of the statement."
                      : undefined
                }
                onChange={(e) => {
                  const t = e.target.value as AccountType;
                  setForm({
                    ...form,
                    account_type: t,
                    normal_side: t === "asset" || t === "expense" ? "debit" : "credit",
                  });
                }}
                className={`w-full px-3 py-2 border border-slate-200 rounded-md text-sm ${lockStructure ? "bg-slate-50 text-slate-500" : ""}`}
              >
                {ACCOUNT_TYPE_ORDER.map((t) => (
                  <option key={t} value={t}>
                    {ACCOUNT_TYPE_LABEL[t]}
                  </option>
                ))}
              </ThemedSelect>
            </div>
            <div className="col-span-full">
              <label className="block text-sm text-slate-700 mb-1">Account Name *</label>
              <input
                required
                type="text"
                value={form.account_name}
                onChange={(e) => setForm({ ...form, account_name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div className="col-span-full">
              <label className="block text-sm text-slate-700 mb-1">Parent Account</label>
              <ThemedSelect
                value={form.parent_id}
                disabled={lockStructure}
                title={
                  isSystemControl
                    ? "System control account — it belongs at the top level."
                    : hasPostedLines
                      ? "This account carries posted journal lines — moving it would move a balance with no entry behind the move."
                      : undefined
                }
                onChange={(e) => setForm({ ...form, parent_id: e.target.value })}
                className={`w-full px-3 py-2 border border-slate-200 rounded-md text-sm ${lockStructure ? "bg-slate-50 text-slate-500" : ""}`}
              >
                <option value="">— None (top level) —</option>
                {accounts
                  .filter((a) => a.id !== editingRow?.id && a.account_type === form.account_type)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.account_code} — {a.account_name}
                    </option>
                  ))}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Normal Side</label>
              <ThemedSelect
                value={form.normal_side}
                onChange={(e) =>
                  setForm({ ...form, normal_side: e.target.value as AccountNormalSide })
                }
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </ThemedSelect>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                />
                Active
              </label>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-3 border-t border-slate-200">
            <Button variant="primary" size="md" disabled={submitting} className="flex-1">
              {submitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {editingRow ? "Save Changes" : "Add Account"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setAddOpen(false);
                resetForm();
                setEditingRow(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function CoaTypeSection({
  type,
  roots,
  childrenOf,
  balances,
  subAccounts,
  isSuper,
  onEdit,
  onDelete,
}: {
  type: AccountType;
  roots: ChartAccount[];
  childrenOf: Map<string | null, ChartAccount[]>;
  balances: Map<string, { debit: number; credit: number }>;
  subAccounts: Map<string, SubAccountLabel>;
  isSuper: boolean;
  onEdit: (a: ChartAccount) => void;
  onDelete: (a: ChartAccount) => void;
}) {
  const [open, setOpen] = useState(true);
  const count = useMemo(() => {
    let n = 0;
    const walk = (rows: ChartAccount[]) => {
      for (const r of rows) {
        n += 1;
        walk(childrenOf.get(r.id) ?? []);
      }
    };
    walk(roots);
    return n;
  }, [roots, childrenOf]);

  return (
    <div className="border border-slate-200 rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-slate-50 hover:bg-slate-100 text-sm text-slate-900 transition-colors"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <span className="flex-1 text-left">{ACCOUNT_TYPE_LABEL[type]}</span>
        <span className="text-xs text-slate-500">
          {count} account{count === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-white">
                <th className="text-left px-4 py-2 text-[11px] text-slate-400 uppercase w-24">
                  Code
                </th>
                <th className="text-left px-4 py-2 text-[11px] text-slate-400 uppercase">
                  Account
                </th>
                <th className="text-right px-4 py-2 text-[11px] text-slate-400 uppercase w-36">
                  Debit
                </th>
                <th className="text-right px-4 py-2 text-[11px] text-slate-400 uppercase w-36">
                  Credit
                </th>
                {/* The Debit and Credit columns are GROSS totals, and without
                    this one the screen states no account's balance anywhere.
                    Accounts Receivable read 4,102,659 Dr against 4,140,659 Cr
                    on 2026-09-03 and was reported as a 4.1m receivable; it was
                    a 38,000 credit. A reader who cannot find a balance will use
                    the debit column as one. */}
                <th className="text-right px-4 py-2 text-[11px] text-slate-400 uppercase w-40">
                  Net
                </th>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roots.map((a) => (
                <CoaRows
                  key={a.id}
                  account={a}
                  depth={0}
                  childrenOf={childrenOf}
                  balances={balances}
                  subAccounts={subAccounts}
                  isSuper={isSuper}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CoaRows({
  account,
  depth,
  childrenOf,
  balances,
  subAccounts,
  isSuper,
  onEdit,
  onDelete,
}: {
  account: ChartAccount;
  depth: number;
  childrenOf: Map<string | null, ChartAccount[]>;
  balances: Map<string, { debit: number; credit: number }>;
  subAccounts: Map<string, SubAccountLabel>;
  isSuper: boolean;
  onEdit: (a: ChartAccount) => void;
  onDelete: (a: ChartAccount) => void;
}) {
  const kids = childrenOf.get(account.id) ?? [];
  const bal = balances.get(account.id) ?? { debit: 0, credit: 0 };
  const net = bal.debit - bal.credit;
  const contra = net !== 0 && (net > 0 ? account.normal_side === "credit" : account.normal_side === "debit");
  const sub = subAccounts.get(account.id);

  return (
    <>
      <tr className={account.active ? "hover:bg-slate-50" : "opacity-50"}>
        <td className="px-4 py-2 text-xs font-mono text-slate-700 align-top">
          {account.account_code}
        </td>
        <td className="px-4 py-2 text-sm text-slate-900">
          <span style={{ paddingLeft: depth * 18 }} className="inline-flex items-center gap-2">
            {sub?.kind === "bank" && <Landmark className="w-3.5 h-3.5 text-slate-400" />}
            {sub?.kind === "cash" && <Wallet className="w-3.5 h-3.5 text-slate-400" />}
            <span>{account.account_name}</span>
            {account.is_control && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 border border-brand-200">
                control
              </span>
            )}
            {account.system_account && (
              <span className="text-[10px] uppercase tracking-wide text-slate-400">system</span>
            )}
            {sub && (
              <span className="text-[11px] text-slate-400">
                {sub.kind === "bank" ? "bank" : "cash"} · {sub.name}
              </span>
            )}
          </span>
        </td>
        <td className="px-4 py-2 text-right text-sm text-slate-800">
          {bal.debit !== 0 ? fmtPKR(bal.debit) : ""}
        </td>
        <td className="px-4 py-2 text-right text-sm text-slate-800">
          {bal.credit !== 0 ? fmtPKR(bal.credit) : ""}
        </td>
        {/* Net, with the side named. An unsigned figure in a column beside two
            gross ones is the same ambiguity again, so the balance always says
            Dr or Cr rather than relying on the reader knowing the account's
            normal side. A balance sitting on the side OPPOSITE its normal one
            is shown in amber: legitimate and temporary (AR ran credit while a
            receipt waited for its opening batch), but worth seeing. */}
        <td className="px-4 py-2 text-right text-sm tabular-nums">
          {net === 0 ? (
            <span className="text-slate-300">—</span>
          ) : (
            <span className={contra ? "text-warning-700" : "text-slate-900 font-medium"}>
              {fmtPKR(Math.abs(net))}
              <span className="ml-1 text-[11px] text-slate-400">{net > 0 ? "Dr" : "Cr"}</span>
            </span>
          )}
        </td>
        <td className="px-4 py-2 text-right">
          {isSuper && (
            <div className="flex gap-1 justify-end">
              <button
                onClick={() => onEdit(account)}
                className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                title="Edit"
              >
                <Pencil className="w-4 h-4" />
              </button>
              {!account.system_account && (
                <button
                  onClick={() => onDelete(account)}
                  className="p-1.5 rounded text-danger-600 hover:bg-danger-50"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
        </td>
      </tr>
      {kids.map((k) => (
        <CoaRows
          key={k.id}
          account={k}
          depth={depth + 1}
          childrenOf={childrenOf}
          balances={balances}
          subAccounts={subAccounts}
          isSuper={isSuper}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}
