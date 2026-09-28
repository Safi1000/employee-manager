// Assets & Issuance (web InventoryStore, KitIssuance, Clearance, Assets). Every
// stock movement, fine and depreciation is the web's own RPC; the few plain
// writes (item types, settings, vehicle logs, ammunition counts) are the web's.
import { q, rpc, sb } from "./core";
import { friendlyDbError } from "../../lib/web/supabase";

const today = () => new Date().toISOString().slice(0, 10);
async function call(p: PromiseLike<{ data?: unknown; error: { message: string } | null }>) {
  const { data, error } = await p;
  if (error) throw new Error(friendlyDbError(error));
  return data;
}

// ------------------------------------------------------------------- Store
export const CATEGORIES = ["uniform", "kit", "ammunition", "weapon", "vehicle", "office"] as const;
export type Category = (typeof CATEGORIES)[number];
export const ACCOUNT_FOR: Record<Category, string> = {
  uniform: "inventory_uniforms", kit: "inventory_kit", ammunition: "inventory_ammunition",
  weapon: "inventory_weapons", vehicle: "inventory_vehicles", office: "inventory_kit",
};
export type ItemType = { id: string; name: string; category: Category; issuable: boolean; actual_cost: number; replacement_cost: number; useful_life_months: number; sized: boolean; serialised: boolean; inventory_key: string; active: boolean };
export type StockRow = { id: string; item_type_id: string; size: string | null; grade: "new" | "used"; serial_number: string | null; licence_expiry: string | null; quantity: number; unit_actual_cost: number };
export type PurchaseLine = { item_type_id: string; size: string; grade: "new" | "used"; serial_number: string; licence_expiry: string; quantity: string; unit_actual_cost: string };
export const emptyLine = (): PurchaseLine => ({ item_type_id: "", size: "", grade: "new", serial_number: "", licence_expiry: "", quantity: "1", unit_actual_cost: "" });
export type TypeForm = { name: string; category: Category; issuable: boolean; replacement_cost: string; useful_life_months: string; sized: boolean; serialised: boolean };
export const blankType = (): TypeForm => ({ name: "", category: "uniform", issuable: true, replacement_cost: "", useful_life_months: "12", sized: true, serialised: false });

export async function loadStore() {
  const s = sb();
  const [types, stock, guards, settings, batches] = await Promise.all([
    q<ItemType[]>(s.from("inventory_item_types").select("*").order("name")),
    q<StockRow[]>(s.from("inventory_stock").select("*")),
    q<any[]>(s.from("employees").select("id, guard_code").not("guard_code", "is", null)),
    q<any>(s.from("inventory_settings").select("kit_required_from").maybeSingle()),
    s.from("inventory_opening_batches").select("id", { count: "exact", head: true }),
  ]);
  return { types, stock, guards, settings: settings as { kit_required_from: string | null } | null, batches: batches.count ?? 0 };
}

export async function saveType(editingId: string | null, nt: TypeForm) {
  await call(editingId
    ? sb().from("inventory_item_types").update({ name: nt.name.trim(), replacement_cost: Number(nt.replacement_cost || 0), useful_life_months: Number(nt.useful_life_months || 12), updated_at: new Date().toISOString() } as never).eq("id", editingId)
    : sb().from("inventory_item_types").insert({
      name: nt.name.trim(), category: nt.category, issuable: nt.issuable, replacement_cost: Number(nt.replacement_cost || 0),
      useful_life_months: Number(nt.useful_life_months || 12), sized: nt.issuable ? nt.sized : false, serialised: nt.issuable ? nt.serialised : false,
      inventory_key: ACCOUNT_FOR[nt.category],
    } as never));
}

