// ── The store: what is held, what it cost, and how it got here ──────────────
//
// Replaces the "Register" half of the old Assets & Issuance for everything that
// is STOCK. Two costs per item type, because they answer different questions:
//
//   Actual      — what was paid. The ledger figure. A bulk discount reduces it.
//   Replacement — what one costs to replace. A discount does NOT reduce it.
//                 Fines read this, which is why collapsing the two would fine a
//                 guard the discounted price of a uniform the company must
//                 replace at full price.
//
// The operator chooses the ITEM, never the accounting treatment. `issuable` on
// the type decides: issuable is stock, not-issuable is an office expense and
// never touches inventory. There is no value threshold — one would let three
// uniforms skip inventory while two hundred did not.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Package, Loader2, Trash2, ClipboardList } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";

const FIELD =
  "w-full px-3 py-2 border border-border rounded-md text-sm bg-background";
const money = (n: unknown) => Number(n ?? 0).toLocaleString();

const CATEGORIES = ["uniform", "kit", "ammunition", "weapon", "vehicle", "office"] as const;
type Category = (typeof CATEGORIES)[number];

/** Which inventory account a category's value sits in. The operator never picks
 *  this — the item type does, which is the whole point of a catalogue. */
const ACCOUNT_FOR: Record<Category, string> = {
  uniform: "inventory_uniforms",
  kit: "inventory_kit",
  ammunition: "inventory_ammunition",
  weapon: "inventory_weapons",
  vehicle: "inventory_vehicles",
  office: "inventory_kit", // never reached: an office type is not stock
};

type ItemType = {
  id: string;
  name: string;
  category: Category;
  issuable: boolean;
  actual_cost: number;
  replacement_cost: number;
  useful_life_months: number;
  sized: boolean;
  serialised: boolean;
  inventory_key: string;
  active: boolean;
};

type StockRow = {
  id: string;
  item_type_id: string;
  size: string | null;
  grade: "new" | "used";
  serial_number: string | null;
  licence_expiry: string | null;
  quantity: number;
  unit_actual_cost: number;
};

type PurchaseLine = {
  item_type_id: string;
  size: string;
  grade: "new" | "used";
  serial_number: string;
  licence_expiry: string;
  quantity: string;
  unit_actual_cost: string;
};

const emptyLine: PurchaseLine = {
  item_type_id: "", size: "", grade: "new", serial_number: "",
  licence_expiry: "", quantity: "1", unit_actual_cost: "",
};

// ── The opening stocktake ───────────────────────────────────────────────────
//
// A ONE-OFF ACT, and it is 323 guards' worth of kit. A line-at-a-time modal
// would not be finished this year, so it takes a paste out of the spreadsheet
// he is going to count into anyway. Seven columns, in this order:
//
//   Item · Size · Grade · Serial · Qty · Actual cost each · Guard code
//
// Blank guard code means it is in the store. Everything is matched here and
// shown back before anything is sent — an unmatched item name or guard code is
// refused rather than guessed at, because a stocktake that quietly dropped a
// line would balance and be wrong.
const OPENING_COLS = ["Item", "Size", "Grade", "Serial", "Qty", "Actual each", "Guard code"];

type OpeningRow = {
  raw: string[];
  item_type_id: string | null;
  itemName: string;
  size: string;
  grade: "new" | "used";
  serial: string;
  qty: number;
  cost: number;
  guardCode: string;
  holder_employee_id: string | null;
  error: string | null;
};

function parseOpening(
  text: string,
  types: ItemType[],
  guardByCode: Map<string, string>,
): OpeningRow[] {
  const byName = new Map(types.map((t) => [t.name.trim().toLowerCase(), t]));
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
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
      // The RPC refuses a valueless line; saying so here saves a round trip and
      // says which line, which the exception cannot.
      else if (!(cost > 0)) error = "Every line carries an actual cost. A zero balances and describes nothing.";
      else if (guardCode && !holder) error = `No guard with code "${guardCode}".`;
      else if (t.serialised && !serial) error = `"${itemName}" is tracked individually and needs a serial.`;
      return {
        raw: cells, item_type_id: t?.id ?? null, itemName, size,
        grade: gradeRaw.toLowerCase() === "used" ? "used" : "new",
        serial, qty, cost, guardCode, holder_employee_id: holder, error,
      };
    });
}

