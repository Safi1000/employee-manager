// Assets & Issuance (web AssetsIssuance): Store | Issuance | Clearance | Register.
import { useLocalSearchParams } from "expo-router";
import { ArrowLeftRight, ClipboardList, FileDown, Package, PackageOpen, Plus, Trash2, Undo2 } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Chips, Empty, HStack, IconBtn, Input, Ledger, ListCard, Row, SearchBar, Section, Tabs, Toggle } from "../../components/ui";
import { useDB } from "../../data/store";
import {
  addAmmoCount, addVehicle, addVehicleLog, ASSET_CATEGORIES, blankIssue, blankType, capitaliseAsset, CATEGORIES, Category, CONDITIONS, disposeAsset, emptyLine,
  handoverKit, Holding, issueKit, IssueForm, ItemType, KitItem, loadClearance, loadIssuance, loadRegister, loadStore, OPENING_COLS, openAssessment, opsClear,
  OUTCOMES, overrideFine, parseCatalogue, parseOpening, Pending, PurchaseLine, recordOpening, recordPurchase, recordSignature, releaseDues, returnKit, runDepreciation,
  saveKitFrom, saveType, setOutcome, submitCatalogue, sweepAmmo, TypeForm,
} from "../../data/api/assets";
import { loadBranding } from "../../data/api/exports";
import { useAuth } from "../../lib/auth";
import { fmtDate } from "../../lib/format";
import { brandingFromCompany } from "../../lib/web/pdfBranding";
import { generateClearanceCertificatePdf } from "../../lib/web/clearanceCertificatePdf";
import { useTheme } from "../../theme/ThemeProvider";

type Tab = "store" | "issuance" | "clearance" | "register";
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const money = (n: unknown) => Number(n ?? 0).toLocaleString();
const todayIso = () => new Date().toISOString().slice(0, 10);

/** One loader per tab, reloaded after each write — the web's `load`. */
function useLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => { try { setData(await fn()); setError(null); } catch (e) { setError(err(e)); } }, [fn]);
  useEffect(() => { const h = setTimeout(() => { void reload(); }, 0); return () => clearTimeout(h); }, [reload]);
  return { data, error, reload };
}

