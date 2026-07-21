import { useCallback, useEffect, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";

// §4.1 fixed-asset register & depreciation + §20 vehicles/fuel and ammunition
// accounting. Capital purchases capitalise (not expensed); depreciation posts
// to the asset's region; ammo discrepancies are a blocking signal.

type Tab = "assets" | "vehicles" | "ammo";
const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";
const CATEGORIES = ["weapons", "vehicles", "equipment", "furniture", "it_equipment"] as const;
const money = (n: any) => Number(n ?? 0).toLocaleString();
const monthStart = () => new Date().toISOString().slice(0, 8) + "01";

export default function Assets() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [tab, setTab] = useState<Tab>("assets");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [assets, setAssets] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [vehicleCost, setVehicleCost] = useState<any[]>([]);
  const [ammo, setAmmo] = useState<any[]>([]);
  const [discrepancies, setDiscrepancies] = useState<any[]>([]);
  const [weapons, setWeapons] = useState<any[]>([]);

  const [na, setNa] = useState({ name: "", category: "equipment", cost: "", salvage_value: "0", useful_life_months: "60", acquisition_date: new Date().toISOString().slice(0, 10) });
  const [nv, setNv] = useState({ registration_no: "", make: "", model: "" });
  const [depPeriod, setDepPeriod] = useState(monthStart());

  const load = useCallback(async () => {
    if (!companyId) return;
    const [fa, vh, vc, am, dc, wp] = await Promise.all([
      supabase.from("fixed_assets_register").select("*").eq("company_id", companyId).order("acquisition_date", { ascending: false }),
      supabase.from("vehicles").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
      supabase.from("vehicle_monthly_cost").select("*").eq("company_id", companyId),
      supabase.from("ammunition_counts").select("*").eq("company_id", companyId).order("count_date", { ascending: false }),
      supabase.from("ammunition_discrepancies").select("*").eq("company_id", companyId),
      supabase.from("inventory_items").select("id, item_type, serial_number").eq("company_id", companyId).eq("kind", "weapon"),
    ]);
    setAssets(fa.data ?? []);
    setVehicles(vh.data ?? []);
    setVehicleCost(vc.data ?? []);
    setAmmo(am.data ?? []);
    setDiscrepancies(dc.data ?? []);
    setWeapons(wp.data ?? []);
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

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Assets" subtitle="Fixed-asset register & depreciation, vehicles, ammunition" />

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {([["assets", "Fixed Assets"], ["vehicles", "Vehicles"], ["ammo", `Ammunition${discrepancies.length ? ` (${discrepancies.length}!)` : ""}`]] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {label}
          </button>
        ))}
      </div>

      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      {tab === "assets" && (
        <div className="space-y-4">
          <section className="border border-slate-200 rounded-md p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm text-slate-900">New asset (capitalised)</h3>
              <div className="flex items-center gap-2">
                <input type="date" className={FIELD} value={depPeriod} onChange={(e) => setDepPeriod(e.target.value)} title="Depreciation period" />
                <Button variant="secondary" size="sm" disabled={busy}
                  onClick={() => run(supabase.rpc("run_depreciation", { p_company_id: companyId, p_period: depPeriod }))}>
                  Run depreciation
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <input className={FIELD} placeholder="Name" value={na.name} onChange={(e) => setNa({ ...na, name: e.target.value })} />
              <select className={FIELD} value={na.category} onChange={(e) => setNa({ ...na, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
              </select>
              <input type="date" className={FIELD} value={na.acquisition_date} onChange={(e) => setNa({ ...na, acquisition_date: e.target.value })} />
              <input className={FIELD} placeholder="Cost" value={na.cost} onChange={(e) => setNa({ ...na, cost: e.target.value })} />
              <input className={FIELD} placeholder="Salvage value" value={na.salvage_value} onChange={(e) => setNa({ ...na, salvage_value: e.target.value })} />
              <input className={FIELD} placeholder="Life (months)" value={na.useful_life_months} onChange={(e) => setNa({ ...na, useful_life_months: e.target.value })} />
            </div>
            <div className="mt-2">
              <Button variant="primary" size="sm" disabled={busy || !na.name || !na.cost}
                onClick={async () => {
                  if (await run(supabase.from("fixed_assets").insert({
                    name: na.name, category: na.category, acquisition_date: na.acquisition_date,
                    cost: Number(na.cost), salvage_value: Number(na.salvage_value || 0),
                    useful_life_months: Number(na.useful_life_months || 1),
                  }))) setNa({ name: "", category: "equipment", cost: "", salvage_value: "0", useful_life_months: "60", acquisition_date: new Date().toISOString().slice(0, 10) });
                }}>
                Capitalise asset
              </Button>
            </div>
          </section>

          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Asset</th>
                  <th className="text-left px-3 py-2">Region</th>
                  <th className="text-right px-3 py-2">Cost</th>
                  <th className="text-right px-3 py-2">Accum. dep</th>
                  <th className="text-right px-3 py-2">NBV</th>
                  <th className="text-center px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {assets.map((a) => (
                  <tr key={a.id}>
                    <td className="px-3 py-1.5 text-slate-700">{a.name} <span className="text-xs text-slate-400 capitalize">{String(a.category).replace(/_/g, " ")}</span></td>
                    <td className="px-3 py-1.5 text-slate-500">{a.region_name ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(a.cost)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(a.accumulated_depreciation)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(a.net_book_value)}</td>
                    <td className="px-3 py-1.5 text-center text-xs capitalize">{a.status}</td>
                    <td className="px-3 py-1.5 text-right">
                      {a.status === "active" && (
                        <Button variant="secondary" size="sm" disabled={busy}
                          onClick={() => run(supabase.rpc("dispose_fixed_asset", { p_asset_id: a.id, p_disposal_date: new Date().toISOString().slice(0, 10), p_proceeds: 0 }))}>
                          Dispose
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {assets.length === 0 && <tr><td colSpan={7} className="px-3 py-3 text-slate-500">No assets.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "vehicles" && (
        <div className="space-y-4">
          <section className="border border-slate-200 rounded-md p-3">
            <h3 className="text-sm text-slate-900 mb-2">New vehicle</h3>
            <div className="flex items-center gap-2 flex-wrap">
              <input className={FIELD} placeholder="Registration no." value={nv.registration_no} onChange={(e) => setNv({ ...nv, registration_no: e.target.value })} />
              <input className={FIELD} placeholder="Make" value={nv.make} onChange={(e) => setNv({ ...nv, make: e.target.value })} />
              <input className={FIELD} placeholder="Model" value={nv.model} onChange={(e) => setNv({ ...nv, model: e.target.value })} />
              <Button variant="primary" size="sm" disabled={busy || !nv.registration_no}
                onClick={async () => {
                  if (await run(supabase.from("vehicles").insert({ registration_no: nv.registration_no, make: nv.make || null, model: nv.model || null })))
                    setNv({ registration_no: "", make: "", model: "" });
                }}>Add vehicle</Button>
            </div>
          </section>
          {vehicles.length > 0 && <VehicleLogForm companyId={companyId} vehicles={vehicles} run={run} busy={busy} />}
          <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
            {vehicles.map((v) => {
              const cost = vehicleCost.filter((c) => c.vehicle_id === v.id).reduce((s, c) => s + Number(c.total_cost ?? 0), 0);
              return (
                <div key={v.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-slate-700">{v.registration_no} · {v.make} {v.model}</span>
                  <span className="text-slate-500 tabular-nums">running cost {money(cost)}</span>
                </div>
              );
            })}
            {vehicles.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No vehicles.</p>}
          </div>
        </div>
      )}

      {tab === "ammo" && (
        <div className="space-y-4">
          {discrepancies.length > 0 && (
            <div className="flex items-center justify-between rounded-md border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700">
              <span>{discrepancies.length} open ammunition discrepancy(ies) — blocking-tier.</span>
              <Button variant="secondary" size="sm" disabled={busy}
                onClick={() => run(supabase.rpc("sweep_ammo_discrepancy_alerts", { p_company_id: companyId }))}>
                Raise blocking alerts
              </Button>
            </div>
          )}
          <AmmoAdd companyId={companyId} weapons={weapons} run={run} busy={busy} />
          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Date</th>
                  <th className="text-right px-3 py-2">Issued</th>
                  <th className="text-right px-3 py-2">Accounted</th>
                  <th className="text-right px-3 py-2">Discrepancy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ammo.map((a) => (
                  <tr key={a.id} className={Number(a.discrepancy) !== 0 && !a.resolved ? "bg-danger-50" : ""}>
                    <td className="px-3 py-1.5 text-slate-500">{a.count_date}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{a.issued_rounds}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{a.accounted_rounds}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${Number(a.discrepancy) !== 0 ? "text-danger-700 font-medium" : ""}`}>{a.discrepancy}</td>
                  </tr>
                ))}
                {ammo.length === 0 && <tr><td colSpan={4} className="px-3 py-3 text-slate-500">No ammunition counts.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function VehicleLogForm({ companyId, vehicles, run, busy }: { companyId: string; vehicles: any[]; run: (p: PromiseLike<{ error: { message: string } | null }>) => Promise<boolean>; busy: boolean }) {
  const [vid, setVid] = useState("");
  const [logType, setLogType] = useState("fuel");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [odometer, setOdometer] = useState("");
  const [litres, setLitres] = useState("");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const submit = async () => {
    if (!vid) return;
    const veh = vehicles.find((v) => v.id === vid);
    const ok = await run(supabase.from("vehicle_logs").insert({
      company_id: companyId, vehicle_id: vid, branch_id: veh?.branch_id ?? null,
      log_type: logType, log_date: date,
      odometer: odometer ? Number(odometer) : null,
      litres: litres ? Number(litres) : null,
      amount: amount ? Number(amount) : null,
      description: desc || null,
    }));
    if (ok) { setOdometer(""); setLitres(""); setAmount(""); setDesc(""); }
  };
  return (
    <section className="border border-slate-200 rounded-md p-3 bg-slate-50/50">
      <h3 className="text-sm text-slate-900 mb-2">Log trip / fuel / maintenance</h3>
      <div className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end">
        <div className="col-span-2"><label className="text-xs text-slate-500 block mb-1">Vehicle</label>
          <select className={FIELD + " w-full"} value={vid} onChange={(e) => setVid(e.target.value)}>
            <option value="">— vehicle —</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.registration_no}</option>)}
          </select></div>
        <div><label className="text-xs text-slate-500 block mb-1">Type</label>
          <select className={FIELD + " w-full"} value={logType} onChange={(e) => setLogType(e.target.value)}>
            {["fuel", "trip", "maintenance"].map((t) => <option key={t} value={t}>{t}</option>)}
          </select></div>
        <div><label className="text-xs text-slate-500 block mb-1">Date</label>
          <input type="date" className={FIELD + " w-full"} value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label className="text-xs text-slate-500 block mb-1">Odometer</label>
          <input className={FIELD + " w-full"} value={odometer} onChange={(e) => setOdometer(e.target.value)} placeholder="km" /></div>
        {logType === "fuel" && <div><label className="text-xs text-slate-500 block mb-1">Litres</label>
          <input className={FIELD + " w-full"} value={litres} onChange={(e) => setLitres(e.target.value)} placeholder="L" /></div>}
        <div><label className="text-xs text-slate-500 block mb-1">Amount</label>
          <input className={FIELD + " w-full"} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="PKR" /></div>
      </div>
      <div className="mt-2 flex items-end gap-2">
        <input className={FIELD + " flex-1"} placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <Button variant="primary" size="sm" disabled={busy || !vid} onClick={submit}>Add log</Button>
      </div>
    </section>
  );
}

function AmmoAdd({ companyId, weapons, run, busy }: { companyId: string; weapons: any[]; run: (p: PromiseLike<{ error: { message: string } | null }>) => Promise<boolean>; busy: boolean }) {
  const [wid, setWid] = useState("");
  const [issued, setIssued] = useState("");
  const [accounted, setAccounted] = useState("");
  return (
    <section className="border border-slate-200 rounded-md p-3">
      <h3 className="text-sm text-slate-900 mb-2">Record ammunition count</h3>
      <div className="flex items-center gap-2 flex-wrap">
        <select className={FIELD} value={wid} onChange={(e) => setWid(e.target.value)}>
          <option value="">— weapon —</option>
          {weapons.map((w) => <option key={w.id} value={w.id}>{w.item_type}{w.serial_number ? ` #${w.serial_number}` : ""}</option>)}
        </select>
        <input className={FIELD + " w-28"} placeholder="Issued" value={issued} onChange={(e) => setIssued(e.target.value)} />
        <input className={FIELD + " w-28"} placeholder="Accounted" value={accounted} onChange={(e) => setAccounted(e.target.value)} />
        <Button variant="primary" size="sm" disabled={busy || !wid || !issued}
          onClick={async () => {
            if (await run(supabase.from("ammunition_counts").insert({
              weapon_item_id: wid, issued_rounds: Number(issued || 0), accounted_rounds: Number(accounted || 0),
            }))) { setWid(""); setIssued(""); setAccounted(""); }
          }}>Record</Button>
      </div>
    </section>
  );
}
