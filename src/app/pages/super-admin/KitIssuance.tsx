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
import { ArrowRightLeft, Loader2, PackageOpen, Undo2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { formatDate } from "../../lib/date";

const FIELD = "w-full px-3 py-2 border border-border rounded-md text-sm bg-background";
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

  return (
    <>
      <Header
        title="Issuance"
        subtitle="Who holds what, and the condition they took it on at"
        actions={canEdit ? (
          <Button variant="primary" size="md" onClick={() => setIssueOpen(true)}>
            <PackageOpen className="w-4 h-4 mr-1.5" /> Issue kit
          </Button>
        ) : undefined}
      />

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-4 space-y-4">
        {err && (
          <div className="p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">{err}</div>
        )}
        <input className={FIELD + " max-w-sm"} placeholder="Search guard, item or serial…"
               value={q} onChange={(e) => setQ(e.target.value)} />

        {loading && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}

        <div className="bg-card border border-border rounded-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  {["Item", "Held by", "Client", "Qty", "Issued", "Taken on at", "Last event", ""].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.length === 0 && !loading && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    Nothing is out. Kit issued from the store appears here until it is returned.
                  </td></tr>
                )}
                {filtered.map((h) => (
                  <tr key={h.issue_id}>
                    <td className="px-4 py-2 text-sm">
                      {typeName.get(h.item_type_id) ?? "—"}
                      <span className="block text-xs text-muted-foreground">
                        {[h.size, h.grade, h.serial_number].filter(Boolean).join(" · ")}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-sm">
                      {h.holder_employee_id
                        ? empName.get(h.holder_employee_id) ?? "—"
                        : <span className="text-muted-foreground">{siteName.get(h.holder_site_id ?? "") ?? "Site"}</span>}
                    </td>
                    <td className="px-4 py-2 text-sm text-muted-foreground">
                      {h.client_id ? clientName.get(h.client_id) ?? "—" : "—"}
                    </td>
                    <td className="px-4 py-2 text-sm tabular-nums">{h.outstanding_qty}</td>
                    <td className="px-4 py-2 text-sm">{formatDate(h.issued_on)}</td>
                    <td className="px-4 py-2 text-sm capitalize">{h.opening_condition}</td>
                    <td className="px-4 py-2 text-sm text-muted-foreground capitalize">
                      {h.last_event} · {formatDate(h.last_event_date)}
                    </td>
                    <td className="px-4 py-2 flex gap-1">
                      {canEdit && (
                        <>
                          <Button variant="ghost" size="sm"
                                  onClick={() => { setAct({ kind: "return", h }); setActForm({ condition: "good", to_employee: "", quantity: String(h.outstanding_qty), notes: "" }); }}>
                            <Undo2 className="w-3.5 h-3.5 mr-1" /> Return
                          </Button>
                          {h.holder_employee_id && (
                            <Button variant="ghost" size="sm"
                                    onClick={() => { setAct({ kind: "handover", h }); setActForm({ condition: "good", to_employee: "", quantity: "", notes: "" }); }}>
                              <ArrowRightLeft className="w-3.5 h-3.5 mr-1" /> Handover
                            </Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ---- ISSUE ---- */}
      {issueOpen && (
        <Modal isOpen onClose={() => setIssueOpen(false)} title="Issue kit" size="md">
          <div className="space-y-3">
            <div>
              <label className="block text-sm mb-1">Item *</label>
              <ThemedSelect value={iss.item_type_id}
                onChange={(e) => setIss({ ...iss, item_type_id: e.target.value, size: "", serial: "" })}>
                <option value="">Pick an item…</option>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </ThemedSelect>
            </div>

            {iss.item_type_id && (
              <div>
                <label className="block text-sm mb-1">From stock *</label>
                <ThemedSelect
                  value={`${iss.size}|${iss.grade}|${iss.serial}`}
                  onChange={(e) => {
                    const [size, grade, serial] = e.target.value.split("|");
                    setIss({ ...iss, size, grade, serial });
                  }}>
                  <option value="||">Pick…</option>
                  {availableFor.map((r) => (
                    <option key={r.id} value={`${r.size ?? ""}|${r.grade}|${r.serial_number ?? ""}`}>
                      {[r.size, r.grade, r.serial_number].filter(Boolean).join(" · ")} — {r.quantity} available
                    </option>
                  ))}
                </ThemedSelect>
                {availableFor.length === 0 && (
                  <p className="text-[11px] text-warning-700 mt-1">
                    None of this item is in the store. Record a purchase first.
                  </p>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm mb-1">To guard</label>
                <ThemedSelect value={iss.to_employee}
                  onChange={(e) => setIss({ ...iss, to_employee: e.target.value, site_id: "" })}>
                  <option value="">—</option>
                  {emps.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
                </ThemedSelect>
              </div>
              <div>
                <label className="block text-sm mb-1">…or to a site</label>
                <ThemedSelect value={iss.site_id}
                  onChange={(e) => setIss({ ...iss, site_id: e.target.value, to_employee: "" })}>
                  <option value="">—</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </ThemedSelect>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Consumables go to a guard and carry the client from his current deployment.
              Weapons and vehicles go to a client site.
            </p>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm mb-1">Quantity *</label>
                <input className={FIELD} type="number" min={1} value={iss.quantity}
                       onChange={(e) => setIss({ ...iss, quantity: e.target.value })} />
              </div>
              <div>
                <label className="block text-sm mb-1">Condition *</label>
                <ThemedSelect value={iss.condition}
                  onChange={(e) => setIss({ ...iss, condition: e.target.value })}>
                  {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </ThemedSelect>
              </div>
              <div>
                <label className="block text-sm mb-1">Date *</label>
                <input className={FIELD} type="date" value={iss.event_date}
                       onChange={(e) => setIss({ ...iss, event_date: e.target.value })} />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setIssueOpen(false)}>Cancel</Button>
              <Button onClick={doIssue}
                      disabled={busy || !iss.item_type_id || (!iss.to_employee && !iss.site_id)}>
                {busy ? "Issuing…" : "Issue"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ---- RETURN / HANDOVER ---- */}
      {act && (
        <Modal isOpen onClose={() => setAct(null)}
               title={act.kind === "return" ? "Return to store" : "Handover to another guard"} size="sm">
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {typeName.get(act.h.item_type_id)} · {act.h.outstanding_qty} outstanding
              {act.h.holder_employee_id ? ` · held by ${empName.get(act.h.holder_employee_id) ?? ""}` : ""}
            </p>

            {act.kind === "handover" ? (
              <>
                <div>
                  <label className="block text-sm mb-1">To guard *</label>
                  <ThemedSelect value={actForm.to_employee}
                    onChange={(e) => setActForm({ ...actForm, to_employee: e.target.value })}>
                    <option value="">Pick a guard…</option>
                    {emps.filter((e) => e.id !== act.h.holder_employee_id)
                         .map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
                  </ThemedSelect>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Nothing is posted. The client already absorbed the cost at first issue, and
                  the condition below becomes the receiving guard's opening condition — he is
                  not judged on wear that was already there.
                </p>
              </>
            ) : (
              <div>
                <label className="block text-sm mb-1">Quantity</label>
                <input className={FIELD} type="number" min={1} max={act.h.outstanding_qty}
                       value={actForm.quantity}
                       onChange={(e) => setActForm({ ...actForm, quantity: e.target.value })} />
              </div>
            )}

            <div>
              <label className="block text-sm mb-1">Condition *</label>
              <ThemedSelect value={actForm.condition}
                onChange={(e) => setActForm({ ...actForm, condition: e.target.value })}>
                {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </ThemedSelect>
              {act.kind === "return" && actForm.condition === "unusable" && (
                <p className="text-[11px] text-warning-700 mt-1">
                  Unusable kit does not go back on the shelf — it is written off rather than
                  counted as stock.
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm mb-1">Note</label>
              <input className={FIELD} value={actForm.notes}
                     onChange={(e) => setActForm({ ...actForm, notes: e.target.value })} />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setAct(null)}>Cancel</Button>
              <Button onClick={doAct}
                      disabled={busy || (act.kind === "handover" && !actForm.to_employee)}>
                {busy ? "Saving…" : act.kind === "return" ? "Return" : "Hand over"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
