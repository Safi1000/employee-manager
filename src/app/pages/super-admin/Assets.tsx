import Picker from "./_assetsPicker";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Building2, Calculator, Car, Crosshair, Fuel, Landmark, Plus, TrendingDown, Wallet,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import StatCard from "../../components/StatCard";
import Badge from "../../components/Badge";
import Tabs from "../../components/Tabs";
import ResponsiveTable, { type Column } from "../../components/ResponsiveTable";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { usePageState } from "../../lib/pageState";
import { formatDate } from "../../lib/date";
import {
  ChoiceCards, FormField, FormSection, Hint, ModalFooter, Notice, PageBody, Panel, Pills, SubjectCard,
  inputCls, money,
} from "./_assetsKit";

// §4.1 fixed-asset register & depreciation + §20 vehicles/fuel and ammunition
// accounting. Capital purchases capitalise (not expensed); depreciation posts
// to the asset's region; ammo discrepancies are a blocking signal.

type Tab = "assets" | "vehicles" | "ammo";
type Dialog = null | "capitalise" | "depreciate" | "vehicle" | "vehicleLog" | "ammo" | { dispose: any };
const CATEGORIES = ["weapons", "vehicles", "equipment", "furniture", "it_equipment"] as const;
const monthStart = () => new Date().toISOString().slice(0, 8) + "01";
const today = () => new Date().toISOString().slice(0, 10);
const label = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

type Run = (p: PromiseLike<{ error: { message: string } | null }>) => Promise<boolean>;