export default function Assets() {
  const { tab: initial } = useLocalSearchParams<{ tab?: Tab }>();
  const { canAny } = useAuth();
  const [tab, setTab] = useState<Tab>(initial ?? "store");
  return (
    <Screen eyebrow="Operations" title="Assets & Issuance"
      sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "store", label: "Store" }, { key: "issuance", label: "Issuance" }, ...(canAny(["clearance.ops", "clearance.finance", "inventory.view"]) ? [{ key: "clearance" as const, label: "Clearance" }] : []), { key: "register", label: "Register" }]} />}>
      {tab === "store" && <Store />}
      {tab === "issuance" && <Issuance />}
      {tab === "clearance" && <Clearance />}
      {tab === "register" && <Register />}
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────── Store
function Store() {
  const t = useTheme();
  const { can } = useAuth();
  const { db } = useDB();
  const { toast } = useOverlay();
  const canEdit = can("inventory.edit");
  const { data, error, reload } = useLoad(loadStore);
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const [typeOpen, setTypeOpen] = useState(false);
  const [editingType, setEditingType] = useState<string | null>(null);
  const [nt, setNt] = useState<TypeForm>(blankType);
  const [catOpen, setCatOpen] = useState(false);
  const [catPaste, setCatPaste] = useState("");
  const [buyOpen, setBuyOpen] = useState(false);
  const [buy, setBuy] = useState({ purchase_date: todayIso(), payment_mode: "Payable", description: "", lines: [emptyLine()] as PurchaseLine[] });
  const [openingOpen, setOpeningOpen] = useState(false);
  const [opening, setOpening] = useState({ as_of: todayIso(), paste: "" });
  const [kitFrom, setKitFrom] = useState<string | null>(null);

  const types = useMemo(() => data?.types ?? [], [data]);
  const typeById = useMemo(() => new Map(types.map((x) => [x.id, x])), [types]);
  const guardByCode = useMemo(() => new Map((data?.guards ?? []).filter((g) => g.guard_code).map((g) => [String(g.guard_code).toUpperCase(), g.id])), [data]);
  const catRows = useMemo(() => parseCatalogue(catPaste, types), [catPaste, types]);
  const openRows = useMemo(() => parseOpening(opening.paste, types, guardByCode), [opening.paste, types, guardByCode]);
  const heldValue = (data?.stock ?? []).reduce((a, r) => a + r.quantity * Number(r.unit_actual_cost), 0);
  const kf = kitFrom ?? data?.settings?.kit_required_from ?? "";
  const setLine = (i: number, patch: Partial<PurchaseLine>) => setBuy((b) => ({ ...b, lines: b.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  const doWrite = async (fn: () => Promise<unknown>, ok: string, close: () => void) => {
    setBusy(true); setSheetErr(null);
    try { await fn(); close(); toast(ok); await reload(); } catch (e) { setSheetErr(err(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {canEdit && data && (
        <HStack wrap style={{ marginBottom: 12 }}>
          <Button size="sm" variant="secondary" icon={Plus} label="Item type" onPress={() => { setEditingType(null); setNt(blankType()); setSheetErr(null); setTypeOpen(true); }} />
          <Button size="sm" variant="secondary" icon={ClipboardList} label="Paste item types" onPress={() => { setSheetErr(null); setCatOpen(true); }} />
          {data.batches === 0 && <Button size="sm" variant="secondary" icon={ClipboardList} label="Opening stocktake" onPress={() => { setSheetErr(null); setOpeningOpen(true); }} />}
          <Button size="sm" icon={Package} label="Record purchase" onPress={() => { setSheetErr(null); setBuyOpen(true); }} />
        </HStack>
      )}
      {canEdit && data?.settings && (
        <Section title="Kit is required from" hint="A deployment starting on or after this date needs an open issuance, and the check reports only from here. Leave it empty until the stocktake is in.">
          <HStack>
            <Input style={{ flex: 1 }} value={kf} onChangeText={setKitFrom} placeholder="YYYY-MM-DD (empty = off)" />
            <Button size="sm" variant="secondary" label="Save" disabled={busy} onPress={async () => {
              setBusy(true);
              try { await saveKitFrom(db.company.id, kf); toast(kf ? `Kit is required for deployments starting on or after ${kf}.` : "The kit requirement is off. Nothing is refused and nothing is reported."); await reload(); }
              catch (e) { toast(err(e), "danger"); } finally { setBusy(false); }
            }} />
          </HStack>
          <T v="small" muted>{data.settings.kit_required_from ? `In force from ${data.settings.kit_required_from}.` : "Not in force — nothing is refused and nothing is reported."}</T>
        </Section>
      )}
      {data && (
        <Section title="Stock on hand" hint="New and used are separate stock of the same item. Issued kit is on the Issuance tab.">
          <ListCard>
            {data.stock.map((r, i) => (
              <Row key={r.id} last={i === data.stock.length - 1} title={typeById.get(r.item_type_id)?.name ?? "—"}
                meta={[r.size, r.grade, r.serial_number].filter(Boolean).join(" · ")}
                right={<View style={{ alignItems: "flex-end" }}><T v="mono">{r.quantity} × {money(r.unit_actual_cost)}</T><T v="small" muted>{money(r.quantity * Number(r.unit_actual_cost))}</T></View>} />
            ))}
          </ListCard>
          {data.stock.length === 0 && <T v="small" muted>Nothing in the store yet. Record a purchase, or enter the opening stocktake.</T>}
          <Ledger label="On the balance sheet, at actual cost" value={money(heldValue)} strong />
        </Section>
      )}
      {data && (
        <Section title="Item types" hint="Replacement cost and useful life can be corrected later; a fine already assessed keeps the figure it was assessed at.">
          {types.map((x) => (
            <Card key={x.id} style={{ marginBottom: 8 }} onPress={canEdit ? () => {
              setEditingType(x.id); setSheetErr(null);
              setNt({ name: x.name, category: x.category, issuable: x.issuable, replacement_cost: String(x.replacement_cost), useful_life_months: String(x.useful_life_months), sized: x.sized, serialised: x.serialised });
              setTypeOpen(true);
            } : undefined}>
              <HStack>
                <View style={{ flex: 1 }}>
                  <T v="bodyStrong">{x.name}</T>
                  <T v="small" muted>{x.category} · {x.issuable ? "tracked" : "office expense"} · {x.sized ? "size" : x.serialised ? "serial" : "count"}</T>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <T v="small">Actual {money(x.actual_cost)}</T>
                  <T v="small" muted>Repl. {money(x.replacement_cost)} · {x.useful_life_months}m</T>
                </View>
              </HStack>
            </Card>
          ))}
        </Section>
      )}

      <Sheet open={typeOpen} onClose={() => setTypeOpen(false)} title={editingType ? "Edit item type" : "New item type"} error={sheetErr}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setTypeOpen(false)} /><Button label={busy ? "Saving…" : "Save"} full disabled={busy || !nt.name.trim()}
          onPress={() => doWrite(() => saveType(editingType, nt), "Item type saved", () => { setTypeOpen(false); setEditingType(null); setNt(blankType()); })} /></>}>
        {editingType && <T v="small" muted>A correction changes what a future clearance suggests. Category and shape are fixed once stock exists.</T>}
        <Input label="Name" required value={nt.name} onChangeText={(s) => setNt({ ...nt, name: s })} />
        {!editingType && <Select label="Category" required value={nt.category} onChange={(c) => setNt({ ...nt, category: c as Category })} options={CATEGORIES.map((c) => ({ value: c, label: c }))} />}
        {!editingType && <Toggle label="Issuable (tracked as stock)" sub="Off = an office expense, not stock" value={nt.issuable} onChange={(b) => setNt({ ...nt, issuable: b })} />}
        {nt.issuable && (
          <>
            <HStack>
              <Input style={{ flex: 1 }} label="Replacement cost" required keyboardType="numeric" value={nt.replacement_cost} onChangeText={(s) => setNt({ ...nt, replacement_cost: s })} />
              <Input style={{ flex: 1 }} label="Useful life (months)" required keyboardType="numeric" value={nt.useful_life_months} onChangeText={(s) => setNt({ ...nt, useful_life_months: s })} />
            </HStack>
            {!editingType && (
              <Chips value={nt.serialised ? "serial" : nt.sized ? "size" : "count"} onChange={(k) => setNt({ ...nt, sized: k === "size", serialised: k === "serial" })}
                items={[{ key: "size", label: "By size" }, { key: "count", label: "By count" }, { key: "serial", label: "By serial" }]} />
            )}
          </>
        )}
      </Sheet>

      <Sheet full open={catOpen} onClose={() => setCatOpen(false)} title="Paste item types" error={sheetErr}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setCatOpen(false)} /><Button full disabled={busy || catRows.length === 0 || catRows.some((r) => r.error)}
          label={catRows.some((r) => r.error) ? `${catRows.filter((r) => r.error).length} to fix` : `Add ${catRows.length}`}
          onPress={() => doWrite(() => submitCatalogue(catRows), `${catRows.length} item types added.`, () => { setCatOpen(false); setCatPaste(""); })} /></>}>
        <T v="small" muted>One per line: Name, Category, Replacement cost, Life (months), Shape (size / count / serial). Tab or comma separated.</T>
        <Input multiline value={catPaste} onChangeText={setCatPaste} style={{ minHeight: 140 }} />
        {catRows.map((r, i) => <T key={i} v="small" color={r.error ? t.tone("danger").text : t.tone("success").text}>{r.name || "—"}: {r.error ?? "ok"}</T>)}
      </Sheet>

      <Sheet full open={openingOpen} onClose={() => setOpeningOpen(false)} title="Opening stocktake" error={sheetErr}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setOpeningOpen(false)} /><Button full disabled={busy || openRows.length === 0 || openRows.some((r) => r.error)}
          label={openRows.some((r) => r.error) ? `${openRows.filter((r) => r.error).length} to fix` : `Post ${openRows.length} lines`}
          onPress={() => doWrite(() => recordOpening(opening.as_of, openRows), "Opening stocktake posted. Set the date kit becomes required to switch the rule on.", () => { setOpeningOpen(false); setOpening({ as_of: todayIso(), paste: "" }); })} /></>}>
        <Input label="As of" required value={opening.as_of} onChangeText={(s) => setOpening({ ...opening, as_of: s })} />
        <T v="small" muted>Columns: {OPENING_COLS.join(", ")}. A guard code puts the line straight into his hands.</T>
        <Input multiline value={opening.paste} onChangeText={(s) => setOpening({ ...opening, paste: s })} style={{ minHeight: 140 }} />
        {openRows.map((r, i) => <T key={i} v="small" color={r.error ? t.tone("danger").text : t.fg}>{r.itemName} {r.size} · {r.qty} × {r.cost}{r.guardCode ? ` → ${r.guardCode}` : ""}: {r.error ?? "ok"}</T>)}
      </Sheet>

      <Sheet full open={buyOpen} onClose={() => setBuyOpen(false)} title="Record purchase" error={sheetErr}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setBuyOpen(false)} /><Button label={busy ? "Posting…" : "Post purchase"} full disabled={busy}
          onPress={() => doWrite(() => recordPurchase(buy), "Purchase posted", () => { setBuyOpen(false); setBuy({ purchase_date: todayIso(), payment_mode: "Payable", description: "", lines: [emptyLine()] }); })} /></>}>
        <T v="small" muted>Actual cost is what was paid, after any bulk discount — it is the ledger figure. Replacement cost stays on the item type.</T>
        <HStack>
          <Input style={{ flex: 1 }} label="Date" required value={buy.purchase_date} onChangeText={(s) => setBuy({ ...buy, purchase_date: s })} />
          <View style={{ flex: 1 }}><Select label="Paid by" required value={buy.payment_mode} onChange={(m) => setBuy({ ...buy, payment_mode: m })} options={["Payable", "Cash", "Bank", "Cheque"].map((m) => ({ value: m, label: m }))} /></View>
        </HStack>
        <Input label="Description" value={buy.description} onChangeText={(s) => setBuy({ ...buy, description: s })} />
        {buy.lines.map((l, i) => {
          const tt = typeById.get(l.item_type_id) as ItemType | undefined;
          return (
            <Card key={i} style={{ marginBottom: 8 }}>
              <HStack>
                <View style={{ flex: 1 }}><Select label="Item" value={l.item_type_id} onChange={(v) => setLine(i, { item_type_id: v })} placeholder="Pick an item…" options={types.filter((x) => x.issuable).map((x) => ({ value: x.id, label: x.name }))} /></View>
                <IconBtn icon={Trash2} size={34} tone="danger" label="Remove line" onPress={() => setBuy((b) => ({ ...b, lines: b.lines.filter((_, j) => j !== i) }))} />
              </HStack>
              <HStack>
                {tt?.sized && <Input style={{ flex: 1 }} label="Size" value={l.size} onChangeText={(s) => setLine(i, { size: s })} />}
                {tt?.serialised && <Input style={{ flex: 1 }} label="Serial" value={l.serial_number} onChangeText={(s) => setLine(i, { serial_number: s })} />}
                <Input style={{ flex: 1 }} label="Qty" keyboardType="numeric" value={l.quantity} onChangeText={(s) => setLine(i, { quantity: s })} />
                <Input style={{ flex: 1 }} label="Actual each" keyboardType="numeric" value={l.unit_actual_cost} onChangeText={(s) => setLine(i, { unit_actual_cost: s })} />
              </HStack>
              {tt?.category === "weapon" && <Input label="Licence expiry" value={l.licence_expiry} onChangeText={(s) => setLine(i, { licence_expiry: s })} placeholder="YYYY-MM-DD" />}
            </Card>
          );
        })}
        <Button size="sm" variant="secondary" icon={Plus} label="Add line" onPress={() => setBuy((b) => ({ ...b, lines: [...b.lines, emptyLine()] }))} />
      </Sheet>
    </>
  );
}

