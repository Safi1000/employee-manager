import ThemedSelect from "../../components/ThemedSelect";
import { useCallback, useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase, type Branch } from "../../lib/supabase";

// Opening Trial Balance import (§4.4). Build a dated batch of debit/credit lines
// against the chart of accounts (region-tagged), confirm it balances, then post
// it through post_opening_balances — a single balanced journal that seeds the
// ledger. This is what lifts GnG out of the red danger band.

const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";
const money = (n: any) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function OpeningBalances() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [batches, setBatches] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [lines, setLines] = useState<any[]>([]);
  const [totals, setTotals] = useState<any>(null);

  // create-batch form
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [desc, setDesc] = useState("Opening trial balance");

  // add-line form
  const [accId, setAccId] = useState("");
  const [brId, setBrId] = useState("");
  const [debit, setDebit] = useState("");
  const [credit, setCredit] = useState("");

  const loadBatches = useCallback(async () => {
    if (!companyId) return;
    const [b, a, br] = await Promise.all([
      supabase.from("opening_balance_batches").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
      supabase.from("chart_of_accounts").select("id,account_code,account_name,account_type").eq("company_id", companyId).eq("active", true).order("account_code"),
      supabase.from("branches").select("*").eq("company_id", companyId).order("is_head_office", { ascending: false }).order("name"),
    ]);
    setBatches(b.data ?? []);
    setAccounts(a.data ?? []);
    setBranches((br.data ?? []) as Branch[]);
  }, [companyId]);

  const loadLines = useCallback(async () => {
    if (!selected) { setLines([]); setTotals(null); return; }
    const [l, t] = await Promise.all([
      supabase.from("opening_balance_lines").select("*").eq("batch_id", selected),
      supabase.rpc("opening_batch_totals", { p_batch_id: selected }),
    ]);
    setLines(l.data ?? []);
    setTotals(Array.isArray(t.data) ? t.data[0] : t.data);
  }, [selected]);

  useEffect(() => { loadBatches(); }, [loadBatches]);
  useEffect(() => { loadLines(); }, [loadLines]);

  const run = async (p: PromiseLike<{ error: { message: string } | null }>, reloadLines = true) => {
    setBusy(true); setErr(null);
    const { error } = await p;
    setBusy(false);
    if (error) { setErr(error.message); return false; }
    await loadBatches();
    if (reloadLines) await loadLines();
    return true;
  };

  const createBatch = async () => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.from("opening_balance_batches")
      .insert({ company_id: companyId, as_of_date: asOf, description: desc }).select("id").single();
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await loadBatches();
    if (data?.id) setSelected(data.id);
  };

  const addLine = async () => {
    if (!selected || !accId) return;
    const ok = await run(supabase.from("opening_balance_lines").insert({
      batch_id: selected, account_id: accId, branch_id: brId || null,
      debit: Number(debit) || 0, credit: Number(credit) || 0,
    }));
    if (ok) { setAccId(""); setDebit(""); setCredit(""); }
  };

  const selBatch = batches.find((b) => b.id === selected);
  const acctName = useMemo(() => new Map(accounts.map((a) => [a.id, `${a.account_code} ${a.account_name}`])), [accounts]);
  const brName = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches]);
  const balanced = totals && Math.abs(Number(totals.total_debit ?? 0) - Number(totals.total_credit ?? 0)) < 0.005;
  const posted = selBatch && String(selBatch.status) !== "draft";

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Opening Balances" subtitle="Import & post the opening trial balance (§4.4)" />
      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      <div className="grid md:grid-cols-3 gap-6">
        {/* Batch list + create */}
        <div className="space-y-4">
          <section className="border border-slate-200 rounded-md p-3 space-y-2">
            <h3 className="text-sm text-slate-900">New batch</h3>
            <input type="date" className={FIELD + " w-full"} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            <input className={FIELD + " w-full"} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description" />
            <Button variant="primary" size="sm" disabled={busy} onClick={createBatch}>Create batch</Button>
          </section>
          <section className="border border-slate-200 rounded-md divide-y divide-slate-100">
            {batches.map((b) => (
              <button key={b.id} onClick={() => setSelected(b.id)}
                className={`w-full text-left px-3 py-2 text-sm ${selected === b.id ? "bg-brand-50" : "hover:bg-slate-50"}`}>
                <div className="flex items-center justify-between">
                  <span className="text-slate-700">{b.as_of_date}</span>
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${String(b.status) === "draft" ? "bg-slate-100 text-slate-500" : "bg-success-50 text-success-700"}`}>{String(b.status)}</span>
                </div>
                <div className="text-xs text-slate-500 truncate">{b.description}</div>
              </button>
            ))}
            {batches.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No batches yet.</p>}
          </section>
        </div>

        {/* Selected batch lines */}
        <div className="md:col-span-2 space-y-4">
          {!selected && <p className="text-sm text-slate-500">Select or create a batch.</p>}
          {selected && (
            <>
              {totals && (
                <div className={`rounded-md border p-3 text-sm flex items-center justify-between ${balanced ? "bg-success-50 border-success-200 text-success-700" : "bg-warning-50 border-warning-200 text-warning-700"}`}>
                  <span>Debit {money(totals.total_debit)} · Credit {money(totals.total_credit)}</span>
                  <span className="font-medium">{balanced ? "Balanced" : `Out by ${money(Math.abs(Number(totals.total_debit ?? 0) - Number(totals.total_credit ?? 0)))}`}</span>
                </div>
              )}

              {!posted && (
                <section className="border border-slate-200 rounded-md p-3 grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
                  <div className="col-span-2">
                    <label className="text-xs text-slate-500 block mb-1">Account</label>
                    <ThemedSelect className={FIELD + " w-full"} value={accId} onChange={(e) => setAccId(e.target.value)}>
                      <option value="">— account —</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_code} {a.account_name}</option>)}
                    </ThemedSelect>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">Region</label>
                    <ThemedSelect className={FIELD + " w-full"} value={brId} onChange={(e) => setBrId(e.target.value)}>
                      <option value="">—</option>
                      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </ThemedSelect>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">Debit</label>
                    <input className={FIELD + " w-full"} value={debit} onChange={(e) => setDebit(e.target.value)} placeholder="0" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">Credit</label>
                    <input className={FIELD + " w-full"} value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="0" />
                  </div>
                  <Button variant="secondary" size="sm" disabled={busy || !accId} onClick={addLine}>Add line</Button>
                </section>
              )}

              <div className="overflow-x-auto border border-slate-200 rounded-md">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                    <tr>
                      <th className="text-left px-3 py-2">Account</th>
                      <th className="text-left px-3 py-2">Region</th>
                      <th className="text-right px-3 py-2">Debit</th>
                      <th className="text-right px-3 py-2">Credit</th>
                      {!posted && <th className="px-3 py-2"></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lines.map((l) => (
                      <tr key={l.id}>
                        <td className="px-3 py-1.5 text-slate-700">{acctName.get(l.account_id) ?? "—"}</td>
                        <td className="px-3 py-1.5 text-slate-500">{l.branch_id ? brName.get(l.branch_id) : "—"}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{Number(l.debit) ? money(l.debit) : ""}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{Number(l.credit) ? money(l.credit) : ""}</td>
                        {!posted && (
                          <td className="px-3 py-1.5 text-right">
                            <button className="text-danger-600 text-xs" disabled={busy}
                              onClick={() => run(supabase.from("opening_balance_lines").delete().eq("id", l.id))}>Remove</button>
                          </td>
                        )}
                      </tr>
                    ))}
                    {lines.length === 0 && <tr><td colSpan={posted ? 4 : 5} className="px-3 py-3 text-slate-500">No lines.</td></tr>}
                  </tbody>
                </table>
              </div>

              {!posted && (
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" disabled={busy || !balanced || lines.length === 0}
                    onClick={() => run(supabase.rpc("post_opening_balances", { p_batch_id: selected }))}>
                    Post opening balances
                  </Button>
                  {!balanced && <span className="text-xs text-slate-400">Batch must balance before it can be posted.</span>}
                </div>
              )}
              {posted && <p className="text-xs text-success-600">Posted — seeded into the ledger via journal entry.</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