export default function Assets() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [tab, setTab] = usePageState<Tab>("Assets.tab", "assets");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  const [assets, setAssets] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [vehicleCost, setVehicleCost] = useState<any[]>([]);
  const [ammo, setAmmo] = useState<any[]>([]);
  const [discrepancies, setDiscrepancies] = useState<any[]>([]);
  const [weapons, setWeapons] = useState<any[]>([]);

  const [na, setNa] = useState({ name: "", category: "equipment", cost: "", salvage_value: "0", useful_life_months: "60", acquisition_date: today() });
  const [nv, setNv] = useState({ registration_no: "", make: "", model: "" });
  const [depPeriod, setDepPeriod] = usePageState("Assets.depPeriod", monthStart());

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

  const run: Run = async (p) => {
    setBusy(true); setErr(null);
    const { error } = await p;
    setBusy(false);
    if (error) { setErr(error.message); return false; }
    await load();
    return true;
  };
  const open = (d: Dialog) => { setErr(null); setDialog(d); };
  const close = () => { setDialog(null); setErr(null); };

  // Stat figures — each the sum of the rows its table lists.
  const totals = useMemo(() => ({
    cost: assets.reduce((a, x) => a + Number(x.cost ?? 0), 0),
    dep: assets.reduce((a, x) => a + Number(x.accumulated_depreciation ?? 0), 0),
    nbv: assets.reduce((a, x) => a + Number(x.net_book_value ?? 0), 0),
    active: assets.filter((x) => x.status === "active").length,
  }), [assets]);
  const costByVehicle = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of vehicleCost) m.set(c.vehicle_id, (m.get(c.vehicle_id) ?? 0) + Number(c.total_cost ?? 0));
    return m;
  }, [vehicleCost]);
  const fleetCost = useMemo(() => [...costByVehicle.values()].reduce((a, b) => a + b, 0), [costByVehicle]);
  const openDisc = ammo.filter((a) => Number(a.discrepancy) !== 0 && !a.resolved).length;

  const assetCols: Column<any>[] = [
    { key: "name", header: "Asset", primary: true, cell: (a) => (
      <div>
        <div className="font-medium">{a.name}</div>
        <div className="text-[11px] text-muted-foreground">{label(String(a.category))}{a.acquisition_date ? ` · ${formatDate(a.acquisition_date)}` : ""}</div>
      </div>
    ) },
    { key: "region", header: "Region", cell: (a) => <span className="text-muted-foreground">{a.region_name ?? "—"}</span> },
    { key: "cost", header: "Cost", className: "text-right tabular-nums", cell: (a) => money(a.cost) },
    { key: "dep", header: "Accum. dep", className: "text-right tabular-nums", cell: (a) => money(a.accumulated_depreciation) },
    { key: "nbv", header: "Net book value", className: "text-right tabular-nums font-medium", cell: (a) => money(a.net_book_value) },
    { key: "status", header: "Status", cell: (a) => (
      <Badge tone={a.status === "active" ? "success" : "neutral"} className="capitalize">{a.status}</Badge>
    ) },
  ];
  const vehicleCols: Column<any>[] = [
    { key: "reg", header: "Registration", primary: true, cell: (v) => <span className="font-medium font-mono">{v.registration_no}</span> },
    { key: "make", header: "Make / model", cell: (v) => [v.make, v.model].filter(Boolean).join(" ") || <span className="text-muted-foreground">—</span> },
    { key: "cost", header: "Running cost", className: "text-right tabular-nums font-medium", cell: (v) => `PKR ${money(costByVehicle.get(v.id) ?? 0)}` },
  ];
  const ammoCols: Column<any>[] = [
    { key: "date", header: "Date", primary: true, cell: (a) => formatDate(a.count_date) },
    { key: "issued", header: "Issued", className: "text-right tabular-nums", cell: (a) => a.issued_rounds },
    { key: "acc", header: "Accounted", className: "text-right tabular-nums", cell: (a) => a.accounted_rounds },
    { key: "disc", header: "Discrepancy", className: "text-right", cell: (a) => Number(a.discrepancy) !== 0
      ? <Badge tone={a.resolved ? "neutral" : "danger"}>{a.discrepancy}{a.resolved ? " · resolved" : ""}</Badge>
      : <span className="text-muted-foreground tabular-nums">0</span> },
  ];

  const actions = tab === "assets" ? (
    <>
      <Button variant="secondary" size="md" onClick={() => open("depreciate")}>
        <Calculator className="w-4 h-4" /> Run depreciation
      </Button>
      <Button variant="primary" size="md" onClick={() => open("capitalise")}>
        <Plus className="w-4 h-4" /> Capitalise asset
      </Button>
    </>
  ) : tab === "vehicles" ? (
    <>
      {vehicles.length > 0 && (
        <Button variant="secondary" size="md" onClick={() => open("vehicleLog")}>
          <Fuel className="w-4 h-4" /> Log trip / fuel
        </Button>
      )}
      <Button variant="primary" size="md" onClick={() => open("vehicle")}>
        <Plus className="w-4 h-4" /> Add vehicle
      </Button>
    </>
  ) : (
    <Button variant="primary" size="md" onClick={() => open("ammo")}>
      <Plus className="w-4 h-4" /> Record count
    </Button>
  );

  return (
    <>
      <Header title="Register" subtitle="Fixed-asset register & depreciation, vehicles, ammunition" actions={actions} />

      <PageBody>
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: "assets", label: "Fixed assets", count: assets.length },
            { value: "vehicles", label: "Vehicles", count: vehicles.length },
            { value: "ammo", label: <>Ammunition{discrepancies.length ? <AlertTriangle className="w-3.5 h-3.5 text-danger-600" /> : null}</>, count: ammo.length },
          ]}
        />

        {err && !dialog && <Notice kind="error" onClose={() => setErr(null)}>{err}</Notice>}

        {tab === "assets" && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
              <StatCard title="Cost" value={`PKR ${money(totals.cost)}`} icon={Landmark} tone="brand" />
              <StatCard title="Accumulated dep." value={`PKR ${money(totals.dep)}`} icon={TrendingDown} tone="warning" />
              <StatCard title="Net book value" value={`PKR ${money(totals.nbv)}`} icon={Wallet} tone="success" />
              <StatCard title="Active assets" value={totals.active} icon={Building2} tone="neutral" />
            </div>
            <Panel icon={Building2} title="Fixed assets" description="Capitalised, not expensed. Depreciation posts monthly to each asset's region." flush>
              <div className="p-3 md:p-2">
                <ResponsiveTable
                  columns={assetCols}
                  rows={assets}
                  rowKey={(a) => a.id}
                  empty="No assets yet. Capitalise the first one from the button above."
                  actions={(a) => a.status === "active" ? (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => open({ dispose: a })}>Dispose</Button>
                  ) : null}
                />
              </div>
            </Panel>
          </>
        )}

        {tab === "vehicles" && (
          <>
            <div className="grid grid-cols-2 gap-3 md:gap-4">
              <StatCard title="Vehicles" value={vehicles.length} icon={Car} tone="brand" />
              <StatCard title="Running cost" value={`PKR ${money(fleetCost)}`} icon={Fuel} tone="info" />
            </div>
            <Panel icon={Car} title="Fleet" description="Running cost is fuel, trips and maintenance logged against each vehicle." flush>
              <div className="p-3 md:p-2">
                <ResponsiveTable columns={vehicleCols} rows={vehicles} rowKey={(v) => v.id}
                                 empty="No vehicles yet. Add one from the button above." />
              </div>
            </Panel>
          </>
        )}

        {tab === "ammo" && (
          <>
            {discrepancies.length > 0 && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-danger-200 bg-danger-50 px-4 py-3">
                <div className="flex items-start gap-2 text-sm text-danger-700 dark:text-danger-500">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{discrepancies.length} open ammunition discrepanc{discrepancies.length === 1 ? "y" : "ies"} — blocking-tier.</span>
                </div>
                <Button variant="danger" size="sm" disabled={busy}
                  onClick={() => run(supabase.rpc("sweep_ammo_discrepancy_alerts", { p_company_id: companyId }))}>
                  Raise blocking alerts
                </Button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 md:gap-4">
              <StatCard title="Counts recorded" value={ammo.length} icon={Crosshair} tone="brand" />
              <StatCard title="Open discrepancies" value={openDisc} icon={AlertTriangle} tone={openDisc ? "danger" : "success"} />
            </div>
            <Panel icon={Crosshair} title="Ammunition counts" description="Rounds issued against rounds accounted for. Any difference is a blocking signal." flush>
              <div className="p-3 md:p-2">
                <ResponsiveTable columns={ammoCols} rows={ammo} rowKey={(a) => a.id}
                                 empty="No ammunition counts yet." />
              </div>
            </Panel>
          </>
        )}
      </PageBody>

      {/* ---- CAPITALISE ---- */}
      {dialog === "capitalise" && (
        <Modal isOpen onClose={close} title="Capitalise an asset" size="md" error={err} onDismissError={() => setErr(null)}
          footer={
            <ModalFooter>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button disabled={busy || !na.name || !na.cost}
                onClick={async () => {
                  // Routed through capitalise_fixed_asset (0483, accounting.edit):
                  // capitalising posts a GL entry, so it's an accounting act, not a
                  // raw inventory write.
                  if (await run(supabase.rpc("capitalise_fixed_asset", {
                    p_name: na.name, p_category: na.category, p_acquisition_date: na.acquisition_date,
                    p_cost: Number(na.cost), p_salvage_value: Number(na.salvage_value || 0),
                    p_useful_life_months: Number(na.useful_life_months || 1),
                  }))) {
                    setNa({ name: "", category: "equipment", cost: "", salvage_value: "0", useful_life_months: "60", acquisition_date: today() });
                    setDialog(null);
                  }
                }}>
                {busy ? "Capitalising…" : "Capitalise asset"}
              </Button>
            </ModalFooter>
          }>
          <div className="space-y-6">
            <FormSection step={1} title="The asset">
              <FormField label="Name" required>
                <input className={inputCls} autoFocus value={na.name} placeholder="e.g. Head office generator"
                       onChange={(e) => setNa({ ...na, name: e.target.value })} />
              </FormField>
              <FormField label="Category" required>
                <ChoiceCards columns={3} value={na.category} onChange={(c) => setNa({ ...na, category: c })}
                             options={CATEGORIES.map((c) => ({ value: c, label: label(c) }))} />
              </FormField>
              <FormField label="Acquired on" required>
                <input type="date" className={inputCls + " sm:max-w-[13rem]"} value={na.acquisition_date}
                       onChange={(e) => setNa({ ...na, acquisition_date: e.target.value })} />
              </FormField>
            </FormSection>
            <FormSection step={2} title="Depreciation">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <FormField label="Cost (PKR)" required>
                  <input className={inputCls} type="number" min={0} value={na.cost} onChange={(e) => setNa({ ...na, cost: e.target.value })} />
                </FormField>
                <FormField label="Salvage value (PKR)">
                  <input className={inputCls} type="number" min={0} value={na.salvage_value} onChange={(e) => setNa({ ...na, salvage_value: e.target.value })} />
                </FormField>
                <FormField label="Life (months)" required>
                  <input className={inputCls} type="number" min={1} value={na.useful_life_months} onChange={(e) => setNa({ ...na, useful_life_months: e.target.value })} />
                </FormField>
              </div>
              {Number(na.cost) > 0 && Number(na.useful_life_months) > 0 && (
                <Hint>
                  About <span className="font-medium text-foreground">PKR {money(Math.round((Number(na.cost) - Number(na.salvage_value || 0)) / Number(na.useful_life_months)))}</span> a month, straight-line.
                </Hint>
              )}
            </FormSection>
          </div>
        </Modal>
      )}

      {/* ---- RUN DEPRECIATION ---- */}
      {dialog === "depreciate" && (
        <Modal isOpen onClose={close} title="Run depreciation" size="sm" error={err} onDismissError={() => setErr(null)}
          footer={
            <ModalFooter>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button disabled={busy || !depPeriod}
                onClick={async () => {
                  if (await run(supabase.rpc("run_depreciation", { p_company_id: companyId, p_period: depPeriod }))) setDialog(null);
                }}>
                {busy ? "Running…" : "Run depreciation"}
              </Button>
            </ModalFooter>
          }>
          <div className="space-y-4">
            <FormField label="Period" required hint="Posts the month's depreciation for every active asset to its region.">
              <input type="date" className={inputCls} value={depPeriod} onChange={(e) => setDepPeriod(e.target.value)} />
            </FormField>
            <SubjectCard title={`${totals.active} active asset${totals.active === 1 ? "" : "s"}`}
                         meta={`Net book value PKR ${money(totals.nbv)}`} />
          </div>
        </Modal>
      )}

      {/* ---- DISPOSE ---- */}
      {dialog && typeof dialog === "object" && "dispose" in dialog && (
        <Modal isOpen onClose={close} title="Dispose of asset" size="sm" error={err} onDismissError={() => setErr(null)}
          footer={
            <ModalFooter>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="danger" disabled={busy}
                onClick={async () => {
                  if (await run(supabase.rpc("dispose_fixed_asset", { p_asset_id: dialog.dispose.id, p_disposal_date: today(), p_proceeds: 0 }))) setDialog(null);
                }}>
                {busy ? "Disposing…" : "Dispose"}
              </Button>
            </ModalFooter>
          }>
          <div className="space-y-4">
            <SubjectCard title={dialog.dispose.name} meta={label(String(dialog.dispose.category))}
                         aside={<span className="text-sm tabular-nums font-medium">PKR {money(dialog.dispose.net_book_value)}</span>} />
            <Hint tone="warning">
              Disposed today with no proceeds. The remaining net book value is written off and the asset
              stops depreciating. This cannot be undone here.
            </Hint>
          </div>
        </Modal>
      )}

      {/* ---- ADD VEHICLE ---- */}
      {dialog === "vehicle" && (
        <Modal isOpen onClose={close} title="Add a vehicle" size="sm" error={err} onDismissError={() => setErr(null)}
          footer={
            <ModalFooter>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button disabled={busy || !nv.registration_no}
                onClick={async () => {
                  if (await run(supabase.from("vehicles").insert({ registration_no: nv.registration_no, make: nv.make || null, model: nv.model || null }))) {
                    setNv({ registration_no: "", make: "", model: "" });
                    setDialog(null);
                  }
                }}>
                {busy ? "Adding…" : "Add vehicle"}
              </Button>
            </ModalFooter>
          }>
          <div className="space-y-4">
            <FormField label="Registration no." required>
              <input className={inputCls + " font-mono uppercase"} autoFocus value={nv.registration_no} placeholder="LEA-1234"
                     onChange={(e) => setNv({ ...nv, registration_no: e.target.value })} />
            </FormField>
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Make">
                <input className={inputCls} value={nv.make} placeholder="Toyota" onChange={(e) => setNv({ ...nv, make: e.target.value })} />
              </FormField>
              <FormField label="Model">
                <input className={inputCls} value={nv.model} placeholder="Hilux" onChange={(e) => setNv({ ...nv, model: e.target.value })} />
              </FormField>
            </div>
          </div>
        </Modal>
      )}

      {dialog === "vehicleLog" && (
        <VehicleLogDialog companyId={companyId} vehicles={vehicles} run={run} busy={busy} err={err}
                          onDismissError={() => setErr(null)} onClose={close} />
      )}
      {dialog === "ammo" && (
        <AmmoDialog weapons={weapons} run={run} busy={busy} err={err}
                    onDismissError={() => setErr(null)} onClose={close} />
      )}
    </>
  );
}