// ──────────────────────────────────────────────────────────────── Issuance
function Issuance() {
  const t = useTheme();
  const { can } = useAuth();
  const { toast } = useOverlay();
  const canEdit = can("inventory.edit");
  const { data, error, reload } = useLoad(loadIssuance);
  const [q, setQ] = useState("");
  const [issueOpen, setIssueOpen] = useState(false);
  const [iss, setIss] = useState<IssueForm>(blankIssue);
  const [act, setAct] = useState<{ kind: "return" | "handover"; h: Holding } | null>(null);
  const [actForm, setActForm] = useState({ condition: "good", to_employee: "", quantity: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const typeName = useMemo(() => new Map((data?.types ?? []).map((x) => [x.id, x.name])), [data]);
  const empName = useMemo(() => new Map((data?.emps ?? []).map((x) => [x.id, x.full_name])), [data]);
  const clientName = useMemo(() => new Map((data?.clients ?? []).map((x) => [x.id, x.name])), [data]);
  const siteName = useMemo(() => new Map((data?.sites ?? []).map((x) => [x.id, x.name])), [data]);
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    const all = data?.holdings ?? [];
    if (!n) return all;
    return all.filter((h) => (typeName.get(h.item_type_id) ?? "").toLowerCase().includes(n) || (h.holder_employee_id ? empName.get(h.holder_employee_id) ?? "" : "").toLowerCase().includes(n) || (h.serial_number ?? "").toLowerCase().includes(n));
  }, [data, q, typeName, empName]);
  const available = (data?.stock ?? []).filter((r) => r.item_type_id === iss.item_type_id && r.quantity > 0);

  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {canEdit && data && <Button icon={PackageOpen} label="Issue kit" style={{ marginBottom: 10 }} onPress={() => { setSheetErr(null); setIssueOpen(true); }} />}
      <SearchBar value={q} onChange={setQ} placeholder="Search guard, item or serial…" />
      <View style={{ marginTop: 10 }}>
        {data && filtered.length === 0 && <Empty title="Nothing is out" sub="Kit issued from the store appears here until it is returned." />}
        {filtered.map((h) => (
          <Card key={h.issue_id} style={{ marginBottom: 8 }}>
            <HStack>
              <View style={{ flex: 1 }}>
                <T v="bodyStrong">{typeName.get(h.item_type_id) ?? "—"} × {h.outstanding_qty}</T>
                <T v="small" muted>{[h.size, h.grade, h.serial_number].filter(Boolean).join(" · ")}</T>
                <T v="small">{h.holder_employee_id ? empName.get(h.holder_employee_id) ?? "—" : siteName.get(h.holder_site_id ?? "") ?? "Site"}{h.client_id ? ` · ${clientName.get(h.client_id) ?? ""}` : ""}</T>
                <T v="small" muted>Issued {fmtDate(h.issued_on)} · taken on at {h.opening_condition} · {h.last_event} {fmtDate(h.last_event_date)}</T>
              </View>
            </HStack>
            {canEdit && (
              <HStack style={{ marginTop: 8 }}>
                <Button size="sm" variant="secondary" icon={Undo2} label="Return" onPress={() => { setSheetErr(null); setAct({ kind: "return", h }); setActForm({ condition: "good", to_employee: "", quantity: String(h.outstanding_qty), notes: "" }); }} />
                {h.holder_employee_id && <Button size="sm" variant="secondary" icon={ArrowLeftRight} label="Hand over" onPress={() => { setSheetErr(null); setAct({ kind: "handover", h }); setActForm({ condition: "good", to_employee: "", quantity: "", notes: "" }); }} />}
              </HStack>
            )}
          </Card>
        ))}
      </View>

      <Sheet full open={issueOpen} onClose={() => setIssueOpen(false)} title="Issue kit" error={sheetErr}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setIssueOpen(false)} /><Button label={busy ? "Issuing…" : "Issue"} full disabled={busy || !iss.item_type_id || (!iss.to_employee && !iss.site_id)} onPress={async () => {
          setBusy(true); setSheetErr(null);
          try { await issueKit(iss); setIssueOpen(false); setIss({ ...iss, item_type_id: "", size: "", serial: "", to_employee: "", site_id: "", quantity: "1", notes: "" }); toast("Kit issued"); await reload(); }
          catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
        }} /></>}>
        <Select label="Item" required searchable value={iss.item_type_id} onChange={(v) => setIss({ ...iss, item_type_id: v, size: "", grade: "new", serial: "" })} placeholder="Pick an item…" options={(data?.types ?? []).map((x) => ({ value: x.id, label: x.name }))} />
        {iss.item_type_id !== "" && (
          <>
            <Select label="From stock" required value={`${iss.size}|${iss.grade}|${iss.serial}`} onChange={(v) => { const [size, grade, serial] = v.split("|"); setIss({ ...iss, size, grade, serial }); }}
              options={available.map((r) => ({ value: `${r.size ?? ""}|${r.grade}|${r.serial_number ?? ""}`, label: `${[r.size, r.grade, r.serial_number].filter(Boolean).join(" · ")} — ${r.quantity} available` }))} />
            {available.length === 0 && <T v="small" color={t.tone("warning").text}>None of this item is in the store. Record a purchase first.</T>}
          </>
        )}
        <Select label="To guard" searchable clearable value={iss.to_employee} onChange={(v) => setIss({ ...iss, to_employee: v, site_id: v ? "" : iss.site_id })} options={(data?.emps ?? []).map((x) => ({ value: x.id, label: x.full_name, sub: x.guard_code ?? undefined }))} />
        <Select label="…or to a site" searchable clearable value={iss.site_id} onChange={(v) => setIss({ ...iss, site_id: v, to_employee: v ? "" : iss.to_employee })} options={(data?.sites ?? []).map((x) => ({ value: x.id, label: x.name }))} />
        <T v="small" muted>Consumables go to a guard and carry the client from his current deployment. Weapons and vehicles go to a client site.</T>
        <HStack>
          <Input style={{ flex: 1 }} label="Quantity" required keyboardType="numeric" value={iss.quantity} onChangeText={(s) => setIss({ ...iss, quantity: s })} />
          <View style={{ flex: 1 }}><Select label="Condition" required value={iss.condition} onChange={(c) => setIss({ ...iss, condition: c })} options={CONDITIONS.map((c) => ({ value: c, label: c }))} /></View>
        </HStack>
        <Input label="Date" required value={iss.event_date} onChangeText={(s) => setIss({ ...iss, event_date: s })} />
        <Input label="Note" value={iss.notes} onChangeText={(s) => setIss({ ...iss, notes: s })} />
      </Sheet>

      <Sheet open={!!act} onClose={() => setAct(null)} error={sheetErr} title={act ? `${act.kind === "return" ? "Return" : "Hand over"} — ${typeName.get(act.h.item_type_id) ?? ""}` : ""}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setAct(null)} /><Button full label={busy ? "Saving…" : act?.kind === "return" ? "Return" : "Hand over"} disabled={busy || (act?.kind === "handover" && !actForm.to_employee)} onPress={async () => {
          if (!act) return;
          setBusy(true); setSheetErr(null);
          try {
            if (act.kind === "return") await returnKit(act.h.issue_id, actForm); else await handoverKit(act.h.issue_id, actForm);
            setAct(null); setActForm({ condition: "good", to_employee: "", quantity: "", notes: "" }); toast(act.kind === "return" ? "Kit returned" : "Kit handed over"); await reload();
          } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
        }} /></>}>
        {act?.kind === "handover" ? (
          <>
            <Select label="To guard" required searchable value={actForm.to_employee} onChange={(v) => setActForm({ ...actForm, to_employee: v })} placeholder="Pick a guard…"
              options={(data?.emps ?? []).filter((x) => x.id !== act.h.holder_employee_id).map((x) => ({ value: x.id, label: x.full_name }))} />
            <T v="small" muted>Nothing is posted. The client already absorbed the cost at first issue, and the condition below becomes the receiving guard&apos;s opening condition.</T>
          </>
        ) : <Input label="Quantity" keyboardType="numeric" value={actForm.quantity} onChangeText={(s) => setActForm({ ...actForm, quantity: s })} />}
        <Select label="Condition" required value={actForm.condition} onChange={(c) => setActForm({ ...actForm, condition: c })} options={CONDITIONS.map((c) => ({ value: c, label: c }))} />
        {act?.kind === "return" && actForm.condition === "unusable" && <T v="small" color={t.tone("warning").text}>Unusable kit does not go back on the shelf — it is written off rather than counted as stock.</T>}
        <Input label="Note" value={actForm.notes} onChangeText={(s) => setActForm({ ...actForm, notes: s })} />
      </Sheet>
    </>
  );
}

