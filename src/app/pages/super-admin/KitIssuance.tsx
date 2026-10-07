// ── Issuance: three events, not two ─────────────────────────────────────────
//
//   Issue     store → guard, or store → client site
//   Return    guard → store
//   Handover  guard → guard at the same site. The kit never returns to the store.
//
// THE THIRD ONE IS WHY THIS SCREEN WAS REBUILT. The old table held an issue and
// a return date, so a handover had to be recorded as a return plus a fresh
// issue — which is wrong twice: the kit never went near the store, and the
// second issue charges the client again for kit it already paid for.
//
// EVERY EVENT RECORDS CONDITION, and the condition a guard RECEIVED an item in
// becomes his opening condition. He is judged against the state he took it on
// at, never against new, so he is not fined for wear that was already there.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Boxes, Loader2, MapPin, PackageOpen, Undo2, User, Users } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import Picker from "./_assetsPicker";
import StatCard from "../../components/StatCard";
import Badge from "../../components/Badge";
import Tabs from "../../components/Tabs";
import ResponsiveTable, { type Column } from "../../components/ResponsiveTable";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { formatDate } from "../../lib/date";
import { useEmployeeCodeIndex } from "../../lib/employeeCodes";
import {
  ChoiceCards, FormField, FormSection, Hint, ModalFooter, Notice, PageBody, Panel, Pills,
  SearchBox, SubjectCard, inputCls,
} from "./_assetsKit";
const CONDITIONS = ["new", "good", "fair", "rough", "unusable"] as const;

type Holding = {
  issue_id: string;
  item_type_id: string;
  size: string | null;
  grade: string;
  serial_number: string | null;
  client_id: string | null;
  issued_on: string;
  outstanding_qty: number;
  holder_employee_id: string | null;
  holder_site_id: string | null;
  opening_condition: string;
  last_event: string;
  last_event_date: string;
};

type Named = { id: string; name: string };

