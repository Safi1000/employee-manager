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

import { useEmployeeCodeIndex } from "../../lib/employeeCodes";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus, Package, Loader2, Trash2, ClipboardList, ShoppingCart, Wallet, Boxes, Tags,
  ShieldCheck, ShieldOff, CalendarClock, Pencil,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import StatCard from "../../components/StatCard";
import Badge from "../../components/Badge";
import Tabs from "../../components/Tabs";
import ResponsiveTable, { type Column } from "../../components/ResponsiveTable";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { formatDate } from "../../lib/date";
import {
  ChoiceCards, FormField, FormSection, Hint, ModalFooter, Notice, PageBody, Panel, PasteCount,
  PastePreview, Pills, SearchBox, ToggleCard, inputCls, money, textareaCls,
} from "./_assetsKit";

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
  const codeIndex = useEmployeeCodeIndex();
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

  // A pasted code may be the permanent one or the client code he is known by.
  const guardByCode = useMemo(() => {
    const m = new Map(guards.filter((g) => g.guard_code).map((g) => [g.guard_code!.toUpperCase(), g.id]));
    for (const g of guards) {
      const code = codeIndex.byId.get(g.id);
      if (code) m.set(code.toUpperCase(), g.id);
    }
    return m;
  }, [guards, codeIndex.byId]);

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


  // ── Presentation state (filters only) ──
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<"all" | Category>("all");
  const anyModal = typeOpen || buyOpen || openingOpen || catalogueOpen;
  const closeType = () => { setTypeOpen(false); setEditingType(null); setErr(null); };

  const unitsHeld = useMemo(() => stock.reduce((a, r) => a + r.quantity, 0), [stock]);
  const presentCats = useMemo(
    () => CATEGORIES.filter((c) => stock.some((r) => typeById.get(r.item_type_id)?.category === c)),
    [stock, typeById]);
  const shownStock = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return stock.filter((r) => {
      const t = typeById.get(r.item_type_id);
      if (cat !== "all" && t?.category !== cat) return false;
      if (!needle) return true;
      return (t?.name ?? "").toLowerCase().includes(needle)
        || (r.serial_number ?? "").toLowerCase().includes(needle)
        || (r.size ?? "").toLowerCase().includes(needle);
    });
  }, [stock, typeById, q, cat]);
  // Footer of the table below: the sum of the rows it shows (CLAUDE.md's one
  // stated exception), so a filter can never make it contradict its rows.
  const shownValue = useMemo(
    () => shownStock.reduce((a, r) => a + r.quantity * Number(r.unit_actual_cost), 0), [shownStock]);
  const purchaseTotal = buy.lines.reduce(
    (a, l) => a + Number(l.quantity || 0) * Number(l.unit_actual_cost || 0), 0);

  const stockCols: Column<StockRow>[] = [
    { key: "item", header: "Item", primary: true, cell: (r) => {
      const t = typeById.get(r.item_type_id);
      return (
        <div>
          <div className="font-medium">{t?.name ?? "—"}</div>
          <div className="text-[11px] text-muted-foreground capitalize">{t?.category ?? ""}</div>
        </div>
      );
    } },
    { key: "size", header: "Size", cell: (r) => r.size ?? <span className="text-muted-foreground">—</span> },
    { key: "grade", header: "Grade", cell: (r) => (
      <Badge tone={r.grade === "new" ? "success" : "neutral"} className="capitalize">{r.grade}</Badge>
    ) },
    { key: "serial", header: "Serial", hideOnMobile: true, cell: (r) =>
      r.serial_number ? <span className="font-mono text-xs">{r.serial_number}</span> : <span className="text-muted-foreground">—</span> },
    { key: "qty", header: "Qty", className: "text-right tabular-nums", cell: (r) => r.quantity },
    { key: "each", header: "Actual each", className: "text-right tabular-nums", cell: (r) => money(r.unit_actual_cost) },
    { key: "value", header: "Value", className: "text-right tabular-nums font-medium",
      cell: (r) => money(r.quantity * Number(r.unit_actual_cost)) },
  ];

  const typeCols: Column<ItemType>[] = [
    { key: "name", header: "Item", primary: true, cell: (t) => <span className="font-medium">{t.name}</span> },
    { key: "cat", header: "Category", cell: (t) => <span className="capitalize">{t.category}</span> },
    { key: "tracked", header: "Tracked", cell: (t) => t.issuable
      ? <Badge tone="success">Stock</Badge> : <Badge tone="neutral">Office expense</Badge> },
    { key: "actual", header: "Actual", className: "text-right tabular-nums", cell: (t) => money(t.actual_cost) },
    { key: "repl", header: "Replacement", className: "text-right tabular-nums", cell: (t) => money(t.replacement_cost) },
    { key: "life", header: "Life", className: "tabular-nums", cell: (t) => `${t.useful_life_months} mo` },
    { key: "shape", header: "Counted", cell: (t) => (
      <span className="text-muted-foreground">{t.serialised ? "Individually" : t.sized ? "By size" : "By count"}</span>
    ) },
  ];

  return (
    <>
      <Header
        title="Store"
        subtitle="What is held, by exact quantity, at actual and replacement cost"
        actions={canEdit ? (
          <>
            <Button variant="secondary" size="md"
                    onClick={() => { setEditingType(null); setNt(blankType); setErr(null); setTypeOpen(true); }}>
              <Plus className="w-4 h-4" /> Item type
            </Button>
            <Button variant="secondary" size="md" onClick={() => { setErr(null); setCatalogueOpen(true); }}>
              <ClipboardList className="w-4 h-4" /> Paste item types
            </Button>
            {batches === 0 && (
              <Button variant="secondary" size="md" onClick={() => { setErr(null); setOpeningOpen(true); }}>
                <ClipboardList className="w-4 h-4" /> Opening stocktake
              </Button>
            )}
            <Button variant="primary" size="md" onClick={() => { setErr(null); setBuyOpen(true); }}>
              <ShoppingCart className="w-4 h-4" /> Record purchase
            </Button>
          </>
        ) : undefined}
      />

      <PageBody>
        {err && !anyModal && <Notice kind="error" onClose={() => setErr(null)}>{err}</Notice>}
        {notice && <Notice kind="success" onClose={() => setNotice(null)}>{notice}</Notice>}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          <StatCard title="Stock value" value={`PKR ${money(heldValue)}`} icon={Wallet} tone="brand" />
          <StatCard title="Units in store" value={money(unitsHeld)} icon={Boxes} tone="info" />
          <StatCard title="Item types" value={types.length} icon={Tags} tone="neutral" />
          <StatCard
            title="Kit required"
            value={settings?.kit_required_from ? formatDate(settings.kit_required_from) : "Off"}
            icon={settings?.kit_required_from ? ShieldCheck : ShieldOff}
            tone={settings?.kit_required_from ? "success" : "warning"}
          />
        </div>

        {/* ---- WHEN THE RULE STARTS ---- */}
        {canEdit && settings && (
          <Panel
            icon={CalendarClock}
            tone={settings.kit_required_from ? "success" : "warning"}
            title="Kit is required from"
            description="A deployment starting on or after this date needs an open issuance, and the check reports only from here. Leave it empty until the stocktake is in — 323 guards are deployed with kit that predates any of this."
          >
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <input className={inputCls + " sm:max-w-[13rem]"} type="date" value={kitFrom}
                     onChange={(e) => setKitFrom(e.target.value)} />
              <Button variant="secondary" size="md" disabled={busy} onClick={saveKitFrom}>
                {busy ? "Saving…" : "Save date"}
              </Button>
              {settings.kit_required_from
                ? <Badge tone="success">In force from {formatDate(settings.kit_required_from)}</Badge>
                : <Badge tone="warning">Not in force — nothing is refused or reported</Badge>}
            </div>
          </Panel>
        )}

        {/* ---- STOCK ON HAND ---- */}
        <Panel
          icon={Package}
          title="Stock on hand"
          description="New and used are separate stock of the same item. Issued kit is not here — it is on the Issuance tab."
          flush
        >
          <div className="flex flex-col md:flex-row md:items-center gap-3 px-4 md:px-5 py-3 border-b border-border">
            <SearchBox value={q} onChange={setQ} placeholder="Search item, size or serial…" />
            {presentCats.length > 1 && (
              <Tabs<"all" | Category>
                size="sm"
                value={cat}
                onChange={setCat}
                items={[{ value: "all", label: "All" }, ...presentCats.map((c) => ({ value: c, label: <span className="capitalize">{c}</span> }))]}
              />
            )}
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading stock…
            </div>
          ) : (
            <div className="p-3 md:p-2">
              <ResponsiveTable
                columns={stockCols}
                rows={shownStock}
                rowKey={(r) => r.id}
                empty={stock.length === 0
                  ? "Nothing in the store yet. Record a purchase, or enter the opening stocktake."
                  : "No stock matches this search."}
              />
              {shownStock.length > 0 && (
                <div className="flex items-center justify-between gap-3 mt-2 px-3 py-2.5 rounded-lg bg-muted/50 text-sm">
                  <span className="text-muted-foreground">
                    {cat === "all" && !q ? "On the balance sheet, at actual cost" : "Value of the rows shown, at actual cost"}
                  </span>
                  <span className="font-semibold tabular-nums">PKR {money(shownValue)}</span>
                </div>
              )}
            </div>
          )}
        </Panel>

        {/* ---- THE CATALOGUE ---- */}
        <Panel
          icon={Tags}
          tone="info"
          title="Item types"
          description="Set once. Tracked decides whether something is stock at all. A corrected replacement cost or life changes future clearances only — a fine already assessed keeps its figure."
          flush
        >
          <div className="p-3 md:p-2">
            <ResponsiveTable
              columns={typeCols}
              rows={types}
              rowKey={(t) => t.id}
              empty="No item types yet. Everything issued to a guard or a site needs one."
              actions={canEdit ? (t) => (
                <Button variant="ghost" size="sm" onClick={() => editType(t)}>
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </Button>
              ) : undefined}
            />
          </div>
        </Panel>
      </PageBody>

      {/* ---- NEW / CORRECT ITEM TYPE ---- */}
      {typeOpen && (
        <Modal
          isOpen
          onClose={closeType}
          title={editingType ? "Correct item type" : "New item type"}
          size="md"
          error={err}
          onDismissError={() => setErr(null)}
          footer={
            <ModalFooter>
              <Button variant="ghost" onClick={closeType}>Cancel</Button>
              <Button onClick={addType} disabled={busy || !nt.name.trim()}>
                {busy ? "Saving…" : editingType ? "Save correction" : "Add item type"}
              </Button>
            </ModalFooter>
          }
        >
          <div className="space-y-6">
            {editingType && (
              <Hint tone="info">
                A corrected replacement cost or useful life changes what a future clearance suggests.
                Fines already assessed keep the figure they were assessed at. Category, tracking and
                how it is counted are fixed once the type exists.
              </Hint>
            )}

            <FormSection step={1} title="What it is">
              <FormField label="Name" required>
                <input className={inputCls} value={nt.name} autoFocus placeholder="e.g. Summer shirt"
                       onChange={(e) => setNt({ ...nt, name: e.target.value })} />
              </FormField>
              <FormField label="Category" required>
                <ChoiceCards<Category>
                  columns={3}
                  disabled={!!editingType}
                  value={nt.category}
                  onChange={(c) => setNt({ ...nt, category: c, issuable: c === "office" ? false : nt.issuable })}
                  options={CATEGORIES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))}
                />
              </FormField>
              <ToggleCard
                checked={nt.issuable}
                disabled={!!editingType}
                onChange={(v) => setNt({ ...nt, issuable: v })}
                title="Issued to a guard or a site"
                sub="On — it is stock and every movement is tracked. Off — an office expense (stationery, tea, paper) that never touches inventory."
              />
            </FormSection>

            {nt.issuable && (
              <>
                <FormSection step={2} title="What it costs">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField label="Replacement cost (PKR)" required
                               hint="What ONE costs to replace. A bulk discount does not reduce it — fines read this. Actual cost comes from purchases.">
                      <input className={inputCls} type="number" min={0} value={nt.replacement_cost}
                             onChange={(e) => setNt({ ...nt, replacement_cost: e.target.value })} />
                    </FormField>
                    <FormField label="Useful life (months)" required
                               hint="Pro-rates the fine on kit returned unusable.">
                      <input className={inputCls} type="number" min={1} value={nt.useful_life_months}
                             onChange={(e) => setNt({ ...nt, useful_life_months: e.target.value })} />
                    </FormField>
                  </div>
                </FormSection>

                <FormSection step={3} title="How it is counted">
                  <ChoiceCards<"size" | "count" | "serial">
                    disabled={!!editingType}
                    value={nt.serialised ? "serial" : nt.sized ? "size" : "count"}
                    onChange={(v) => setNt({ ...nt, sized: v === "size", serialised: v === "serial" })}
                    options={[
                      { value: "size", label: "By size", sub: "Uniforms, boots — stock per size" },
                      { value: "count", label: "By count", sub: "Torches, whistles — one pool" },
                      { value: "serial", label: "Individually", sub: "Weapons — serial and licence each" },
                    ]}
                  />
                </FormSection>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* ---- PASTE ITEM TYPES ---- */}
      {catalogueOpen && (
        <Modal
          isOpen
          onClose={() => { setCatalogueOpen(false); setErr(null); }}
          title="Paste item types"
          size="lg"
          error={err}
          onDismissError={() => setErr(null)}
          footer={
            <ModalFooter summary={<PasteCount total={catalogueRows.length} bad={catalogueBad} noun="type" />}>
              <Button variant="ghost" onClick={() => { setCatalogueOpen(false); setErr(null); }}>Cancel</Button>
              <Button onClick={submitCatalogue}
                      disabled={busy || catalogueRows.length === 0 || catalogueBad > 0}>
                {busy ? "Adding…" : "Add item types"}
              </Button>
            </ModalFooter>
          }
        >
          <div className="space-y-5">
            <FormSection step={1} title="Paste from the spreadsheet">
              <ColumnChips cols={["Name", "Category", "Replacement cost", "Useful life (months)", "Shape"]} />
              <textarea className={textareaCls + " h-36"}
                        placeholder={"Summer shirt\tuniform\t1450\t12\tsize\nTorch\tkit\t900\t24\tcount\nPistol 9mm\tweapon\t68000\t120\tserial"}
                        value={cataloguePaste}
                        onChange={(e) => setCataloguePaste(e.target.value)} />
              <Hint>
                Category is one of {CATEGORIES.join(", ")}. Shape is <em>size</em>, <em>count</em> or <em>serial</em>.
                Replacement cost is today's undiscounted price — fines read it. Actual cost is not typed here;
                it comes from what was paid.
              </Hint>
            </FormSection>
            {catalogueRows.length > 0 && (
              <FormSection step={2} title="Check before adding">
                <PastePreview
                  rows={catalogueRows}
                  headers={["Name", "Category", "Replacement", "Life", "Shape"]}
                  cells={(r) => [r.name, <span className="capitalize">{r.category}</span>,
                    <span className="tabular-nums">{money(r.cost)}</span>, `${r.life} mo`, r.shape]}
                />
              </FormSection>
            )}
          </div>
        </Modal>
      )}

      {/* ---- OPENING STOCKTAKE ---- */}
      {openingOpen && (
        <Modal
          isOpen
          onClose={() => { setOpeningOpen(false); setErr(null); }}
          title="Opening stocktake"
          size="lg"
          error={err}
          onDismissError={() => setErr(null)}
          footer={
            <ModalFooter summary={
              <PasteCount total={openingRows.length} bad={openingBad} noun="line"
                extra={<span className="font-medium text-foreground">PKR {money(openingRows.reduce((a, r) => a + r.qty * r.cost, 0))}</span>} />
            }>
              <Button variant="ghost" onClick={() => { setOpeningOpen(false); setErr(null); }}>Cancel</Button>
              <Button onClick={submitOpening}
                      disabled={busy || openingRows.length === 0 || openingBad > 0}>
                {busy ? "Posting…" : "Post opening stocktake"}
              </Button>
            </ModalFooter>
          }
        >
          <div className="space-y-5">
            <Hint tone="info">
              Everything held at actual cost, plus everything already out against the guards holding it.
              It posts once, as an opening balance: inventory is debited and Opening Balance Equity takes
              the other side. Kit entered against a guard is marked as already costed, so historic issuance
              does not land on this month's client profitability.
            </Hint>
            <FormSection step={1} title="As of">
              <input className={inputCls + " sm:max-w-[13rem]"} type="date" value={opening.as_of}
                     onChange={(e) => setOpening({ ...opening, as_of: e.target.value })} />
            </FormSection>
            <FormSection step={2} title="Paste from the spreadsheet">
              <ColumnChips cols={OPENING_COLS} />
              <textarea className={textareaCls + " h-36"}
                        placeholder={"Summer shirt\tL\tnew\t\t120\t1450\nPistol 9mm\t\tnew\tAB-1123\t1\t68000\tHMC-024"}
                        value={opening.paste}
                        onChange={(e) => setOpening({ ...opening, paste: e.target.value })} />
              <Hint>
                Tab or comma separated, one line per item. Leave the guard code blank for anything in the
                store — either his client code or his permanent code works. Grade is <em>new</em> or <em>used</em>;
                serial only for items tracked individually.
              </Hint>
            </FormSection>
            {openingRows.length > 0 && (
              <FormSection step={3} title="Check before posting">
                <PastePreview
                  rows={openingRows}
                  headers={["Item", "Size", "Grade", "Serial", "Qty", "Each", "Held by", "Value"]}
                  cells={(r) => [r.itemName, r.size || "—", <span className="capitalize">{r.grade}</span>,
                    <span className="font-mono text-xs">{r.serial || "—"}</span>,
                    <span className="tabular-nums">{r.qty}</span>, <span className="tabular-nums">{money(r.cost)}</span>,
                    r.guardCode || <Badge tone="neutral">Store</Badge>,
                    <span className="tabular-nums font-medium">{money(r.qty * r.cost)}</span>]}
                />
              </FormSection>
            )}
          </div>
        </Modal>
      )}

      {/* ---- RECORD PURCHASE ---- */}
      {buyOpen && (
        <Modal
          isOpen
          onClose={() => { setBuyOpen(false); setErr(null); }}
          title="Record a purchase"
          size="lg"
          error={err}
          onDismissError={() => setErr(null)}
          footer={
            <ModalFooter summary={<>Total <span className="font-semibold text-foreground tabular-nums">PKR {money(purchaseTotal)}</span></>}>
              <Button variant="ghost" onClick={() => { setBuyOpen(false); setErr(null); }}>Cancel</Button>
              <Button onClick={submitPurchase} disabled={busy}>
                {busy ? "Posting…" : "Record purchase"}
              </Button>
            </ModalFooter>
          }
        >
          <div className="space-y-6">
            <Hint tone="info">
              Capitalised into inventory at actual cost — buying 200 uniforms does not touch profit and loss.
              The cost reaches it when the kit is issued, on the client it was issued to.
            </Hint>

            <FormSection step={1} title="The purchase">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label="Date" required>
                  <input className={inputCls} type="date" value={buy.purchase_date}
                         onChange={(e) => setBuy({ ...buy, purchase_date: e.target.value })} />
                </FormField>
                <FormField label="Description">
                  <input className={inputCls} value={buy.description} placeholder="Supplier, invoice no…"
                         onChange={(e) => setBuy({ ...buy, description: e.target.value })} />
                </FormField>
              </div>
              <FormField label="Paid by" required>
                <Pills value={buy.payment_mode} onChange={(m) => setBuy({ ...buy, payment_mode: m })}
                       options={["Payable", "Cash", "Bank", "Cheque"]} />
              </FormField>
            </FormSection>

            <FormSection step={2} title="What was bought">
              <div className="space-y-2">
                {buy.lines.map((l, i) => {
                  const t = typeById.get(l.item_type_id);
                  const lineTotal = Number(l.quantity || 0) * Number(l.unit_actual_cost || 0);
                  return (
                    <div key={i} className="rounded-lg border border-border bg-muted/30 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Line {i + 1}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-sm tabular-nums font-medium">PKR {money(lineTotal)}</span>
                          {buy.lines.length > 1 && (
                            <button type="button" aria-label="Remove line"
                                    className="p-1 rounded text-muted-foreground hover:text-danger-600 hover:bg-danger-50"
                                    onClick={() => setBuy((b) => ({ ...b, lines: b.lines.filter((_, j) => j !== i) }))}>
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-12 gap-3">
                        <FormField label="Item" className="col-span-2 sm:col-span-5">
                          <ThemedSelect value={l.item_type_id}
                            onChange={(e) => setLine(i, { item_type_id: e.target.value })}>
                            <option value="">Pick an item…</option>
                            {types.filter((x) => x.issuable && x.active)
                              .map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                          </ThemedSelect>
                        </FormField>
                        {t?.sized && (
                          <FormField label="Size" className="sm:col-span-2">
                            <input className={inputCls} value={l.size}
                                   onChange={(e) => setLine(i, { size: e.target.value })} />
                          </FormField>
                        )}
                        {t?.serialised && (
                          <FormField label="Serial" className="sm:col-span-3">
                            <input className={inputCls} value={l.serial_number}
                                   onChange={(e) => setLine(i, { serial_number: e.target.value })} />
                          </FormField>
                        )}
                        <FormField label="Qty" className="sm:col-span-2">
                          <input className={inputCls} type="number" min={1} value={l.quantity}
                                 onChange={(e) => setLine(i, { quantity: e.target.value })} />
                        </FormField>
                        <FormField label="Actual cost each" className={t?.sized || t?.serialised ? "sm:col-span-3" : "sm:col-span-5"}>
                          <input className={inputCls} type="number" min={0} value={l.unit_actual_cost}
                                 onChange={(e) => setLine(i, { unit_actual_cost: e.target.value })} />
                        </FormField>
                      </div>
                    </div>
                  );
                })}
              </div>
              <Button variant="secondary" size="sm"
                      onClick={() => setBuy((b) => ({ ...b, lines: [...b.lines, { ...emptyLine }] }))}>
                <Plus className="w-4 h-4" /> Add line
              </Button>
            </FormSection>
          </div>
        </Modal>
      )}
    </>
  );
}

/** The expected paste columns, in order, as chips. */
function ColumnChips({ cols }: { cols: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {cols.map((c, i) => (
        <span key={c} className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">{i + 1}</span> {c}
        </span>
      ))}
    </div>
  );
}