// ─────────────────────────────────────────────────────────────── Clearance
function Clearance() {
  const t = useTheme();
  const { can, profile } = useAuth();
  const { db } = useDB();
  const { toast } = useOverlay();
  const canOps = can("clearance.ops");
  const canFin = can("clearance.finance");
  const { data, error, reload } = useLoad(loadClearance);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ emp: Pending; certId: string; items: KitItem[] } | null>(null);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const typeName = useMemo(() => new Map((data?.types ?? []).map((x) => [x.id, x.name])), [data]);
  const notCleared = (data?.pending ?? []).filter((p) => !p.ops_cleared_at);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { const r = await fn(); if (ok) toast(ok); await reload(); return r; } catch (e) { toast(err(e), "danger"); return undefined; } finally { setBusy(false); }
  };
  const printCertificate = async (r: any) => {
    try {
      const { company } = await loadBranding(db.company.id);
      generateClearanceCertificatePdf({
        branding: brandingFromCompany(company as never), full_name: r.full_name, guard_code: r.guard_code ?? "—", display_code: r.display_number ?? null,
        last_working_day: r.last_working_day ?? r.covers_to ?? null, separation_reason: r.separation_reason ?? null,
        clearance: {
          status: "cleared", kit_returned: Number(r.kit_fine_total ?? 0) === 0, outstanding_kit_count: 0, advance_settled: Number(r.outstanding_advance ?? 0) <= 0,
          outstanding_advance: r.outstanding_advance, incidents_reviewed: true, open_incident_count: 0, dues_released: r.dues_released, dues_released_on: r.dues_released_on ?? null,
          kit_summary: r.kit_summary, kit_fine_total: r.kit_fine_total, fine_written_off: r.fine_written_off, covers_to: r.covers_to, cumulative_paid: r.cumulative_paid,
        },
      } as never);
    } catch (e) { toast(err(e), "danger"); }
  };

  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      <Section title="Not cleared — Operations" count={notCleared.length} hint="Finance cannot see a guard until ops has cleared him, so a separation left here has nobody owed and nobody chasing, and his kit is out there.">
        {notCleared.map((p) => {
          const days = p.last_working_day ? Math.floor((new Date(todayIso()).getTime() - new Date(p.last_working_day).getTime()) / 86400000) : 0;
          return (
            <Card key={p.id} style={{ marginBottom: 8, backgroundColor: t.tone("warning").tint }}>
              <HStack>
                <View style={{ flex: 1 }}>
                  <T v="bodyStrong">{p.full_name}</T>
                  <T v="small" muted>{p.guard_code ?? "—"} · last day {p.last_working_day ? fmtDate(p.last_working_day) : "—"} · open {days} days</T>
                </View>
                {canOps && <Button size="sm" variant="secondary" label="Assess kit" disabled={busy} onPress={async () => {
                  setBusy(true); setSheetErr(null);
                  try { const r = await openAssessment(p.id); setOpen({ emp: p, ...r }); } catch (e) { toast(err(e), "danger"); } finally { setBusy(false); }
                }} />}
              </HStack>
            </Card>
          );
        })}
        {data && notCleared.length === 0 && <T v="small" muted>Nobody is waiting on operations.</T>}
      </Section>
      <Section title="Cleared by operations — Finance" count={data?.queue.length} hint="Payment waits on a wet signature: the certificate prints, he signs it, someone records it here, and only then can the money go out.">
        {(data?.queue ?? []).map((r) => (
          <Card key={r.certificate_id} style={{ marginBottom: 8 }}>
            <T v="bodyStrong">{r.full_name}</T>
            <Ledger label="Covers to" value={r.covers_to ? fmtDate(r.covers_to) : "—"} />
            <Ledger label="Kit outcome" value={r.kit_summary ?? "—"} />
            <Ledger label="Fine" value={money(r.kit_fine_total)} />
            {Number(r.fine_written_off ?? 0) > 0 && <Ledger label="Written off" value={money(r.fine_written_off)} tone="danger" />}
            <Ledger label="Undisbursed" value={money(r.undisbursed_salary)} />
            <Ledger label="Signed" value={r.signed_at ? fmtDate(r.signed_at) : "Awaiting"} tone={r.signed_at ? "success" : undefined} />
            <HStack wrap style={{ marginTop: 8 }}>
              <Button size="sm" variant="ghost" icon={FileDown} label="Certificate" onPress={() => printCertificate(r)} />
              {canFin && !r.signed_at && <Button size="sm" variant="secondary" label="Record signature" disabled={busy} onPress={() => run(() => recordSignature(r.certificate_id, profile?.id ?? null), "Signature recorded")} />}
              {canFin && r.signed_at && !r.dues_released && <Button size="sm" label="Release dues" disabled={busy} onPress={async () => {
                const amt = await run(() => releaseDues(r.certificate_id));
                if (amt !== undefined) toast(`Dues released — PKR ${money(amt)} is payable to him after the kit fine.`);
              }} />}
              {r.dues_released && <Badge small tone="success" label={`Released ${r.dues_released_on ? fmtDate(r.dues_released_on) : ""}`} />}
            </HStack>
          </Card>
        ))}
        {data && data.queue.length === 0 && <T v="small" muted>Nothing has been cleared by operations yet.</T>}
      </Section>

      <Sheet full open={!!open} onClose={() => setOpen(null)} title={open ? `Assess kit — ${open.emp.full_name}` : ""} error={sheetErr}
        subtitle={open ? `Total fine PKR ${money(open.items.reduce((a, i) => a + Number(i.fine || 0), 0))}` : undefined}
        footer={<><Button label="Close" variant="secondary" full onPress={() => setOpen(null)} /><Button full label={busy ? "Clearing…" : "Clear (Operations)"} disabled={busy || !open || open.items.some((i) => !i.outcome)} onPress={async () => {
          if (!open) return;
          setBusy(true); setSheetErr(null);
          try { await opsClear(open.certId); setOpen(null); toast("Cleared by operations"); await reload(); } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
        }} /></>}>
        {open && open.items.length === 0 && <T v="small" muted>He holds no kit on record. Clearing him now records that — it does not invent an issuance that never happened.</T>}
        {open?.items.map((it) => (
          <Card key={it.id} style={{ marginBottom: 8 }}>
            <T v="bodyStrong">{typeName.get(it.item_type_id) ?? "—"}{it.size ? ` · ${it.size}` : ""} × {it.quantity}</T>
            <T v="small" muted>Taken on at {it.opening_condition}</T>
            <Select label="Outcome" value={it.outcome ?? ""} onChange={async (o) => {
              try {
                const suggested = await setOutcome(it, o, profile?.id ?? null);
                setOpen((cur) => cur && ({ ...cur, items: cur.items.map((i) => (i.id === it.id ? { ...i, outcome: o, suggested_fine: suggested, fine: suggested } : i)) }));
              } catch (e) { setSheetErr(err(e)); }
            }} options={OUTCOMES.map((o) => ({ value: o.v, label: o.l }))} />
            <Ledger label="Suggested" value={money(it.suggested_fine)} />
            <Input label="Fine charged" keyboardType="numeric" value={String(it.fine)} onChangeText={(s) => {
              const fine = Number(s || 0);
              setOpen((cur) => cur && ({ ...cur, items: cur.items.map((i) => (i.id === it.id ? { ...i, fine } : i)) }));
              overrideFine(it.id, fine).catch((e) => setSheetErr(err(e)));
            }} />
          </Card>
        ))}
        <T v="small" muted>The fine is suggested, never imposed — every figure is overridable, and the suggestion is already adjusted for the condition he received the item in. Clearing him locks his attendance.</T>
      </Sheet>
    </>
  );
}