export default function KitIssuance() {
  const { profile } = useAuth();
  const canEdit = hasPermission(profile, "inventory.edit");

  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [types, setTypes] = useState<Named[]>([]);
  const [stock, setStock] = useState<any[]>([]);
  const [emps, setEmps] = useState<{ id: string; full_name: string; guard_code: string | null }[]>([]);
  const [clients, setClients] = useState<Named[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string; client_id: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const [issueOpen, setIssueOpen] = useState(false);
  const [act, setAct] = useState<{ kind: "return" | "handover"; h: Holding } | null>(null);

  const [iss, setIss] = useState({
    item_type_id: "", size: "", grade: "new", serial: "",
    to_employee: "", site_id: "", quantity: "1",
    condition: "new", event_date: new Date().toISOString().slice(0, 10), notes: "",
  });
  const [actForm, setActForm] = useState({ condition: "good", to_employee: "", quantity: "", notes: "" });

  const load = useCallback(async () => {
    setLoading(true);
    const [h, t, s, e, c, si] = await Promise.all([
      supabase.from("kit_holdings").select("*"),
      supabase.from("inventory_item_types").select("id, name").eq("issuable", true).order("name"),
      supabase.from("inventory_stock").select("*"),
      supabase.from("employees").select("id, full_name, guard_code")
        .eq("lifecycle_state", "active").order("full_name"),
      supabase.from("clients").select("id, name").order("name"),
      supabase.from("sites").select("id, name, client_id").order("name"),
    ]);
    if (h.error) setErr(h.error.message);
    setHoldings((h.data ?? []) as Holding[]);
    setTypes((t.data ?? []) as Named[]);
    setStock(s.data ?? []);
    setEmps((e.data ?? []) as any[]);
    setClients((c.data ?? []) as Named[]);
    setSites((si.data ?? []) as any[]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const typeName = useMemo(() => new Map(types.map((t) => [t.id, t.name])), [types]);
  const empName = useMemo(() => new Map(emps.map((e) => [e.id, e.full_name])), [emps]);
  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  const siteName = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return holdings;
    return holdings.filter((h) =>
      (typeName.get(h.item_type_id) ?? "").toLowerCase().includes(needle) ||
      (h.holder_employee_id ? (empName.get(h.holder_employee_id) ?? "") : "").toLowerCase().includes(needle) ||
      (h.serial_number ?? "").toLowerCase().includes(needle));
  }, [holdings, q, typeName, empName]);

  // The sizes and grades actually in the store for the chosen item, so the form
  // offers what exists rather than what could be typed.
  const availableFor = useMemo(
    () => stock.filter((r) => r.item_type_id === iss.item_type_id && r.quantity > 0),
    [stock, iss.item_type_id]);

  const doIssue = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("issue_kit", {
      p_item_type_id: iss.item_type_id,
      p_to_employee: iss.to_employee || null,
      p_site_id: iss.site_id || null,
      p_size: iss.size || null,
      p_grade: iss.grade,
      p_serial: iss.serial || null,
      p_quantity: Number(iss.quantity || 1),
      p_condition: iss.condition,
      p_event_date: iss.event_date,
      p_notes: iss.notes.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setIssueOpen(false);
    setIss({ ...iss, item_type_id: "", size: "", serial: "", to_employee: "", site_id: "", quantity: "1", notes: "" });
    load();
  };

  const doAct = async () => {
    if (!act) return;
    setBusy(true); setErr(null);
    const { error } = act.kind === "return"
      ? await supabase.rpc("return_kit", {
          p_issue_id: act.h.issue_id,
          p_quantity: actForm.quantity ? Number(actForm.quantity) : null,
          p_condition: actForm.condition,
          p_notes: actForm.notes.trim() || null,
        })
      : await supabase.rpc("handover_kit", {
          p_issue_id: act.h.issue_id,
          p_to_employee: actForm.to_employee,
          p_condition: actForm.condition,
          p_notes: actForm.notes.trim() || null,
        });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setAct(null);
    setActForm({ condition: "good", to_employee: "", quantity: "", notes: "" });
    load();
  };

  // ── Presentation state ──
  const codeIndex = useEmployeeCodeIndex();
  const [who, setWho] = useState<"all" | "guard" | "site">("all");
  const [target, setTarget] = useState<"guard" | "site">("guard");
  const empLabel = (id: string) => {
    const name = empName.get(id) ?? "—";
    const code = codeIndex.byId.get(id);
    return code ? `${name} · ${code}` : name;
  };
  // Guards for a picker: name, client code underneath, and how much kit he
  // already holds on the right.
  const heldBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of holdings) if (h.holder_employee_id) m.set(h.holder_employee_id, (m.get(h.holder_employee_id) ?? 0) + 1);
    return m;
  }, [holdings]);
  const guardOptions = (exclude?: string | null) => emps
    .filter((e) => e.id !== exclude)
    .map((e) => ({
      value: e.id,
      label: e.full_name,
      sub: codeIndex.byId.get(e.id) ?? e.guard_code ?? undefined,
      meta: heldBy.get(e.id) ? `holds ${heldBy.get(e.id)}` : undefined,
    }));
  const shown = useMemo(() => filtered.filter((h) =>
    who === "all" ? true : who === "guard" ? !!h.holder_employee_id : !h.holder_employee_id),
  [filtered, who]);
  const unitsOut = useMemo(() => holdings.reduce((a, h) => a + Number(h.outstanding_qty || 0), 0), [holdings]);
  const guardsHolding = useMemo(
    () => new Set(holdings.map((h) => h.holder_employee_id).filter(Boolean)).size, [holdings]);
  const sitesHolding = useMemo(
    () => new Set(holdings.filter((h) => !h.holder_employee_id).map((h) => h.holder_site_id).filter(Boolean)).size, [holdings]);
  const closeIssue = () => { setIssueOpen(false); setErr(null); };
  const closeAct = () => { setAct(null); setErr(null); };
  const stockKey = `${iss.size}|${iss.grade}|${iss.serial}`;
  const picked = availableFor.find((r) => `${r.size ?? ""}|${r.grade}|${r.serial_number ?? ""}` === stockKey);

  const cols: Column<Holding>[] = [
    { key: "item", header: "Item", primary: true, cell: (h) => (
      <div>
        <div className="font-medium">{typeName.get(h.item_type_id) ?? "—"}</div>
        {[h.size, h.grade, h.serial_number].some(Boolean) && (
          <div className="text-[11px] text-muted-foreground">{[h.size, h.grade, h.serial_number].filter(Boolean).join(" · ")}</div>
        )}
      </div>
    ) },
    { key: "holder", header: "Held by", cell: (h) => h.holder_employee_id ? (
      <div className="flex items-center gap-1.5 min-w-0">
        <User className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <span className="truncate">{empName.get(h.holder_employee_id) ?? "—"}</span>
        {codeIndex.byId.get(h.holder_employee_id) && (
          <span className="font-mono text-[11px] text-muted-foreground">{codeIndex.byId.get(h.holder_employee_id)}</span>
        )}
      </div>
    ) : (
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="truncate">{siteName.get(h.holder_site_id ?? "") ?? "Site"}</span>
      </div>
    ) },
    { key: "client", header: "Client", hideOnMobile: true, cell: (h) =>
      <span className="text-muted-foreground">{h.client_id ? clientName.get(h.client_id) ?? "—" : "—"}</span> },
    { key: "qty", header: "Qty", className: "text-right tabular-nums", cell: (h) => h.outstanding_qty },
    { key: "issued", header: "Issued", cell: (h) => formatDate(h.issued_on) },
    { key: "cond", header: "Taken on at", cell: (h) => <ConditionBadge c={h.opening_condition} /> },
    { key: "last", header: "Last event", hideOnMobile: true, cell: (h) => (
      <span className="text-muted-foreground"><span className="capitalize">{h.last_event}</span> · {formatDate(h.last_event_date)}</span>
    ) },
  ];

  return (
    <>
      <Header
        title="Issuance"
        subtitle="Who holds what, and the condition they took it on at"
        actions={canEdit ? (
          <Button variant="primary" size="md" onClick={() => { setErr(null); setIssueOpen(true); }}>
            <PackageOpen className="w-4 h-4" /> Issue kit
          </Button>
        ) : undefined}
      />

      <PageBody>
        {err && !issueOpen && !act && <Notice kind="error" onClose={() => setErr(null)}>{err}</Notice>}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          <StatCard title="Issuances out" value={holdings.length} icon={PackageOpen} tone="brand" />
          <StatCard title="Units out" value={unitsOut.toLocaleString()} icon={Boxes} tone="info" />
          <StatCard title="Guards holding kit" value={guardsHolding} icon={Users} tone="success" />
          <StatCard title="Sites holding kit" value={sitesHolding} icon={MapPin} tone="neutral" />
        </div>

        <Panel
          icon={ArrowRightLeft}
          title="Kit out"
          description="Issue sends kit from the store; Return brings it back; Handover passes it guard to guard at the same site without touching the store or charging the client again."
          flush
        >
          <div className="flex flex-col md:flex-row md:items-center gap-3 px-4 md:px-5 py-3 border-b border-border">
            <SearchBox value={q} onChange={setQ} placeholder="Search guard, item or serial…" />
            <Tabs<"all" | "guard" | "site">
              size="sm"
              value={who}
              onChange={setWho}
              items={[
                { value: "all", label: "All", count: filtered.length },
                { value: "guard", label: "Guards", count: filtered.filter((h) => !!h.holder_employee_id).length },
                { value: "site", label: "Sites", count: filtered.filter((h) => !h.holder_employee_id).length },
              ]}
            />
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading issuances…
            </div>
          ) : (
            <div className="p-3 md:p-2">
              <ResponsiveTable
                columns={cols}
                rows={shown}
                rowKey={(h) => h.issue_id}
                empty={holdings.length === 0
                  ? "Nothing is out. Kit issued from the store appears here until it is returned."
                  : "Nothing matches this search."}
                actions={canEdit ? (h) => (
                  <div className="inline-flex gap-1">
                    <Button variant="ghost" size="sm"
                            onClick={() => { setErr(null); setAct({ kind: "return", h }); setActForm({ condition: "good", to_employee: "", quantity: String(h.outstanding_qty), notes: "" }); }}>
                      <Undo2 className="w-3.5 h-3.5" /> Return
                    </Button>
                    {h.holder_employee_id && (
                      <Button variant="ghost" size="sm"
                              onClick={() => { setErr(null); setAct({ kind: "handover", h }); setActForm({ condition: "good", to_employee: "", quantity: "", notes: "" }); }}>
                        <ArrowRightLeft className="w-3.5 h-3.5" /> Handover
                      </Button>
                    )}
                  </div>
                ) : undefined}
              />
            </div>
          )}
        </Panel>
      </PageBody>

      {/* ---- ISSUE ---- */}
      {issueOpen && (
        <Modal
          isOpen
          onClose={closeIssue}
          title="Issue kit"
          size="md"
          error={err}
          onDismissError={() => setErr(null)}
          footer={
            <ModalFooter summary={picked ? <>{picked.quantity} in store</> : undefined}>
              <Button variant="ghost" onClick={closeIssue}>Cancel</Button>
              <Button onClick={doIssue}
                      disabled={busy || !iss.item_type_id || (!iss.to_employee && !iss.site_id)}>
                {busy ? "Issuing…" : "Issue kit"}
              </Button>
            </ModalFooter>
          }
        >
          <div className="space-y-6">
            <FormSection step={1} title="What">
              <FormField label="Item" required>
                <Picker
                  value={iss.item_type_id}
                  onChange={(v) => setIss({ ...iss, item_type_id: v, size: "", serial: "" })}
                  placeholder="Pick an item…"
                  searchPlaceholder="Search items…"
                  options={types.map((t) => {
                    const left = stock.filter((r) => r.item_type_id === t.id).reduce((a, r) => a + Number(r.quantity || 0), 0);
                    return { value: t.id, label: t.name, meta: left > 0 ? `${left} in store` : "none in store" };
                  })}
                />
              </FormField>
              {iss.item_type_id && (
                availableFor.length === 0 ? (
                  <Hint tone="warning">None of this item is in the store. Record a purchase first.</Hint>
                ) : (
                  <FormField label="From stock" required>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {availableFor.map((r) => {
                        const key = `${r.size ?? ""}|${r.grade}|${r.serial_number ?? ""}`;
                        const active = key === stockKey;
                        return (
                          <button key={r.id} type="button"
                                  onClick={() => setIss({ ...iss, size: r.size ?? "", grade: r.grade, serial: r.serial_number ?? "" })}
                                  className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                                    active ? "border-brand-500 bg-brand-500/10 ring-1 ring-brand-500/40" : "border-border hover:bg-accent"
                                  }`}>
                            <span className="text-sm">
                              {[r.size, r.serial_number].filter(Boolean).join(" · ") || "Standard"}
                              <span className="ml-1.5"><Badge tone={r.grade === "new" ? "success" : "neutral"} className="capitalize">{r.grade}</Badge></span>
                            </span>
                            <span className="text-xs text-muted-foreground tabular-nums">{r.quantity} left</span>
                          </button>
                        );
                      })}
                    </div>
                  </FormField>
                )
              )}
            </FormSection>

            <FormSection step={2} title="To whom">
              <ChoiceCards<"guard" | "site">
                columns={2}
                value={target}
                onChange={(v) => { setTarget(v); setIss({ ...iss, to_employee: "", site_id: "" }); }}
                options={[
                  { value: "guard", label: "A guard", sub: "Consumables — carries the client of his current deployment" },
                  { value: "site", label: "A client site", sub: "Weapons and vehicles" },
                ]}
              />
              {target === "guard" ? (
                <FormField label="Guard" required>
                  <Picker
                    value={iss.to_employee}
                    onChange={(v) => setIss({ ...iss, to_employee: v, site_id: "" })}
                    placeholder="Pick a guard…"
                    searchPlaceholder="Search name or code…"
                    options={guardOptions()}
                  />
                </FormField>
              ) : (
                <FormField label="Site" required>
                  <Picker
                    value={iss.site_id}
                    onChange={(v) => setIss({ ...iss, site_id: v, to_employee: "" })}
                    placeholder="Pick a site…"
                    searchPlaceholder="Search site or client…"
                    options={sites.map((s) => ({ value: s.id, label: s.name, sub: clientName.get(s.client_id) ?? undefined }))}
                  />
                </FormField>
              )}
            </FormSection>

            <FormSection step={3} title="Details">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label="Quantity" required>
                  <input className={inputCls} type="number" min={1} value={iss.quantity}
                         onChange={(e) => setIss({ ...iss, quantity: e.target.value })} />
                </FormField>
                <FormField label="Date" required>
                  <input className={inputCls} type="date" value={iss.event_date}
                         onChange={(e) => setIss({ ...iss, event_date: e.target.value })} />
                </FormField>
              </div>
              <FormField label="Condition it leaves in" required
                         hint="Becomes his opening condition — he is judged against this, never against new.">
                <Pills value={iss.condition} onChange={(c) => setIss({ ...iss, condition: c })} options={CONDITIONS} />
              </FormField>
              <FormField label="Note">
                <input className={inputCls} value={iss.notes} placeholder="Optional"
                       onChange={(e) => setIss({ ...iss, notes: e.target.value })} />
              </FormField>
            </FormSection>
          </div>
        </Modal>
      )}

      {/* ---- RETURN / HANDOVER ---- */}
      {act && (
        <Modal
          isOpen
          onClose={closeAct}
          title={act.kind === "return" ? "Return to store" : "Hand over to another guard"}
          size="sm"
          error={err}
          onDismissError={() => setErr(null)}
          footer={
            <ModalFooter>
              <Button variant="ghost" onClick={closeAct}>Cancel</Button>
              <Button onClick={doAct}
                      disabled={busy || (act.kind === "handover" && !actForm.to_employee)}>
                {busy ? "Saving…" : act.kind === "return" ? "Return to store" : "Hand over"}
              </Button>
            </ModalFooter>
          }
        >
          <div className="space-y-5">
            <SubjectCard
              title={typeName.get(act.h.item_type_id) ?? "—"}
              meta={<>
                {[act.h.size, act.h.grade, act.h.serial_number].filter(Boolean).join(" · ")}
                {act.h.holder_employee_id ? <> · held by {empLabel(act.h.holder_employee_id)}</> : null}
              </>}
              aside={<Badge tone="brand">{act.h.outstanding_qty} out</Badge>}
            />

            {act.kind === "handover" ? (
              <>
                <FormField label="To guard" required>
                  <Picker
                    value={actForm.to_employee}
                    onChange={(v) => setActForm({ ...actForm, to_employee: v })}
                    placeholder="Pick a guard…"
                    searchPlaceholder="Search name or code…"
                    options={guardOptions(act.h.holder_employee_id)}
                  />
                </FormField>
                <Hint tone="info">
                  Nothing is posted — the client already absorbed the cost at first issue. The condition
                  below becomes the receiving guard's opening condition.
                </Hint>
              </>
            ) : (
              <FormField label="Quantity returning" hint={`Up to ${act.h.outstanding_qty}.`}>
                <input className={inputCls} type="number" min={1} max={act.h.outstanding_qty}
                       value={actForm.quantity}
                       onChange={(e) => setActForm({ ...actForm, quantity: e.target.value })} />
              </FormField>
            )}

            <FormField label="Condition" required>
              <Pills value={actForm.condition} onChange={(c) => setActForm({ ...actForm, condition: c })} options={CONDITIONS} />
            </FormField>
            {act.kind === "return" && actForm.condition === "unusable" && (
              <Hint tone="warning">
                Unusable kit does not go back on the shelf — it is written off rather than counted as stock.
              </Hint>
            )}

            <FormField label="Note">
              <input className={inputCls} value={actForm.notes} placeholder="Optional"
                     onChange={(e) => setActForm({ ...actForm, notes: e.target.value })} />
            </FormField>
          </div>
        </Modal>
      )}
    </>
  );
}

function ConditionBadge({ c }: { c: string }) {
  const t = c === "new" || c === "good" ? "success" : c === "fair" ? "info" : c === "rough" ? "warning" : c === "unusable" ? "danger" : "neutral";
  return <Badge tone={t} className="capitalize">{c}</Badge>;
}
