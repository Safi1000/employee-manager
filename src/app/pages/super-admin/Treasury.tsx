import { useCallback, useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase, type Branch } from "../../lib/supabase";

// Treasury & Regional Finance — the read/act surface over the finance backend:
// §9 cash cockpit / reserves / danger / forecast, §6 regional P&L + HO cost
// allocation, §8 cash entitlements, §7 inter-region loans.

type Tab = "cockpit" | "regional" | "reserves" | "interregion" | "capital";

const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";
const BAND: Record<string, string> = {
  green: "bg-success-50 text-success-700 border-success-200",
  amber: "bg-warning-50 text-warning-700 border-warning-200",
  red: "bg-danger-50 text-danger-700 border-danger-200",
};
const money = (n: any) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const thisMonthStart = () => new Date().toISOString().slice(0, 8) + "01";

export default function Treasury() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [tab, setTab] = useState<Tab>("cockpit");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [cockpit, setCockpit] = useState<any>(null);
  const [danger, setDanger] = useState<any>(null);
  const [reserves, setReserves] = useState<any[]>([]);
  const [pnl, setPnl] = useState<any[]>([]);
  const [entitlements, setEntitlements] = useState<any[]>([]);
  const [interregion, setInterregion] = useState<any[]>([]);
  const [forecast, setForecast] = useState<any[]>([]);
  const [capital, setCapital] = useState<any[]>([]);
  const [custody, setCustody] = useState<any[]>([]);
  const [period, setPeriod] = useState(thisMonthStart());

  const load = useCallback(async () => {
    if (!companyId) return;
    const [br, cc, dl, rs, pn, ent, ir, fc, pc, cl] = await Promise.all([
      supabase.from("branches").select("*").eq("company_id", companyId).order("is_head_office", { ascending: false }).order("name"),
      supabase.from("cash_cockpit").select("*").eq("company_id", companyId).maybeSingle(),
      supabase.from("danger_level").select("*").eq("company_id", companyId).maybeSingle(),
      supabase.from("reserve_status").select("*").eq("company_id", companyId),
      supabase.from("regional_pnl_monthly").select("*").eq("company_id", companyId).order("period_month", { ascending: false }),
      supabase.from("cash_entitlements").select("*").eq("company_id", companyId),
      supabase.from("interregion_transactions").select("*").eq("company_id", companyId).order("txn_date", { ascending: false }),
      supabase.rpc("cash_forecast", { p_company_id: companyId, p_weeks: 13 }),
      supabase.from("partner_capital_balances").select("*").eq("company_id", companyId),
      supabase.from("cash_location_balances").select("*").eq("company_id", companyId),
    ]);
    setBranches((br.data ?? []) as Branch[]);
    setCockpit(cc.data);
    setDanger(dl.data);
    setReserves(rs.data ?? []);
    setPnl(pn.data ?? []);
    setEntitlements(ent.data ?? []);
    setInterregion(ir.data ?? []);
    setForecast((fc.data as any[]) ?? []);
    setCapital(pc.data ?? []);
    setCustody(cl.data ?? []);
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setErr(null);
    const { error } = await p;
    setBusy(false);
    if (error) { setErr(error.message); return false; }
    await load();
    return true;
  };

  const branchName = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches]);
  const firstBreach = forecast.find((w) => w.is_breach);

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Treasury & Regional Finance" subtitle="Cash cockpit, reserves, regional P&L, inter-region loans" />

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {([
          ["cockpit", "Cash Cockpit"],
          ["regional", "Regional P&L"],
          ["reserves", "Reserves"],
          ["interregion", "Inter-region"],
          ["capital", "Capital & Custody"],
        ] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {label}
          </button>
        ))}
      </div>

      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      {/* ===== Cash Cockpit ===== */}
      {tab === "cockpit" && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Gross cash" value={`PKR ${money(cockpit?.gross_cash)}`} />
            <Stat label="Reserves" value={`PKR ${money(cockpit?.reserves)}`} />
            <Stat label="Available after reserves" value={`PKR ${money(cockpit?.available_after_reserves)}`} />
            <Stat label="Days of runway" value={cockpit?.days_runway ?? "—"} />
          </div>

          {danger && (
            <div className={`rounded-md border p-3 flex items-center justify-between ${BAND[danger.band] ?? ""}`}>
              <div className="text-sm">
                <span className="uppercase font-medium">{danger.band}</span> band ·
                available {money(danger.available_cash)} vs minimum {money(danger.min_cash)}
                {danger.ratio != null && <> · ratio {Number(danger.ratio).toFixed(2)}×</>}
              </div>
              {danger.band === "red" && <span className="text-xs">Non-payroll disbursements require COO override</span>}
            </div>
          )}

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm text-slate-900">13-week cash forecast</h3>
              {firstBreach && <span className="text-xs text-danger-600">First breach: week of {firstBreach.week_start}</span>}
            </div>
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Week</th>
                    <th className="text-right px-3 py-2">Opening</th>
                    <th className="text-right px-3 py-2">Inflow</th>
                    <th className="text-right px-3 py-2">Outflow</th>
                    <th className="text-right px-3 py-2">Closing</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {forecast.map((w) => (
                    <tr key={w.week_no} className={w.is_breach ? "bg-danger-50" : ""}>
                      <td className="px-3 py-1.5 text-slate-700">{w.week_start}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{money(w.opening_balance)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-success-700">{money(w.expected_inflow)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-danger-700">{money(w.expected_outflow)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${Number(w.closing_balance) < 0 ? "text-danger-700 font-medium" : ""}`}>{money(w.closing_balance)}</td>
                    </tr>
                  ))}
                  {forecast.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-slate-500">No forecast data.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3 className="text-sm text-slate-900 mb-2">Cash entitlement by region</h3>
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Region</th>
                    <th className="text-right px-3 py-2">Entitlement</th>
                    <th className="text-right px-3 py-2">Restricted reserve</th>
                    <th className="text-right px-3 py-2">Free</th>
                    <th className="text-right px-3 py-2">Inter-region net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {entitlements.map((e, i) => (
                    <tr key={i}>
                      <td className="px-3 py-1.5 text-slate-700">{e.region_name ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{money(e.entitlement)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{money(e.restricted_reserve)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{money(e.free_entitlement)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{money(e.interregion_net_position)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* ===== Regional P&L ===== */}
      {tab === "regional" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-sm text-slate-600">Month</label>
            <input type="date" className={FIELD} value={period} onChange={(e) => setPeriod(e.target.value)} />
            <Button variant="secondary" size="sm" disabled={busy}
              onClick={() => run(supabase.rpc("run_ho_cost_allocation", { p_company_id: companyId, p_period: period }))}>
              Run HO cost allocation
            </Button>
            <Button variant="secondary" size="sm" disabled={busy}
              onClick={() => run(supabase.rpc("accrue_bonus_reserve", { p_company_id: companyId, p_period: period }))}>
              Accrue bonus reserve
            </Button>
            <Button variant="secondary" size="sm" disabled={busy}
              onClick={() => run(supabase.rpc("mirror_depreciation_to_reserve", { p_company_id: companyId, p_period: period }))}>
              Mirror depreciation → reserve
            </Button>
          </div>
          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Month</th>
                  <th className="text-left px-3 py-2">Region</th>
                  <th className="text-right px-3 py-2">Revenue</th>
                  <th className="text-right px-3 py-2">Direct cost</th>
                  <th className="text-right px-3 py-2">Allocated HO</th>
                  <th className="text-right px-3 py-2">Net profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pnl.map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1.5 text-slate-500">{String(r.period_month).slice(0, 7)}</td>
                    <td className="px-3 py-1.5 text-slate-700">{r.region_name ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(r.revenue)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(r.direct_cost)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(r.allocated_ho_cost)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${Number(r.net_profit) < 0 ? "text-danger-700" : "text-success-700"}`}>{money(r.net_profit)}</td>
                  </tr>
                ))}
                {pnl.length === 0 && <tr><td colSpan={6} className="px-3 py-3 text-slate-500">No P&L data.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400">Run HO allocation before pools/accrual so regional profit is stated after head-office cost.</p>
        </div>
      )}

      {/* ===== Reserves ===== */}
      {tab === "reserves" && (
        <div className="space-y-4">
          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Reserve</th>
                  <th className="text-right px-3 py-2">Balance</th>
                  <th className="text-right px-3 py-2">Target</th>
                  <th className="text-right px-3 py-2">Shortfall</th>
                  <th className="text-right px-3 py-2">Fund</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reserves.map((r) => (
                  <tr key={r.reserve_type}>
                    <td className="px-3 py-1.5 text-slate-700 capitalize">{String(r.reserve_type).replace(/_/g, " ")}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(r.balance)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(r.target)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${Number(r.shortfall) > 0 ? "text-danger-700" : "text-success-700"}`}>{money(r.shortfall)}</td>
                    <td className="px-3 py-1.5 text-right">
                      {Number(r.shortfall) > 0 && (
                        <Button variant="secondary" size="sm" disabled={busy}
                          onClick={() => run(supabase.rpc("fund_reserve", { p_company_id: companyId, p_type: r.reserve_type, p_amount: Number(r.shortfall) }))}>
                          Fund shortfall
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400">Funding sweeps cash into a restricted reserve account (Dr reserve / Cr bank).</p>
        </div>
      )}

      {/* ===== Inter-region ===== */}
      {tab === "interregion" && (
        <InterRegionTab companyId={companyId} branches={branches} branchName={branchName} txns={interregion} run={run} busy={busy} />
      )}

      {/* ===== Capital & Custody (§4.2 / §4.3, ledger-derived) ===== */}
      {tab === "capital" && (
        <div className="grid md:grid-cols-2 gap-6">
          <section>
            <h3 className="text-sm text-slate-900 mb-2">Partner capital (from ledger)</h3>
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Partner</th>
                    <th className="text-left px-3 py-2">Region</th>
                    <th className="text-right px-3 py-2">Capital balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {capital.map((p) => (
                    <tr key={p.partner_id}>
                      <td className="px-3 py-1.5 text-slate-700">{p.name}<span className="text-xs text-slate-400 ml-2 capitalize">{p.scope}</span></td>
                      <td className="px-3 py-1.5 text-slate-500">{p.region_name ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{money(p.capital_balance)}</td>
                    </tr>
                  ))}
                  {capital.length === 0 && <tr><td colSpan={3} className="px-3 py-3 text-slate-500">No partner capital accounts.</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-400 mt-1">Balances are derived from the equity sub-ledger, not the stored opening figure.</p>
          </section>
          <section>
            <h3 className="text-sm text-slate-900 mb-2">Cash sub-ledgers</h3>
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Location</th>
                    <th className="text-left px-3 py-2">Region</th>
                    <th className="text-right px-3 py-2">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {custody.map((c) => (
                    <tr key={c.cash_location_id}>
                      <td className="px-3 py-1.5 text-slate-700">{c.name}<span className="text-xs text-slate-400 ml-2">{c.location_type}</span></td>
                      <td className="px-3 py-1.5 text-slate-500">{c.region_name ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{money(c.balance)}</td>
                    </tr>
                  ))}
                  {custody.length === 0 && <tr><td colSpan={3} className="px-3 py-3 text-slate-500">No cash locations.</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-400 mt-1">Each cash box reconciles to its own COA sub-account.</p>
          </section>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div className="border border-slate-200 rounded-md p-3 bg-white">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg text-slate-900 tabular-nums mt-1">{value}</div>
    </div>
  );
}

function InterRegionTab({
  companyId, branches, branchName, txns, run, busy,
}: {
  companyId: string;
  branches: Branch[];
  branchName: Map<string, string>;
  txns: any[];
  run: (p: PromiseLike<{ error: { message: string } | null }>) => Promise<boolean>;
  busy: boolean;
}) {
  const [lender, setLender] = useState("");
  const [borrower, setBorrower] = useState("");
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  // Inter-region funding requires an approved request (COO). Create the request
  // here; it must be approved in Governance before fund_region will execute.
  const requestFunding = async () => {
    setMsg(null);
    if (!lender || !borrower || !amount) return;
    const { error } = await supabase.rpc("request_approval", {
      p_company_id: companyId, p_action_key: "interregion_funding",
      p_ref_table: "interregion_transactions", p_ref_id: crypto.randomUUID(),
      p_amount: Number(amount),
      p_payload: { lender, borrower },
    });
    if (error) setMsg(error.message);
    else setMsg("Funding request submitted for COO approval (see Governance).");
  };

  return (
    <div className="space-y-4">
      <section className="border border-slate-200 rounded-md p-3 space-y-2">
        <h3 className="text-sm text-slate-900">Request inter-region funding</h3>
        <div className="flex items-center gap-2 flex-wrap">
          <select className={FIELD} value={lender} onChange={(e) => setLender(e.target.value)}>
            <option value="">— lender region —</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <span className="text-slate-400">→</span>
          <select className={FIELD} value={borrower} onChange={(e) => setBorrower(e.target.value)}>
            <option value="">— borrower region —</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input className={FIELD + " w-32"} placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Button variant="primary" size="sm" disabled={busy || !lender || !borrower || !amount} onClick={requestFunding}>
            Request approval
          </Button>
        </div>
        {msg && <p className="text-xs text-slate-500">{msg}</p>}
        <p className="text-xs text-slate-400">Funding posts only after COO approval; a repayment nets the balance down.</p>
      </section>

      <section>
        <h3 className="text-sm text-slate-900 mb-2">Transactions</h3>
        <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
          {txns.map((t) => (
            <div key={t.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-slate-700">
                {branchName.get(t.lender_branch_id) ?? "?"} → {branchName.get(t.borrower_branch_id) ?? "?"} · {t.txn_type}
              </span>
              <span className="tabular-nums text-slate-800">{Number(t.amount ?? 0).toLocaleString()} · {t.txn_date}</span>
            </div>
          ))}
          {txns.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No inter-region transactions.</p>}
        </div>
      </section>
    </div>
  );
}
