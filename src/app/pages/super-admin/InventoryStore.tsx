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
import { Plus, Package, Loader2, Trash2 } from "lucide-react";
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

export default function InventoryStore() {
  const { profile } = useAuth();
  const canEdit = hasPermission(profile, "inventory.edit");

  const [types, setTypes] = useState<ItemType[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [typeOpen, setTypeOpen] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);

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
    const [t, s] = await Promise.all([
      supabase.from("inventory_item_types").select("*").order("name"),
      supabase.from("inventory_stock").select("*"),
    ]);
    if (t.error) setErr(t.error.message);
    setTypes((t.data ?? []) as ItemType[]);
    setStock((s.data ?? []) as StockRow[]);
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

  const addType = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.from("inventory_item_types").insert({
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
    setTypeOpen(false);
    setNt({ name: "", category: "uniform", issuable: true, replacement_cost: "",
            useful_life_months: "12", sized: true, serialised: false });
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

  const setLine = (i: number, patch: Partial<PurchaseLine>) =>
    setBuy((b) => ({ ...b, lines: b.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  return (
    <>
      <Header
        title="Store"
        subtitle="What is held, by exact quantity, at actual and replacement cost"
        actions={canEdit ? (
          <>
            <Button variant="secondary" size="md" onClick={() => setTypeOpen(true)}>
              <Plus className="w-4 h-4 mr-1.5" /> Item type
            </Button>
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
        {loading && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}

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
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  {["Item", "Category", "Tracked", "Actual", "Replacement", "Life", "Shape"].map((h) => (
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
                  </tr>
                ))}
                {types.length === 0 && !loading && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
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
        <Modal isOpen onClose={() => setTypeOpen(false)} title="New item type" size="sm">
          <div className="space-y-3">
            <div>
              <label className="block text-sm mb-1">Name *</label>
              <input className={FIELD} value={nt.name}
                     onChange={(e) => setNt({ ...nt, name: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm mb-1">Category *</label>
              <ThemedSelect value={nt.category}
                onChange={(e) => setNt({ ...nt, category: e.target.value as Category })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </ThemedSelect>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={nt.issuable}
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
                    <input type="radio" checked={nt.sized && !nt.serialised}
                           onChange={() => setNt({ ...nt, sized: true, serialised: false })} />
                    By size
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" checked={!nt.sized && !nt.serialised}
                           onChange={() => setNt({ ...nt, sized: false, serialised: false })} />
                    By count
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" checked={nt.serialised}
                           onChange={() => setNt({ ...nt, sized: false, serialised: true })} />
                    Individually (serial + licence)
                  </label>
                </div>
              </>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setTypeOpen(false)}>Cancel</Button>
              <Button onClick={addType} disabled={busy || !nt.name.trim()}>
                {busy ? "Saving…" : "Add"}
              </Button>
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
