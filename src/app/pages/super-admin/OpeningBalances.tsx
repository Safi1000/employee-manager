import ThemedSelect from "../../components/ThemedSelect";
import { useCallback, useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase, type Branch } from "../../lib/supabase";
import { useFocusTarget, useFocusRow, FOCUS_ROW_CLASS } from "../../lib/focus";

// Opening Trial Balance import (§4.4). Build a dated batch of debit/credit lines
// against the chart of accounts (region-tagged), confirm it balances, then post
// it through post_opening_balances — a single balanced journal that seeds the
// ledger. This is what lifts GnG out of the red danger band.

// A proposed opening line, with the record it came from. The SOURCE is carried
// per line rather than inferred later: an opening balance that cannot say where
// it came from is a number somebody has to re-derive, and re-deriving it is how
// the two copies come to disagree in the first place.
type PrefillLine = {
  key: string;
  account_id: string;
  account_label: string;
  branch_id: string | null;
  source: string;
  debit: number;
  credit: number;
};

const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";
const money = (n: any) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function OpeningBalances() {
  const { profile, company } = useAuth();
  // Resolved the way every other finance screen resolves it. useAuth already
  // follows view_as_company when it loads `company`, so this is the same value
  // — but stating it here means the page does not depend on that staying true.
  const companyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? "";
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [batches, setBatches] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [lines, setLines] = useState<any[]>([]);
  const [totals, setTotals] = useState<any>(null);

  // --- Drill-down from the Journal ----------------------------------------
  // Selecting the batch is what loads its lines, so the link opens the batch
  // rather than merely scrolling the list to it.
  const focusBatch = useFocusTarget("opening_balance_batches");
  const focusBatchRow = useFocusRow(focusBatch);
  useEffect(() => {
    if (focusBatch) setSelected(focusBatch);
  }, [focusBatch]);

  // create-batch form
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [desc, setDesc] = useState("Opening trial balance");

  // Prefill preview. Staged in the browser, editable, and inserted only when
  // the operator says so — nothing here posts.
  const [prefill, setPrefill] = useState<PrefillLine[] | null>(null);
  const [prefillErr, setPrefillErr] = useState<string | null>(null);

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
    // Without this the insert sends company_id: "" and Postgres answers
    // 'invalid input syntax for type uuid: ""' — a parser error standing in for
    // "you have not chosen a company", which is not a thing anyone can act on.
    if (!companyId) {
      setErr("No company is selected. A Super Super Admin must pick a company with the “Viewing as” selector before opening balances can be entered.");
      return;
    }
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

  // THE FIGURES ALREADY EXIST. Bank openings live on bank_accounts, custodian
  // openings on cash_locations, client receivable openings on clients — and
  // none of the three posts a journal entry, which is why this screen exists.
  // Re-typing them here is how the ledger and the records that fed it come to
  // disagree, so they are read instead.
  const buildPrefill = async () => {
    setPrefillErr(null);
    const [banks, locs, cls] = await Promise.all([
      supabase.from("bank_accounts").select("id,bank_name,account_number,opening_balance").eq("company_id", companyId),
      supabase.from("cash_locations").select("id,name,location_type,opening_balance,coa_account_id,branch_id,bank_account_id").eq("company_id", companyId),
      supabase.from("clients").select("id,name,opening_balance,branch_id,receivable_owner_branch_id").eq("company_id", companyId),
    ]);
    const qErr = banks.error ?? locs.error ?? cls.error;
    if (qErr) { setPrefillErr(qErr.message); return; }

    const bankById = new Map<string, any>((banks.data ?? []).map((b: any) => [b.id, b]));
    const accById = new Map<string, any>(accounts.map((a: any) => [a.id, a]));
    const label = (id: string) => {
      const a: any = accById.get(id);
      return a ? a.account_code + " " + a.account_name : "(account not in this chart)";
    };
    const rows: PrefillLine[] = [];

    for (const l of (locs.data ?? []) as any[]) {
      if (!l.coa_account_id) continue;
      // A BANK location mirrors a bank account, and the figure the operator
      // entered sits on the BANK ACCOUNT — cash_locations.opening_balance reads
      // 0.00 on every mirrored row. Reading the mirror instead would propose
      // zero for every bank and look like a clean answer.
      const bank = l.bank_account_id ? bankById.get(l.bank_account_id) : null;
      const amount = Number((bank ? bank.opening_balance : l.opening_balance) ?? 0);
      if (!amount) continue;
      rows.push({
        key: "loc:" + l.id,
        account_id: l.coa_account_id,
        account_label: label(l.coa_account_id),
        branch_id: l.branch_id ?? null,
        source: bank
          ? ("bank_accounts.opening_balance — " + bank.bank_name + " " + (bank.account_number ?? "")).trim()
          : "cash_locations.opening_balance — " + l.name,
        debit: amount,
        credit: 0,
      });
    }

    // Client receivables roll up to the AR control, one line per region that
    // owns the receivable. Per client would be eighteen lines against one
    // account, which is a subsidiary ledger the chart of accounts does not keep.
    const ar: any = accounts.find((a: any) => a.account_code === "1100");
    const byBranch = new Map<string, { total: number; count: number }>();
    for (const c of (cls.data ?? []) as any[]) {
      const amt = Number(c.opening_balance ?? 0);
      if (!amt) continue;
      const br: string = c.receivable_owner_branch_id ?? c.branch_id ?? "";
      const cur = byBranch.get(br) ?? { total: 0, count: 0 };
      byBranch.set(br, { total: cur.total + amt, count: cur.count + 1 });
    }
    if (ar) {
      for (const [br, v] of byBranch) {
        rows.push({
          key: "ar:" + (br || "none"),
          account_id: ar.id,
          account_label: ar.account_code + " " + ar.account_name,
          branch_id: br || null,
          source:
            "clients.opening_balance — " + v.count + " client" + (v.count === 1 ? "" : "s") +
            (br ? ", " + (brName.get(br) ?? "region") : ""),
          debit: v.total,
          credit: 0,
        });
      }
    } else if (byBranch.size > 0) {
      setPrefillErr("Client receivable openings were found, but this chart of accounts has no 1100 Accounts Receivable to put them on.");
    }

    // The balancing credit. Opening Balance Equity is what an opening batch
    // credits by definition; it is a line like any other and can be edited or
    // removed before the batch is posted.
    const eq: any = accounts.find((a: any) => a.account_code === "3200");
    const totalDr = rows.reduce((t, r) => t + r.debit, 0);
    if (eq && totalDr) {
      rows.push({
        key: "equity",
        account_id: eq.id,
        account_label: eq.account_code + " " + eq.account_name,
        branch_id: null,
        source: "balancing credit — the sum of the lines above",
        debit: 0,
        credit: totalDr,
      });
    }

    setPrefill(rows);
  };

  const insertPrefill = async () => {
    if (!selected || !prefill?.length) return;
    const ok = await run(supabase.from("opening_balance_lines").insert(
      prefill.filter((r) => r.debit || r.credit).map((r) => ({
        batch_id: selected,
        account_id: r.account_id,
        branch_id: r.branch_id,
        debit: r.debit,
        credit: r.credit,
      })),
    ));
    if (ok) setPrefill(null);
  };

  const selBatch = batches.find((b) => b.id === selected);
  const acctName = useMemo(() => new Map(accounts.map((a) => [a.id, `${a.account_code} ${a.account_name}`])), [accounts]);
  const brName = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches]);
  const balanced = totals && Math.abs(Number(totals.total_debit ?? 0) - Number(totals.total_credit ?? 0)) < 0.005;
  const posted = selBatch && String(selBatch.status) !== "draft";

  // A Super Super Admin who is not viewing a company has no company to enter an
  // opening balance FOR. The page used to render its full chrome here — an
  // empty account picker, a live "Create batch" button — and only failed when
  // the button was pressed, with a uuid parse error. Say it up front instead.
  if (!companyId) {
    return (
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
        <Header title="Opening Balances" subtitle="Import & post the opening trial balance (§4.4)" />
        <div className="border border-slate-200 rounded-md p-6 max-w-xl">
          <p className="text-sm text-slate-900 mb-2">No company selected.</p>
          <p className="text-sm text-slate-600">
            Opening balances are entered against one company&rsquo;s chart of accounts. Choose a
            company with the &ldquo;Viewing as&rdquo; selector at the top of the page, then come back.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
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
                ref={b.id === focusBatch ? focusBatchRow : undefined}
                className={`w-full text-left px-3 py-2 text-sm ${
                  b.id === focusBatch
                    ? FOCUS_ROW_CLASS
                    : selected === b.id ? "bg-brand-50" : "hover:bg-slate-50"
                }`}>
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
                <section className="border border-slate-200 rounded-md p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm text-slate-900">Prefill from the records</h3>
                      <p className="text-xs text-slate-500">
                        Bank openings from the bank accounts, cash openings from the custodians,
                        receivable openings from the clients. Nothing is posted — review, edit, add.
                      </p>
                    </div>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={buildPrefill}>
                      {prefill ? "Rebuild" : "Prefill"}
                    </Button>
                  </div>
                  {prefillErr && <p className="text-xs text-danger-600">{prefillErr}</p>}
                  {prefill && prefill.length === 0 && (
                    <p className="text-xs text-slate-500">
                      No opening figures are recorded on the bank accounts, cash locations or
                      clients for this company.
                    </p>
                  )}
                  {prefill && prefill.length > 0 && (
                    <>
                      <div className="overflow-x-auto border border-slate-200 rounded-md">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                            <tr>
                              <th className="text-left px-3 py-2">Account</th>
                              <th className="text-left px-3 py-2">Source</th>
                              <th className="text-right px-3 py-2">Debit</th>
                              <th className="text-right px-3 py-2">Credit</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {prefill.map((r, i) => (
                              <tr key={r.key}>
                                <td className="px-3 py-1.5 text-slate-700">{r.account_label}</td>
                                <td className="px-3 py-1.5 text-xs text-slate-500">{r.source}</td>
                                {(["debit", "credit"] as const).map((side) => (
                                  <td key={side} className="px-3 py-1 text-right">
                                    <input
                                      className={FIELD + " w-28 text-right tabular-nums"}
                                      value={String(r[side] || "")}
                                      onChange={(e) => {
                                        const v = Number(e.target.value) || 0;
                                        setPrefill(prefill.map((x, j) => (j === i ? { ...x, [side]: v } : x)));
                                      }}
                                    />
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <Button variant="primary" size="sm" disabled={busy} onClick={insertPrefill}>
                        Add these lines to the batch
                      </Button>
                    </>
                  )}
                </section>
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