// ──────────────────────────────────────────────────────────────── Register
function Register() {
  const t = useTheme();
  const { db } = useDB();
  const { toast } = useOverlay();
  const companyId = db.company.id;
  const loader = useCallback(() => loadRegister(companyId), [companyId]);
  const { data, error, reload } = useLoad(loader);
  const [sub, setSub] = useState<"assets" | "vehicles" | "ammo">("assets");
  const [busy, setBusy] = useState(false);
  const blankAsset = () => ({ name: "", category: "equipment", cost: "", salvage_value: "0", useful_life_months: "60", acquisition_date: todayIso() });
  const [na, setNa] = useState(blankAsset);
  const [nv, setNv] = useState({ registration_no: "", make: "", model: "" });
  const [depPeriod, setDepPeriod] = useState(new Date().toISOString().slice(0, 8) + "01");
  const [log, setLog] = useState({ vid: "", logType: "fuel", date: todayIso(), odometer: "", litres: "", amount: "", desc: "" });
  const [ammo, setAmmo] = useState({ wid: "", issued: "", accounted: "" });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await reload(); return true; } catch (e) { toast(err(e), "danger"); return false; } finally { setBusy(false); }
  };

  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      <Chips value={sub} onChange={setSub} items={[{ key: "assets", label: "Fixed assets" }, { key: "vehicles", label: "Vehicles" }, { key: "ammo", label: `Ammunition${data?.discrepancies.length ? ` (${data.discrepancies.length}!)` : ""}` }]} />
      <View style={{ height: 10 }} />
      {data && sub === "assets" && (
        <>
          <Card style={{ marginBottom: 10 }}>
            <HStack>
              <Input style={{ flex: 1 }} label="Depreciation period" value={depPeriod} onChangeText={setDepPeriod} />
              <Button size="sm" variant="secondary" label="Run depreciation" disabled={busy} style={{ marginTop: 12 }} onPress={() => run(() => runDepreciation(companyId, depPeriod), "Depreciation run")} />
            </HStack>
          </Card>
          <Section title="New asset (capitalised)">
            <Card>
              <Input label="Name" value={na.name} onChangeText={(s) => setNa({ ...na, name: s })} />
              <Select label="Category" value={na.category} onChange={(c) => setNa({ ...na, category: c })} options={ASSET_CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, " ") }))} />
              <Input label="Acquisition date" value={na.acquisition_date} onChangeText={(s) => setNa({ ...na, acquisition_date: s })} />
              <HStack>
                <Input style={{ flex: 1 }} label="Cost" keyboardType="numeric" value={na.cost} onChangeText={(s) => setNa({ ...na, cost: s })} />
                <Input style={{ flex: 1 }} label="Salvage value" keyboardType="numeric" value={na.salvage_value} onChangeText={(s) => setNa({ ...na, salvage_value: s })} />
                <Input style={{ flex: 1 }} label="Life (months)" keyboardType="numeric" value={na.useful_life_months} onChangeText={(s) => setNa({ ...na, useful_life_months: s })} />
              </HStack>
              <Button label="Capitalise asset" disabled={busy || !na.name || !na.cost} onPress={async () => { if (await run(() => capitaliseAsset(na), "Asset capitalised")) setNa(blankAsset()); }} />
            </Card>
          </Section>
          {data.assets.map((a) => (
            <Card key={a.id} style={{ marginBottom: 8 }}>
              <HStack>
                <View style={{ flex: 1 }}><T v="bodyStrong">{a.name}</T><T v="small" muted>{a.region_name ?? "—"}</T></View>
                <Badge small label={a.status} tone={a.status === "active" ? "success" : undefined} />
              </HStack>
              <Ledger label="Cost" value={money(a.cost)} />
              <Ledger label="Accum. dep" value={money(a.accumulated_depreciation)} />
              <Ledger label="NBV" value={money(a.net_book_value)} strong />
              {a.status === "active" && <Button size="sm" variant="secondary" label="Dispose" style={{ alignSelf: "flex-start", marginTop: 6 }} disabled={busy} onPress={() => run(() => disposeAsset(a.id), "Asset disposed")} />}
            </Card>
          ))}
        </>
      )}
      {data && sub === "vehicles" && (
        <>
          <Section title="New vehicle">
            <Card>
              <Input label="Registration no." value={nv.registration_no} onChangeText={(s) => setNv({ ...nv, registration_no: s })} />
              <HStack>
                <Input style={{ flex: 1 }} label="Make" value={nv.make} onChangeText={(s) => setNv({ ...nv, make: s })} />
                <Input style={{ flex: 1 }} label="Model" value={nv.model} onChangeText={(s) => setNv({ ...nv, model: s })} />
              </HStack>
              <Button label="Add vehicle" disabled={busy || !nv.registration_no} onPress={async () => { if (await run(() => addVehicle(nv), "Vehicle added")) setNv({ registration_no: "", make: "", model: "" }); }} />
            </Card>
          </Section>
          {data.vehicles.length > 0 && (
            <Section title="Log trip / fuel / maintenance">
              <Card>
                <Select label="Vehicle" value={log.vid} onChange={(v) => setLog({ ...log, vid: v })} placeholder="— vehicle —" options={data.vehicles.map((v) => ({ value: v.id, label: v.registration_no }))} />
                <Chips value={log.logType} onChange={(k) => setLog({ ...log, logType: k })} items={["fuel", "trip", "maintenance"].map((k) => ({ key: k, label: k }))} />
                <Input label="Date" value={log.date} onChangeText={(s) => setLog({ ...log, date: s })} />
                <HStack>
                  <Input style={{ flex: 1 }} label="Odometer (km)" keyboardType="numeric" value={log.odometer} onChangeText={(s) => setLog({ ...log, odometer: s })} />
                  {log.logType === "fuel" && <Input style={{ flex: 1 }} label="Litres" keyboardType="numeric" value={log.litres} onChangeText={(s) => setLog({ ...log, litres: s })} />}
                  <Input style={{ flex: 1 }} label="Amount (PKR)" keyboardType="numeric" value={log.amount} onChangeText={(s) => setLog({ ...log, amount: s })} />
                </HStack>
                <Input label="Description" value={log.desc} onChangeText={(s) => setLog({ ...log, desc: s })} />
                <Button label="Add log" disabled={busy || !log.vid} onPress={async () => {
                  const veh = data.vehicles.find((v) => v.id === log.vid);
                  if (await run(() => addVehicleLog(companyId, veh, log), "Log added")) setLog({ ...log, odometer: "", litres: "", amount: "", desc: "" });
                }} />
              </Card>
            </Section>
          )}
          <ListCard>
            {data.vehicles.map((v, i) => {
              const cost = data.vehicleCost.filter((c) => c.vehicle_id === v.id).reduce((s, c) => s + Number(c.total_cost ?? 0), 0);
              return <Row key={v.id} last={i === data.vehicles.length - 1} title={`${v.registration_no} · ${v.make ?? ""} ${v.model ?? ""}`} right={<T v="small" muted>running cost {money(cost)}</T>} />;
            })}
          </ListCard>
        </>
      )}
      {data && sub === "ammo" && (
        <>
          {data.discrepancies.length > 0 && (
            <Banner tone="danger" title={`${data.discrepancies.length} open ammunition discrepancy(ies) — blocking-tier.`}
              action={<Button size="sm" variant="secondary" label="Raise blocking alerts" disabled={busy} onPress={() => run(() => sweepAmmo(companyId), "Alerts raised")} />} />
          )}
          <Section title="Record ammunition count">
            <Card>
              <Select label="Weapon" value={ammo.wid} onChange={(v) => setAmmo({ ...ammo, wid: v })} placeholder="— weapon —" options={data.weapons.map((w) => ({ value: w.id, label: `${w.item_type}${w.serial_number ? ` #${w.serial_number}` : ""}` }))} />
              <HStack>
                <Input style={{ flex: 1 }} label="Issued" keyboardType="numeric" value={ammo.issued} onChangeText={(s) => setAmmo({ ...ammo, issued: s })} />
                <Input style={{ flex: 1 }} label="Accounted" keyboardType="numeric" value={ammo.accounted} onChangeText={(s) => setAmmo({ ...ammo, accounted: s })} />
              </HStack>
              <Button label="Record" disabled={busy || !ammo.wid || !ammo.issued} onPress={async () => { if (await run(() => addAmmoCount(ammo.wid, ammo.issued, ammo.accounted), "Count recorded")) setAmmo({ wid: "", issued: "", accounted: "" }); }} />
            </Card>
          </Section>
          <ListCard>
            {data.ammo.map((a, i) => (
              <Row key={a.id} last={i === data.ammo.length - 1} title={fmtDate(a.count_date)} meta={`Issued ${a.issued_rounds} · Accounted ${a.accounted_rounds}`}
                right={<T v="mono" color={Number(a.discrepancy) !== 0 ? t.tone("danger").text : t.fg}>{a.discrepancy}</T>} />
            ))}
          </ListCard>
        </>
      )}
    </>
  );
}