export function parseCatalogue(text: string, types: ItemType[]) {
  const have = new Set(types.map((t) => t.name.trim().toLowerCase()));
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [name = "", cat = "", costRaw = "", lifeRaw = "", shapeRaw = ""] = line.split(/\t|,/).map((c) => c.trim());
    const category = cat.toLowerCase() as Category;
    const cost = Number(costRaw || 0);
    const life = Number(lifeRaw || 0);
    const shape = shapeRaw.toLowerCase();
    let error: string | null = null;
    if (!name) error = "No name.";
    else if (have.has(name.toLowerCase())) error = `"${name}" already exists.`;
    else if (!CATEGORIES.includes(category)) error = `Category must be one of ${CATEGORIES.join(", ")}.`;
    else if (category !== "office" && !(cost > 0)) error = "Replacement cost is what a fine reads. It cannot be zero.";
    else if (category !== "office" && !(life > 0)) error = "Useful life in months is what pro-rates a fine. It cannot be zero.";
    else if (category !== "office" && !["size", "count", "serial"].includes(shape)) error = "Shape must be size, count or serial.";
    return { name, category, cost, life, shape, error };
  });
}
export async function submitCatalogue(rows: ReturnType<typeof parseCatalogue>) {
  await call(sb().from("inventory_item_types").insert(rows.map((r) => ({
    name: r.name, category: r.category, issuable: r.category !== "office", replacement_cost: r.cost, useful_life_months: r.life || 12,
    sized: r.category !== "office" && r.shape === "size", serialised: r.category !== "office" && r.shape === "serial", inventory_key: ACCOUNT_FOR[r.category],
  })) as never));
}

export async function recordPurchase(buy: { purchase_date: string; payment_mode: string; description: string; lines: PurchaseLine[] }) {
  const lines = buy.lines.filter((l) => l.item_type_id && Number(l.quantity) > 0).map((l) => ({
    item_type_id: l.item_type_id, size: l.size || null, grade: l.grade, serial_number: l.serial_number || null, licence_expiry: l.licence_expiry || null,
    quantity: Number(l.quantity), unit_actual_cost: Number(l.unit_actual_cost || 0),
  }));
  if (lines.length === 0) throw new Error("Add at least one line.");
  await call(sb().rpc("record_inventory_purchase" as never, { p_purchase_date: buy.purchase_date, p_lines: lines, p_payment_mode: buy.payment_mode, p_description: buy.description.trim() || null } as never));
}

export const OPENING_COLS = ["Item", "Size", "Grade", "Serial", "Qty", "Actual each", "Guard code"];
export function parseOpening(text: string, types: ItemType[], guardByCode: Map<string, string>) {
  const byName = new Map(types.map((t) => [t.name.trim().toLowerCase(), t]));
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const cells = line.split(/\t|,/).map((c) => c.trim());
    const [itemName = "", size = "", gradeRaw = "", serial = "", qtyRaw = "", costRaw = "", guardCode = ""] = cells;
    const t = byName.get(itemName.toLowerCase());
    const qty = Number(qtyRaw || 0);
    const cost = Number(costRaw || 0);
    const holder = guardCode ? guardByCode.get(guardCode.toUpperCase()) ?? null : null;
    let error: string | null = null;
    if (!t) error = `No item type named "${itemName}".`;
    else if (!t.issuable) error = `"${itemName}" is an office expense, not stock.`;
    else if (!(qty > 0)) error = "Quantity must be more than zero.";
    else if (!(cost > 0)) error = "Every line carries an actual cost. A zero balances and describes nothing.";
    else if (guardCode && !holder) error = `No guard with code "${guardCode}".`;
    else if (t.serialised && !serial) error = `"${itemName}" is tracked individually and needs a serial.`;
    return { item_type_id: t?.id ?? null, itemName, size, grade: (gradeRaw.toLowerCase() === "used" ? "used" : "new") as "new" | "used", serial, qty, cost, guardCode, holder_employee_id: holder, error };
  });
}
export async function recordOpening(asOf: string, rows: ReturnType<typeof parseOpening>) {
  await call(sb().rpc("record_opening_stock" as never, {
    p_as_of: asOf,
    p_lines: rows.map((r) => ({ item_type_id: r.item_type_id, size: r.size || null, grade: r.grade, serial_number: r.serial || null, quantity: r.qty, unit_actual_cost: r.cost, holder_employee_id: r.holder_employee_id })),
  } as never));
}
export async function saveKitFrom(companyId: string, kitFrom: string) {
  await call(sb().from("inventory_settings").update({ kit_required_from: kitFrom || null, updated_at: new Date().toISOString() } as never).eq("company_id", companyId));
}

