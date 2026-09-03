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

  // Prefill the batch from the balances already recorded operationally, so the
  // same figure is never typed twice. Entering it in two places is how the two
  // copies diverge, and this is the figure every later balance is measured from.
  // Every line is an ordinary draft line: editable, removable, and posted by the
  // same button as a hand-entered one.
  //
  // READING THE BANK FIGURE IS TWO NON-OBVIOUS FACTS ABOUT ONE RELATIONSHIP, AND
  // THEY MUST STAY TOGETHER — separating them is how one of them gets simplified
  // away by someone who can see only the other:
  //
  //   1. `bank_accounts` HAS NO GL COLUMN AT ALL. The account is reached through
  //      the mirror `cash_locations.coa_account_id` — the BANK-type cash_location
  //      that shadows the bank account. There is no bank_accounts.gl_account_id
  //      to "simplify" this into; it does not exist.
  //   2. THE AMOUNT MUST COME FROM `bank_accounts.opening_balance`, never from
  //      the mirror's own. The mirror's `opening_balance` reads 0.00 — the money
  //      lives on the bank row. Reading the mirror is the obvious-looking join,
  //      it succeeds, and it silently posts ZERO for every bank while looking
  //      like a clean answer. Measured on GGS: four banks, 7,271,847 lost.
  //
  // So: account_id from the mirror, amount from the bank row. Cash-in-hand
  // locations are the simple case — both come from the location itself.
  const prefillFromOperational = async () => {
    if (!selected || !companyId) return;
    setBusy(true); setErr(null);
    try {
      const [cli, loc] = await Promise.all([
        supabase.from("clients").select("opening_balance").eq("company_id", companyId),
        supabase
          .from("cash_locations")
          .select("name, location_type, opening_balance, coa_account_id, bank_accounts(opening_balance)")
          .eq("company_id", companyId),
      ]);
      if (cli.error) throw cli.error;
      if (loc.error) throw loc.error;

      const rows: { account_id: string; debit: number; notes: string }[] = [];

      const ar = (cli.data ?? []).reduce((s: number, c: any) => s + Number(c.opening_balance ?? 0), 0);
      const arAcct = accounts.find((a) => a.account_code === "1100");
      if (ar !== 0 && arAcct) {
        const n = (cli.data ?? []).filter((c: any) => Number(c.opening_balance ?? 0) !== 0).length;
        rows.push({ account_id: arAcct.id, debit: ar, notes: `clients.opening_balance — ${n} client${n === 1 ? "" : "s"}` });
      }

      for (const l of (loc.data ?? []) as any[]) {
        if (!l.coa_account_id) continue;
        const isBank = l.location_type === "BANK";
        // See the note above: bank amount from the bank row, NOT l.opening_balance.
        const amt = isBank
          ? Number(l.bank_accounts?.opening_balance ?? 0)
          : Number(l.opening_balance ?? 0);
        if (amt === 0) continue;
        rows.push({
          account_id: l.coa_account_id,
          debit: amt,
          notes: `${isBank ? "bank_accounts" : "cash_locations"}.opening_balance — ${l.name}`,
        });
      }

      if (rows.length === 0) {
        setErr("Nothing to prefill — no bank, cash or client opening balance is recorded yet.");
        return;
      }

      // Balance to Opening Balance Equity, so the batch is postable as it stands.
      const obe = accounts.find((a) => a.account_code === "3200");
      if (!obe) {
        setErr("No 3200 Opening Balance Equity account — the batch cannot be balanced automatically.");
        return;
      }
      const total = rows.reduce((s, r) => s + r.debit, 0);

      const { error } = await supabase.from("opening_balance_lines").insert([
        ...rows.map((r) => ({ batch_id: selected, account_id: r.account_id, branch_id: null, debit: r.debit, credit: 0, notes: r.notes })),
        { batch_id: selected, account_id: obe.id, branch_id: null, debit: 0, credit: total, notes: "Balancing entry" },
      ]);
      if (error) throw error;
      await loadLines();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
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

              {!posted && (
                <div className="flex flex-wrap items-center gap-2 -mt-1">
                  <Button variant="secondary" size="sm" disabled={busy || lines.length > 0} onClick={prefillFromOperational}>
                    Prefill from recorded balances
                  </Button>
                  <span className="text-xs text-slate-500">
                    {lines.length > 0
                      ? "Prefill is available on an empty batch — remove the lines first, or add them by hand."
                      : "Reads bank, cash and client opening balances already recorded, one line each, with its source. Editable before posting."}
                  </span>
                </div>
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
                        <td className="px-3 py-1.5 text-slate-700">
                          {acctName.get(l.account_id) ?? "—"}
                          {/* Where the figure came from, per line — so a
                              prefilled batch can be checked against its source
                              without leaving the screen. */}
                          {l.notes && <div className="text-[11px] text-slate-400">{l.notes}</div>}
                        </td>
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

              {/* ORDERING IS LOAD-BEARING: post this batch BEFORE recording any
                  receipt against an opening balance.
                  A receipt with no invoice posts Dr Bank/Cash, Cr 1100 — it
                  clears the opening rather than settling a document. If the
                  opening is not in 1100 yet, that credit drives the receivable
                  control NEGATIVE, and ar_control_equals_open_invoices then
                  reports a gap in the wrong direction. Measured: a 500,000
                  receipt against a client whose opening had not posted took
                  1100 to −465,000.
                  Openings first, then receipts. */}
              {!posted && (
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" disabled={busy || !balanced || lines.length === 0}
                    onClick={() => run(supabase.rpc("post_opening_balances", { p_batch_id: selected }))}>
                    Post opening balances
                  </Button>
                  {!balanced && <span className="text-xs text-slate-400">Batch must balance before it can be posted.</span>}
                </div>
              )}
              {!posted && lines.length > 0 && balanced && (
                <p className="text-xs text-slate-500">
                  Post this before recording receipts against an opening balance — a receipt credits
                  the receivable control, so it would go negative if the opening is not in the ledger yet.
                </p>
              )}
              {posted && <p className="text-xs text-success-600">Posted — seeded into the ledger via journal entry.</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