export default function InventoryStore() {
  const { profile, company } = useAuth();
  const canEdit = hasPermission(profile, "inventory.edit");

  const [types, setTypes] = useState<ItemType[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [typeOpen, setTypeOpen] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  const [openingOpen, setOpeningOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [guards, setGuards] = useState<{ id: string; guard_code: string | null }[]>([]);
  const [settings, setSettings] = useState<{ kit_required_from: string | null } | null>(null);
  const [batches, setBatches] = useState<number>(0);
  const [opening, setOpening] = useState({
    as_of: new Date().toISOString().slice(0, 10),
    paste: "",
  });
  const [kitFrom, setKitFrom] = useState("");
  const [editingType, setEditingType] = useState<string | null>(null);
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [cataloguePaste, setCataloguePaste] = useState("");

  const [nt, setNt] = useState({
    name: "", category: "uniform" as Category, issuable: true,
    replacement_cost: "", useful_life_months: "12", sized: true, serialised: false,
  });
  const [buy, setBuy] = useState({
    purchase_date: new Date().toISOString().slice(0, 10),
    payment_mode: "Payable",
    description: "",
    lines: [{ ...emptyLine }] as PurchaseLine[],
  });

  const load = useCallback(async () => {
    setLoading(true);
    const [t, s, g, cfg, b] = await Promise.all([
      supabase.from("inventory_item_types").select("*").order("name"),
      supabase.from("inventory_stock").select("*"),
      supabase.from("employees").select("id, guard_code").not("guard_code", "is", null),
      supabase.from("inventory_settings").select("kit_required_from").maybeSingle(),
      supabase.from("inventory_opening_batches").select("id", { count: "exact", head: true }),
    ]);
    if (t.error) setErr(t.error.message);
    setTypes((t.data ?? []) as ItemType[]);
    setStock((s.data ?? []) as StockRow[]);
    setGuards((g.data ?? []) as any[]);
    setSettings((cfg.data ?? null) as any);
    setKitFrom((cfg.data as any)?.kit_required_from ?? "");
    setBatches(b.count ?? 0);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const typeById = useMemo(
    () => new Map(types.map((t) => [t.id, t])), [types]);

  // THE VALUE OF WHAT IS HELD, folded from the rows shown. This is the stated
  // exception in CLAUDE.md: a footer that can contradict the table above it is
  // worse than the duplication, so it is summed from the displayed rows and
  // never fetched separately.
  const heldValue = useMemo(
    () => stock.reduce((a, r) => a + r.quantity * Number(r.unit_actual_cost), 0),
    [stock]);

  const blankType = { name: "", category: "uniform" as Category, issuable: true,
    replacement_cost: "", useful_life_months: "12", sized: true, serialised: false };

  const addType = async () => {
    setBusy(true); setErr(null);
    const { error } = editingType
      // A CORRECTION. Only the two figures a fine reads. Shape and category are
      // fixed once stock exists under them — changing "by size" to "by count"
      // would orphan every sized row.
      ? await supabase.from("inventory_item_types").update({
          name: nt.name.trim(),
          replacement_cost: Number(nt.replacement_cost || 0),
          useful_life_months: Number(nt.useful_life_months || 12),
          updated_at: new Date().toISOString(),
        }).eq("id", editingType)
      : await supabase.from("inventory_item_types").insert({
          name: nt.name.trim(),
          category: nt.category,
          issuable: nt.issuable,
          replacement_cost: Number(nt.replacement_cost || 0),
          useful_life_months: Number(nt.useful_life_months || 12),
          // An office type is not stock and the constraint refuses it being either.
          sized: nt.issuable ? nt.sized : false,
          serialised: nt.issuable ? nt.serialised : false,
          inventory_key: ACCOUNT_FOR[nt.category],
        });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setTypeOpen(false); setEditingType(null);
    setNt(blankType);
    load();
  };

  const editType = (t: ItemType) => {
    setEditingType(t.id);
    setNt({ name: t.name, category: t.category, issuable: t.issuable,
            replacement_cost: String(t.replacement_cost), useful_life_months: String(t.useful_life_months),
            sized: t.sized, serialised: t.serialised });
    setTypeOpen(true);
  };

  // THE CATALOGUE, PASTED. Forty item types typed by hand is how the useful-life
  // column ends up empty. Five columns:
  //   Name · Category · Replacement cost · Useful life (months) · Shape
  // Shape is size, count or serial. Matched and shown back before anything is
  // sent, same as the stocktake.
  const catalogueRows = useMemo(() => {
    const have = new Set(types.map((t) => t.name.trim().toLowerCase()));
    return cataloguePaste.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
      const [name = "", cat = "", costRaw = "", lifeRaw = "", shapeRaw = ""] =
        line.split(/\t|,/).map((c) => c.trim());
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
  }, [cataloguePaste, types]);
  const catalogueBad = catalogueRows.filter((r) => r.error).length;

  const submitCatalogue = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.from("inventory_item_types").insert(
      catalogueRows.map((r) => ({
        name: r.name,
        category: r.category,
        issuable: r.category !== "office",
        replacement_cost: r.cost,
        useful_life_months: r.life || 12,
        sized: r.category !== "office" && r.shape === "size",
        serialised: r.category !== "office" && r.shape === "serial",
        inventory_key: ACCOUNT_FOR[r.category],
      })));
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setCatalogueOpen(false); setCataloguePaste("");
    setNotice(`${catalogueRows.length} item types added.`);
    load();
  };

  const submitPurchase = async () => {
    setBusy(true); setErr(null);
    const lines = buy.lines
      .filter((l) => l.item_type_id && Number(l.quantity) > 0)
      .map((l) => ({
        item_type_id: l.item_type_id,
        size: l.size || null,
        grade: l.grade,
        serial_number: l.serial_number || null,
        licence_expiry: l.licence_expiry || null,
        quantity: Number(l.quantity),
        unit_actual_cost: Number(l.unit_actual_cost || 0),
      }));
    if (lines.length === 0) { setBusy(false); setErr("Add at least one line."); return; }

    // ONE CALL. Stock, the moving average and the journal are one transaction —
    // a purchase that put stock on the shelf and failed to post would be a
    // balance sheet that disagrees with the store.
    const { error } = await supabase.rpc("record_inventory_purchase", {
      p_purchase_date: buy.purchase_date,
      p_lines: lines,
      p_payment_mode: buy.payment_mode,
      p_description: buy.description.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setBuyOpen(false);
    setBuy({ purchase_date: new Date().toISOString().slice(0, 10),
             payment_mode: "Payable", description: "", lines: [{ ...emptyLine }] });
    load();
  };

  const guardByCode = useMemo(
    () => new Map(guards.filter((g) => g.guard_code)
      .map((g) => [g.guard_code!.toUpperCase(), g.id])), [guards]);

  const openingRows = useMemo(
    () => parseOpening(opening.paste, types, guardByCode),
    [opening.paste, types, guardByCode]);
  const openingBad = openingRows.filter((r) => r.error).length;

  const submitOpening = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("record_opening_stock", {
      p_as_of: opening.as_of,
      p_lines: openingRows.map((r) => ({
        item_type_id: r.item_type_id,
        size: r.size || null,
        grade: r.grade,
        serial_number: r.serial || null,
        quantity: r.qty,
        unit_actual_cost: r.cost,
        holder_employee_id: r.holder_employee_id,
      })),
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setOpeningOpen(false);
    setOpening({ as_of: new Date().toISOString().slice(0, 10), paste: "" });
    setNotice("Opening stocktake posted. Set the date kit becomes required below to switch the rule on.");
    load();
  };

  // THE DATE THE RULE STARTS. Deployments beginning on or after it need an open
  // issuance; before it, nothing is refused and nothing is reported. Setting it
  // is the act of declaring the stocktake done.
  const saveKitFrom = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.from("inventory_settings")
      .update({ kit_required_from: kitFrom || null, updated_at: new Date().toISOString() })
      .eq("company_id", company?.id ?? "");
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setNotice(kitFrom
      ? `Kit is required for deployments starting on or after ${kitFrom}.`
      : "The kit requirement is off. Nothing is refused and nothing is reported.");
    load();
  };

  const setLine = (i: number, patch: Partial<PurchaseLine>) =>
    setBuy((b) => ({ ...b, lines: b.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  return (
    <>
      <Header
        title="Store"
        subtitle="What is held, by exact quantity, at actual and replacement cost"
        actions={canEdit ? (
          <>
            <Button variant="secondary" size="md"
                    onClick={() => { setEditingType(null); setNt(blankType); setTypeOpen(true); }}>
              <Plus className="w-4 h-4 mr-1.5" /> Item type
            </Button>
            <Button variant="secondary" size="md" onClick={() => setCatalogueOpen(true)}>
              <ClipboardList className="w-4 h-4 mr-1.5" /> Paste item types
            </Button>
            {batches === 0 && (
              <Button variant="secondary" size="md" onClick={() => setOpeningOpen(true)}>
                <ClipboardList className="w-4 h-4 mr-1.5" /> Opening stocktake
              </Button>
            )}
            <Button variant="primary" size="md" onClick={() => setBuyOpen(true)}>
              <Package className="w-4 h-4 mr-1.5" /> Record purchase
            </Button>
          </>
        ) : undefined}
      />

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-4 space-y-6">
        {err && (
          <div className="p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            {err}
          </div>
        )}
        {notice && (
          <div className="p-3 bg-success-50 text-success-700 border border-success-200 rounded-md text-sm">
            {notice}
          </div>
        )}
        {loading && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}

        {/* ---- WHEN THE RULE STARTS ---- */}
        {canEdit && settings && (
          <div className="bg-card border border-border rounded-md px-4 py-3">
            <h3 className="text-sm font-medium">Kit is required from</h3>
            <p className="text-xs text-muted-foreground mt-0.5 mb-2">
              A deployment starting on or after this date needs an open issuance, and the
              check reports only from here. Leave it empty until the stocktake is in: 323
              guards are deployed with kit that predates any of this, and a rule that
              refused all of them on its first day is a rule somebody turns off.
            </p>
            <div className="flex items-end gap-2">
              <input className={FIELD + " max-w-[12rem]"} type="date" value={kitFrom}
                     onChange={(e) => setKitFrom(e.target.value)} />
              <Button variant="secondary" size="sm" disabled={busy} onClick={saveKitFrom}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <span className="text-xs text-muted-foreground pb-2">
                {settings.kit_required_from
                  ? `In force from ${settings.kit_required_from}.`
                  : "Not in force — nothing is refused and nothing is reported."}
              </span>
            </div>
          </div>
        )}

        {/* ---- STOCK ON HAND ---- */}
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-sm font-medium">Stock on hand</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              New and used are separate stock of the same item. Issued kit is not here —
              it is on the Issuance tab, derived from the movement log.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  {["Item", "Size", "Grade", "Serial", "Qty", "Actual (each)", "Value"].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stock.length === 0 && !loading && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    Nothing in the store yet. Record a purchase, or enter the opening stocktake.
                  </td></tr>
                )}
                {stock.map((r) => {
                  const t = typeById.get(r.item_type_id);
                  return (
                    <tr key={r.id}>
                      <td className="px-4 py-2 text-sm">{t?.name ?? "—"}</td>
                      <td className="px-4 py-2 text-sm">{r.size ?? "—"}</td>
                      <td className="px-4 py-2 text-sm capitalize">{r.grade}</td>
                      <td className="px-4 py-2 text-sm font-mono text-xs">{r.serial_number ?? "—"}</td>
                      <td className="px-4 py-2 text-sm tabular-nums">{r.quantity}</td>
                      <td className="px-4 py-2 text-sm tabular-nums">{money(r.unit_actual_cost)}</td>
                      <td className="px-4 py-2 text-sm tabular-nums">
                        {money(r.quantity * Number(r.unit_actual_cost))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-muted/40 border-t border-border">
                <tr>
                  <td colSpan={6} className="px-4 py-2 text-sm text-right text-muted-foreground">
                    On the balance sheet, at actual cost
                  </td>
                  <td className="px-4 py-2 text-sm font-medium tabular-nums">PKR {money(heldValue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* ---- THE CATALOGUE ---- */}
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-sm font-medium">Item types</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Set once. Issuable decides whether something is tracked at all — there is no
              value threshold, because one would let three uniforms skip inventory while
              two hundred did not.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Replacement cost and useful life can be corrected later. A correction changes
              what a <em>future</em> clearance suggests. A fine already assessed keeps the
              figure it was assessed at — it is stored on the clearance, not read back from
              here.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  {["Item", "Category", "Tracked", "Actual", "Replacement", "Life", "Shape", ""].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {types.map((t) => (
                  <tr key={t.id}>
                    <td className="px-4 py-2 text-sm">{t.name}</td>
                    <td className="px-4 py-2 text-sm capitalize">{t.category}</td>
                    <td className="px-4 py-2 text-sm">
                      {t.issuable
                        ? <span className="text-success-700">Stock</span>
                        : <span className="text-muted-foreground">Office expense</span>}
                    </td>
                    <td className="px-4 py-2 text-sm tabular-nums">{money(t.actual_cost)}</td>
                    <td className="px-4 py-2 text-sm tabular-nums">{money(t.replacement_cost)}</td>
                    <td className="px-4 py-2 text-sm">{t.useful_life_months} mo</td>
                    <td className="px-4 py-2 text-sm text-muted-foreground">
                      {t.serialised ? "Individually" : t.sized ? "By size" : "By count"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {canEdit && (
                        <Button variant="ghost" size="sm" onClick={() => editType(t)}>Edit</Button>
                      )}
                    </td>
                  </tr>
                ))}
                {types.length === 0 && !loading && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No item types yet. Everything issued to a guard or a site needs one.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ---- NEW ITEM TYPE ---- */}
      {typeOpen && (
        <Modal isOpen onClose={() => { setTypeOpen(false); setEditingType(null); }}
               title={editingType ? "Correct item type" : "New item type"} size="sm">
          <div className="space-y-3">
            {editingType && (
              <p className="text-xs text-muted-foreground">
                A corrected replacement cost or useful life changes what a future clearance
                suggests. Fines already assessed keep the figure they were assessed at.
                Category and shape are fixed once the type exists.
              </p>
            )}
            <div>
              <label className="block text-sm mb-1">Name *</label>
              <input className={FIELD} value={nt.name}
                     onChange={(e) => setNt({ ...nt, name: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm mb-1">Category *</label>
              <ThemedSelect value={nt.category} disabled={!!editingType}
                onChange={(e) => setNt({ ...nt, category: e.target.value as Category })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </ThemedSelect>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={nt.issuable} disabled={!!editingType}
                     onChange={(e) => setNt({ ...nt, issuable: e.target.checked })} />
              <span>
                Issued to a guard or a site
                <span className="block text-xs text-muted-foreground">
                  On — it is stock and every movement is tracked. Off — it is an office
                  expense (stationery, tea, printer paper) and never touches inventory.
                </span>
              </span>
            </label>
            {nt.issuable && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm mb-1">Replacement cost *</label>
                    <input className={FIELD} type="number" min={0} value={nt.replacement_cost}
                           onChange={(e) => setNt({ ...nt, replacement_cost: e.target.value })} />
                    <p className="text-[11px] text-muted-foreground mt-1">
                      What ONE costs to replace. A bulk discount does not reduce it — fines read this.
                      Actual cost comes from purchases and is not typed here.
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Useful life (months) *</label>
                    <input className={FIELD} type="number" min={1} value={nt.useful_life_months}
                           onChange={(e) => setNt({ ...nt, useful_life_months: e.target.value })} />
                  </div>
                </div>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" disabled={!!editingType} checked={nt.sized && !nt.serialised}
                           onChange={() => setNt({ ...nt, sized: true, serialised: false })} />
                    By size
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" disabled={!!editingType} checked={!nt.sized && !nt.serialised}
                           onChange={() => setNt({ ...nt, sized: false, serialised: false })} />
                    By count
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" disabled={!!editingType} checked={nt.serialised}
                           onChange={() => setNt({ ...nt, sized: false, serialised: true })} />
                    Individually (serial + licence)
                  </label>
                </div>
              </>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => { setTypeOpen(false); setEditingType(null); }}>Cancel</Button>
              <Button onClick={addType} disabled={busy || !nt.name.trim()}>
                {busy ? "Saving…" : editingType ? "Save correction" : "Add"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ---- PASTE ITEM TYPES ---- */}
      {catalogueOpen && (
        <Modal isOpen onClose={() => setCatalogueOpen(false)} title="Paste item types" size="lg">
          <div className="space-y-3">
            <label className="block text-sm mb-1">
              Paste from the spreadsheet — Name · Category · Replacement cost · Useful life (months) · Shape
            </label>
            <textarea className={FIELD + " font-mono text-xs h-40"}
                      placeholder={"Summer shirt\tuniform\t1450\t12\tsize\nTorch\tkit\t900\t24\tcount\nPistol 9mm\tweapon\t68000\t120\tserial"}
                      value={cataloguePaste}
                      onChange={(e) => setCataloguePaste(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">
              Category is one of {CATEGORIES.join(", ")}. Shape is <em>size</em>, <em>count</em> or{" "}
              <em>serial</em>. Replacement cost is what one costs to replace today, undiscounted — fines
              read it. Useful life pro-rates a fine on kit returned unusable. Actual cost is not typed
              here; it comes from what was paid.
            </p>
            {catalogueRows.length > 0 && (
              <div className="overflow-x-auto max-h-64 border border-border rounded-md">
                <table className="w-full">
                  <thead className="bg-muted/40 border-b border-border sticky top-0">
                    <tr>
                      {["Name", "Category", "Replacement", "Life", "Shape"].map((h) => (
                        <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {catalogueRows.map((r, i) => (
                      <tr key={i} className={r.error ? "bg-danger-50/50" : undefined}>
                        {r.error ? (
                          <td colSpan={5} className="px-3 py-2 text-sm text-danger-700">Line {i + 1}: {r.error}</td>
                        ) : (
                          <>
                            <td className="px-3 py-2 text-sm">{r.name}</td>
                            <td className="px-3 py-2 text-sm capitalize">{r.category}</td>
                            <td className="px-3 py-2 text-sm tabular-nums">{money(r.cost)}</td>
                            <td className="px-3 py-2 text-sm">{r.life} mo</td>
                            <td className="px-3 py-2 text-sm">{r.shape}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <span className="text-sm">
                {catalogueRows.length} type{catalogueRows.length === 1 ? "" : "s"}
                {catalogueBad > 0 && <span className="text-danger-700"> · {catalogueBad} need fixing</span>}
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setCatalogueOpen(false)}>Cancel</Button>
                <Button onClick={submitCatalogue}
                        disabled={busy || catalogueRows.length === 0 || catalogueBad > 0}>
                  {busy ? "Adding…" : "Add item types"}
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* ---- OPENING STOCKTAKE ---- */}
      {openingOpen && (
        <Modal isOpen onClose={() => setOpeningOpen(false)} title="Opening stocktake" size="lg">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Everything held at actual cost, plus everything already out against the guards
              holding it. It posts once, as an opening balance: the inventory accounts are
              debited and Opening Balance Equity takes the other side. Kit entered against a
              guard is marked as already costed, so a year of historic issuance does not land
              on this month's client profitability.
            </p>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm mb-1">As of *</label>
                <input className={FIELD} type="date" value={opening.as_of}
                       onChange={(e) => setOpening({ ...opening, as_of: e.target.value })} />
              </div>
            </div>

            <div>
              <label className="block text-sm mb-1">
                Paste from the spreadsheet — {OPENING_COLS.join(" · ")}
              </label>
              <textarea className={FIELD + " font-mono text-xs h-40"}
                        placeholder={"Summer shirt\tL\tnew\t\t120\t1450\nPistol 9mm\t\tnew\tAB-1123\t1\t68000\tGGS-00241"}
                        value={opening.paste}
                        onChange={(e) => setOpening({ ...opening, paste: e.target.value })} />
              <p className="text-[11px] text-muted-foreground mt-1">
                Tab or comma separated, one line per item. Leave the guard code blank for
                anything sitting in the store. Grade is <em>new</em> or <em>used</em>. Serial
                is only for items tracked individually.
              </p>
            </div>

            {openingRows.length > 0 && (
              <div className="overflow-x-auto max-h-64 border border-border rounded-md">
                <table className="w-full">
                  <thead className="bg-muted/40 border-b border-border sticky top-0">
                    <tr>
                      {["Item", "Size", "Grade", "Serial", "Qty", "Actual each", "Held by", "Value"]
                        .map((h) => (
                          <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                        ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {openingRows.map((r, i) => (
                      <tr key={i} className={r.error ? "bg-danger-50/50" : undefined}>
                        {r.error ? (
                          <td colSpan={8} className="px-3 py-2 text-sm text-danger-700">
                            Line {i + 1}: {r.error}
                          </td>
                        ) : (
                          <>
                            <td className="px-3 py-2 text-sm">{r.itemName}</td>
                            <td className="px-3 py-2 text-sm">{r.size || "—"}</td>
                            <td className="px-3 py-2 text-sm capitalize">{r.grade}</td>
                            <td className="px-3 py-2 text-sm font-mono text-xs">{r.serial || "—"}</td>
                            <td className="px-3 py-2 text-sm tabular-nums">{r.qty}</td>
                            <td className="px-3 py-2 text-sm tabular-nums">{money(r.cost)}</td>
                            <td className="px-3 py-2 text-sm">{r.guardCode || "Store"}</td>
                            <td className="px-3 py-2 text-sm tabular-nums">{money(r.qty * r.cost)}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <span className="text-sm">
                {openingRows.length} line{openingRows.length === 1 ? "" : "s"}
                {openingBad > 0
                  ? <span className="text-danger-700"> · {openingBad} need fixing</span>
                  : <> · PKR {money(openingRows.reduce((a, r) => a + r.qty * r.cost, 0))}</>}
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setOpeningOpen(false)}>Cancel</Button>
                <Button onClick={submitOpening}
                        disabled={busy || openingRows.length === 0 || openingBad > 0}>
                  {busy ? "Posting…" : "Post opening stocktake"}
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* ---- RECORD PURCHASE ---- */}
      {buyOpen && (
        <Modal isOpen onClose={() => setBuyOpen(false)} title="Record a purchase" size="lg">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Capitalised into inventory at actual cost. Buying 200 uniforms does not touch
              the profit and loss — the cost reaches it when the kit is issued, on the client
              it was issued to.
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm mb-1">Date *</label>
                <input className={FIELD} type="date" value={buy.purchase_date}
                       onChange={(e) => setBuy({ ...buy, purchase_date: e.target.value })} />
              </div>
              <div>
                <label className="block text-sm mb-1">Paid by *</label>
                <ThemedSelect value={buy.payment_mode}
                  onChange={(e) => setBuy({ ...buy, payment_mode: e.target.value })}>
                  {["Payable", "Cash", "Bank", "Cheque"].map((m) => <option key={m} value={m}>{m}</option>)}
                </ThemedSelect>
              </div>
              <div>
                <label className="block text-sm mb-1">Description</label>
                <input className={FIELD} value={buy.description}
                       onChange={(e) => setBuy({ ...buy, description: e.target.value })} />
              </div>
            </div>

            {buy.lines.map((l, i) => {
              const t = typeById.get(l.item_type_id);
              return (
                <div key={i} className="grid grid-cols-12 gap-2 items-end border border-border rounded-md p-2">
                  <div className="col-span-4">
                    <label className="block text-xs mb-1">Item</label>
                    <ThemedSelect value={l.item_type_id}
                      onChange={(e) => setLine(i, { item_type_id: e.target.value })}>
                      <option value="">Pick an item…</option>
                      {types.filter((x) => x.issuable && x.active)
                        .map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </ThemedSelect>
                  </div>
                  {t?.sized && (
                    <div className="col-span-2">
                      <label className="block text-xs mb-1">Size</label>
                      <input className={FIELD} value={l.size}
                             onChange={(e) => setLine(i, { size: e.target.value })} />
                    </div>
                  )}
                  {t?.serialised && (
                    <div className="col-span-3">
                      <label className="block text-xs mb-1">Serial</label>
                      <input className={FIELD} value={l.serial_number}
                             onChange={(e) => setLine(i, { serial_number: e.target.value })} />
                    </div>
                  )}
                  <div className="col-span-2">
                    <label className="block text-xs mb-1">Qty</label>
                    <input className={FIELD} type="number" min={1} value={l.quantity}
                           onChange={(e) => setLine(i, { quantity: e.target.value })} />
                  </div>
                  <div className="col-span-3">
                    <label className="block text-xs mb-1">Actual cost each</label>
                    <input className={FIELD} type="number" min={0} value={l.unit_actual_cost}
                           onChange={(e) => setLine(i, { unit_actual_cost: e.target.value })} />
                  </div>
                  <div className="col-span-1">
                    <button type="button" className="p-2 text-muted-foreground hover:text-danger-600"
                            onClick={() => setBuy((b) => ({ ...b, lines: b.lines.filter((_, j) => j !== i) }))}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}

            <Button variant="ghost" size="sm"
                    onClick={() => setBuy((b) => ({ ...b, lines: [...b.lines, { ...emptyLine }] }))}>
              <Plus className="w-4 h-4 mr-1" /> Add line
            </Button>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <span className="text-sm text-muted-foreground">
                Total PKR {money(buy.lines.reduce(
                  (a, l) => a + Number(l.quantity || 0) * Number(l.unit_actual_cost || 0), 0))}
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setBuyOpen(false)}>Cancel</Button>
                <Button onClick={submitPurchase} disabled={busy}>
                  {busy ? "Posting…" : "Record purchase"}
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