// ---------------------------------------------------------------- Issuance
export const CONDITIONS = ["new", "good", "fair", "rough", "unusable"] as const;
export type Holding = { issue_id: string; item_type_id: string; size: string | null; grade: string; serial_number: string | null; client_id: string | null; issued_on: string; outstanding_qty: number; holder_employee_id: string | null; holder_site_id: string | null; opening_condition: string; last_event: string; last_event_date: string };
export async function loadIssuance() {
  const s = sb();
  const [holdings, types, stock, emps, clients, sites] = await Promise.all([
    q<Holding[]>(s.from("kit_holdings").select("*")),
    q<{ id: string; name: string }[]>(s.from("inventory_item_types").select("id, name").eq("issuable", true).order("name")),
    q<any[]>(s.from("inventory_stock").select("*")),
    q<{ id: string; full_name: string; guard_code: string | null }[]>(s.from("employees").select("id, full_name, guard_code").eq("lifecycle_state", "active").order("full_name")),
    q<{ id: string; name: string }[]>(s.from("clients").select("id, name").order("name")),
    q<{ id: string; name: string; client_id: string }[]>(s.from("sites").select("id, name, client_id").order("name")),
  ]);
  return { holdings, types, stock, emps, clients, sites };
}
export type IssueForm = { item_type_id: string; size: string; grade: string; serial: string; to_employee: string; site_id: string; quantity: string; condition: string; event_date: string; notes: string };
export const blankIssue = (): IssueForm => ({ item_type_id: "", size: "", grade: "new", serial: "", to_employee: "", site_id: "", quantity: "1", condition: "new", event_date: today(), notes: "" });
export async function issueKit(f: IssueForm) {
  await call(sb().rpc("issue_kit" as never, {
    p_item_type_id: f.item_type_id, p_to_employee: f.to_employee || null, p_site_id: f.site_id || null, p_size: f.size || null, p_grade: f.grade,
    p_serial: f.serial || null, p_quantity: Number(f.quantity || 1), p_condition: f.condition, p_event_date: f.event_date, p_notes: f.notes.trim() || null,
  } as never));
}
export async function returnKit(issueId: string, f: { quantity: string; condition: string; notes: string }) {
  await call(sb().rpc("return_kit" as never, { p_issue_id: issueId, p_quantity: f.quantity ? Number(f.quantity) : null, p_condition: f.condition, p_notes: f.notes.trim() || null } as never));
}
export async function handoverKit(issueId: string, f: { to_employee: string; condition: string; notes: string }) {
  await call(sb().rpc("handover_kit" as never, { p_issue_id: issueId, p_to_employee: f.to_employee, p_condition: f.condition, p_notes: f.notes.trim() || null } as never));
}

// --------------------------------------------------------------- Clearance
export const OUTCOMES = [
  { v: "returned_reusable", l: "Returned — reusable" }, { v: "returned_unusable", l: "Returned — unusable" }, { v: "not_returned", l: "Not returned" },
] as const;
export type Pending = { id: string; full_name: string; guard_code: string | null; last_working_day: string | null; lifecycle_state: string; certificate_id: string | null; ops_cleared_at: string | null };
export type KitItem = { id: string; issue_id: string; item_type_id: string; size: string | null; quantity: number; opening_condition: string; outcome: string | null; returned_condition: string | null; suggested_fine: number; fine: number };
export async function loadClearance() {
  const s = sb();
  const [emps, certs, queue, types] = await Promise.all([
    q<any[]>(s.from("employees").select("id, full_name, guard_code, last_working_day, lifecycle_state").in("lifecycle_state", ["fired", "left", "absconded"]).not("last_working_day", "is", null).order("last_working_day", { ascending: false })),
    q<any[]>(s.from("clearance_certificates").select("id, employee_id, ops_cleared_at, dues_released")),
    q<any[]>(s.from("clearance_finance_queue").select("*")),
    q<{ id: string; name: string }[]>(s.from("inventory_item_types").select("id, name")),
  ]);
  const certByEmp = new Map<string, any>();
  for (const row of certs) if (!certByEmp.has(row.employee_id) || row.ops_cleared_at) certByEmp.set(row.employee_id, row);
  const pending: Pending[] = emps.map((x) => ({ ...x, certificate_id: certByEmp.get(x.id)?.id ?? null, ops_cleared_at: certByEmp.get(x.id)?.ops_cleared_at ?? null }));
  return { pending, queue, types };
}
export async function openAssessment(employeeId: string) {
  const certId = (await call(sb().rpc("open_kit_clearance" as never, { p_employee_id: employeeId } as never))) as string;
  const items = await q<KitItem[]>(sb().from("clearance_kit_items").select("*").eq("certificate_id", certId));
  return { certId, items };
}
export async function setOutcome(item: KitItem, outcome: string, profileId: string | null) {
  const suggested = Number((await rpc("suggest_kit_fine", { p_issue_id: item.issue_id, p_outcome: outcome })) ?? 0);
  await q(sb().from("clearance_kit_items").update({ outcome, suggested_fine: suggested, fine: suggested, assessed_by: profileId, assessed_at: new Date().toISOString() } as never).eq("id", item.id));
  return suggested;
}
export async function overrideFine(itemId: string, fine: number) {
  await q(sb().from("clearance_kit_items").update({ fine } as never).eq("id", itemId));
}
export async function opsClear(certId: string) { await call(sb().rpc("ops_clear_employee" as never, { p_certificate_id: certId } as never)); }
export async function releaseDues(certId: string) { return call(sb().rpc("release_final_dues" as never, { p_certificate_id: certId } as never)); }
export async function recordSignature(certId: string, profileId: string | null) {
  await call(sb().from("clearance_certificates").update({ signed_at: new Date().toISOString(), signed_by: profileId } as never).eq("id", certId));
}