type DialogProps = { run: Run; busy: boolean; err: string | null; onDismissError: () => void; onClose: () => void };

function VehicleLogDialog({ companyId, vehicles, run, busy, err, onDismissError, onClose }: DialogProps & { companyId: string; vehicles: any[] }) {
  const [vid, setVid] = useState("");
  const [logType, setLogType] = useState("fuel");
  const [date, setDate] = useState(today());
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
    if (ok) onClose();
  };
  return (
    <Modal isOpen onClose={onClose} title="Log trip, fuel or maintenance" size="md" error={err} onDismissError={onDismissError}
      footer={
        <ModalFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !vid} onClick={submit}>{busy ? "Saving…" : "Add log"}</Button>
        </ModalFooter>
      }>
      <div className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField label="Vehicle" required>
            <Picker
              value={vid}
              onChange={setVid}
              placeholder="Pick a vehicle…"
              searchPlaceholder="Search registration…"
              options={vehicles.map((v) => ({
                value: v.id,
                label: v.registration_no,
                sub: [v.make, v.model].filter(Boolean).join(" ") || undefined,
              }))}
            />
          </FormField>
          <FormField label="Date" required>
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Type" required>
          <Pills value={logType} onChange={setLogType} options={["fuel", "trip", "maintenance"]} />
        </FormField>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FormField label="Odometer (km)">
            <input className={inputCls} type="number" min={0} value={odometer} onChange={(e) => setOdometer(e.target.value)} />
          </FormField>
          {logType === "fuel" && (
            <FormField label="Litres">
              <input className={inputCls} type="number" min={0} value={litres} onChange={(e) => setLitres(e.target.value)} />
            </FormField>
          )}
          <FormField label="Amount (PKR)">
            <input className={inputCls} type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Description">
          <input className={inputCls} value={desc} placeholder="Optional" onChange={(e) => setDesc(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}

function AmmoDialog({ weapons, run, busy, err, onDismissError, onClose }: DialogProps & { weapons: any[] }) {
  const [wid, setWid] = useState("");
  const [issued, setIssued] = useState("");
  const [accounted, setAccounted] = useState("");
  const diff = issued !== "" ? Number(issued || 0) - Number(accounted || 0) : null;
  return (
    <Modal isOpen onClose={onClose} title="Record ammunition count" size="sm" error={err} onDismissError={onDismissError}
      footer={
        <ModalFooter summary={diff != null ? (
          diff === 0 ? <Badge tone="success">Balances</Badge> : <Badge tone="danger">Discrepancy {diff}</Badge>
        ) : undefined}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !wid || !issued}
            onClick={async () => {
              if (await run(supabase.from("ammunition_counts").insert({
                weapon_item_id: wid, issued_rounds: Number(issued || 0), accounted_rounds: Number(accounted || 0),
              }))) onClose();
            }}>
            {busy ? "Saving…" : "Record count"}
          </Button>
        </ModalFooter>
      }>
      <div className="space-y-4">
        <FormField label="Weapon" required>
          <Picker
            value={wid}
            onChange={setWid}
            placeholder="Pick a weapon…"
            searchPlaceholder="Search weapon or serial…"
            options={weapons.map((w) => ({
              value: w.id,
              label: w.item_type,
              sub: w.serial_number ? `Serial ${w.serial_number}` : undefined,
            }))}
          />
        </FormField>
        {weapons.length === 0 && <Hint tone="warning">No weapons on record to count against.</Hint>}
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Rounds issued" required>
            <input className={inputCls} type="number" min={0} value={issued} onChange={(e) => setIssued(e.target.value)} />
          </FormField>
          <FormField label="Rounds accounted">
            <input className={inputCls} type="number" min={0} value={accounted} onChange={(e) => setAccounted(e.target.value)} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}