// ---------------------------------------------------------------- Register
export const ASSET_CATEGORIES = ["weapons", "vehicles", "equipment", "furniture", "it_equipment"] as const;
export async function loadRegister(companyId: string) {
  const s = sb();
  const [assets, vehicles, vehicleCost, ammo, discrepancies, weapons] = await Promise.all([
    q<any[]>(s.from("fixed_assets_register").select("*").eq("company_id", companyId).order("acquisition_date", { ascending: false })),
    q<any[]>(s.from("vehicles").select("*").eq("company_id", companyId).order("created_at", { ascending: false })),
    q<any[]>(s.from("vehicle_monthly_cost").select("*").eq("company_id", companyId)),
    q<any[]>(s.from("ammunition_counts").select("*").eq("company_id", companyId).order("count_date", { ascending: false })),
    q<any[]>(s.from("ammunition_discrepancies").select("*").eq("company_id", companyId)),
    q<any[]>(s.from("inventory_items").select("id, item_type, serial_number").eq("company_id", companyId).eq("kind", "weapon")),
  ]);
  return { assets, vehicles, vehicleCost, ammo, discrepancies, weapons };
}
export const runDepreciation = (companyId: string, period: string) => call(sb().rpc("run_depreciation" as never, { p_company_id: companyId, p_period: period } as never));
export const capitaliseAsset = (na: { name: string; category: string; acquisition_date: string; cost: string; salvage_value: string; useful_life_months: string }) =>
  call(sb().rpc("capitalise_fixed_asset" as never, {
    p_name: na.name, p_category: na.category, p_acquisition_date: na.acquisition_date, p_cost: Number(na.cost), p_salvage_value: Number(na.salvage_value || 0), p_useful_life_months: Number(na.useful_life_months || 1),
  } as never));
export const disposeAsset = (id: string) => call(sb().rpc("dispose_fixed_asset" as never, { p_asset_id: id, p_disposal_date: today(), p_proceeds: 0 } as never));
export const addVehicle = (nv: { registration_no: string; make: string; model: string }) => call(sb().from("vehicles").insert({ registration_no: nv.registration_no, make: nv.make || null, model: nv.model || null } as never));
export const addVehicleLog = (companyId: string, veh: any, f: { logType: string; date: string; odometer: string; litres: string; amount: string; desc: string }) =>
  call(sb().from("vehicle_logs").insert({
    company_id: companyId, vehicle_id: veh.id, branch_id: veh?.branch_id ?? null, log_type: f.logType, log_date: f.date,
    odometer: f.odometer ? Number(f.odometer) : null, litres: f.litres ? Number(f.litres) : null, amount: f.amount ? Number(f.amount) : null, description: f.desc || null,
  } as never));
export const sweepAmmo = (companyId: string) => call(sb().rpc("sweep_ammo_discrepancy_alerts" as never, { p_company_id: companyId } as never));
export const addAmmoCount = (wid: string, issued: string, accounted: string) =>
  call(sb().from("ammunition_counts").insert({ weapon_item_id: wid, issued_rounds: Number(issued || 0), accounted_rounds: Number(accounted || 0) } as never));
