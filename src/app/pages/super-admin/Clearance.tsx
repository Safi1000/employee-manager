// ── Clearance: two stages, and neither does the other's half ────────────────
//
// STAGE 1 — OPERATIONS. A fired guard appears not cleared, highlighted, with
// his outstanding kit listed automatically. Ops assesses each item; three
// outcomes, each with a suggested fine that is overridable by hand:
//
//   Returned reusable  → stock back at half replacement cost, no fine
//   Returned unusable  → written off, fine pro-rated by remaining useful life
//   Not returned       → nothing back, full replacement cost whatever its age
//
// STAGE 2 — FINANCE. Cannot see him until ops has cleared him, and then sees
// only the OUTCOME: kits recovered, or a fine of X. Not the items, not the
// conditions, not the per-item fines.
//
// The two halves are gated on clearance.ops and clearance.finance, which is the
// stage-gate exception in CLAUDE.md: one key would let one person assess the kit
// and release the money.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { formatDate } from "../../lib/date";

const FIELD = "w-full px-3 py-2 border border-border rounded-md text-sm bg-background";
const money = (n: unknown) => Number(n ?? 0).toLocaleString();
const OUTCOMES = [
  { v: "returned_reusable", l: "Returned — reusable" },
  { v: "returned_unusable", l: "Returned — unusable" },
  { v: "not_returned", l: "Not returned" },
] as const;
const CONDITIONS = ["new", "good", "fair", "rough", "unusable"] as const;

type Pending = {
  id: string; full_name: string; guard_code: string | null;
  last_working_day: string | null; lifecycle_state: string;
  certificate_id: string | null; ops_cleared_at: string | null;
};

type KitItem = {
  id: string; issue_id: string; item_type_id: string; size: string | null;
  quantity: number; opening_condition: string;
  outcome: string | null; returned_condition: string | null;
  suggested_fine: number; fine: number;
};

export default function Clearance() {
  const { profile } = useAuth();
  const canOps = hasPermission(profile, "clearance.ops");
  const canFin = hasPermission(profile, "clearance.finance");

  const [pending, setPending] = useState<Pending[]>([]);
  const [queue, setQueue] = useState<any[]>([]);
  const [types, setTypes] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [open, setOpen] = useState<{ emp: Pending; certId: string; items: KitItem[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [e, c, q, t] = await Promise.all([
      supabase.from("employees")
        .select("id, full_name, guard_code, last_working_day, lifecycle_state")
        .in("lifecycle_state", ["fired", "left", "absconded"])
        .not("last_working_day", "is", null)
        .order("last_working_day", { ascending: false }),
      supabase.from("clearance_certificates")
        .select("id, employee_id, ops_cleared_at, dues_released"),
      supabase.from("clearance_finance_queue").select("*"),
      supabase.from("inventory_item_types").select("id, name"),
    ]);
    if (e.error) setErr(e.error.message);
    const certByEmp = new Map<string, any>();
    for (const row of (c.data ?? []) as any[]) {
      if (!certByEmp.has(row.employee_id) || row.ops_cleared_at) certByEmp.set(row.employee_id, row);
    }
    setPending(((e.data ?? []) as any[]).map((x) => ({
      ...x,
      certificate_id: certByEmp.get(x.id)?.id ?? null,
      ops_cleared_at: certByEmp.get(x.id)?.ops_cleared_at ?? null,
    })));
    setQueue(q.data ?? []);
    setTypes((t.data ?? []) as any[]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const typeName = useMemo(() => new Map(types.map((t) => [t.id, t.name])), [types]);
  const notCleared = useMemo(() => pending.filter((p) => !p.ops_cleared_at), [pending]);

  const openAssessment = async (emp: Pending) => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc("open_kit_clearance", { p_employee_id: emp.id });
    if (error) { setBusy(false); setErr(friendlyDbError(error)); return; }
    const certId = data as string;
    const { data: items } = await supabase.from("clearance_kit_items")
      .select("*").eq("certificate_id", certId);
    setBusy(false);
    setOpen({ emp, certId, items: (items ?? []) as KitItem[] });
  };

  // THE SUGGESTION COMES FROM THE DATABASE, never from a second copy of the
  // rules here. A screen that recomputed the fine could disagree with what the
  // clearance actually charges.
  const setOutcome = async (item: KitItem, outcome: string) => {
    const { data } = await supabase.rpc("suggest_kit_fine", {
      p_issue_id: item.issue_id, p_outcome: outcome,
    });
    const suggested = Number(data ?? 0);
    await supabase.from("clearance_kit_items")
      .update({ outcome, suggested_fine: suggested, fine: suggested,
                assessed_by: profile?.id ?? null, assessed_at: new Date().toISOString() })
      .eq("id", item.id);
    setOpen((o) => o && ({
      ...o,
      items: o.items.map((i) => i.id === item.id
        ? { ...i, outcome, suggested_fine: suggested, fine: suggested } : i),
    }));
  };

  const overrideFine = async (item: KitItem, value: string) => {
    const fine = Number(value || 0);
    setOpen((o) => o && ({ ...o, items: o.items.map((i) => i.id === item.id ? { ...i, fine } : i) }));
    await supabase.from("clearance_kit_items").update({ fine }).eq("id", item.id);
  };

  const clearOps = async () => {
    if (!open) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("ops_clear_employee", { p_certificate_id: open.certId });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setOpen(null);
    load();
  };

  const recordSignature = async (certId: string) => {
    setBusy(true); setErr(null);
    const { error } = await supabase.from("clearance_certificates")
      .update({ signed_at: new Date().toISOString(), signed_by: profile?.id ?? null })
      .eq("id", certId);
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    load();
  };

  return (
    <>
      <Header title="Clearance" subtitle="Operations assesses the kit; finance settles the dues" />

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-4 space-y-6">
        {err && (
          <div className="p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">{err}</div>
        )}
        {loading && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}

        {/* ---- STAGE 1 ---- */}
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning-700" />
            <div>
              <h3 className="text-sm font-medium">Not cleared — Operations</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Finance cannot see a guard until ops has cleared him, so a separation left
                here has nobody owed and nobody chasing, and his kit is out there.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  {["Guard", "Code", "Last working day", "Open for", ""].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {notCleared.length === 0 && !loading && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    Nobody is waiting on operations.
                  </td></tr>
                )}
                {notCleared.map((p) => {
                  const days = p.last_working_day
                    ? Math.floor((Date.now() - new Date(p.last_working_day).getTime()) / 86400000) : 0;
                  return (
                    <tr key={p.id} className="bg-warning-50/40">
                      <td className="px-4 py-2 text-sm">{p.full_name}</td>
                      <td className="px-4 py-2 text-sm font-mono text-xs">{p.guard_code ?? "—"}</td>
                      <td className="px-4 py-2 text-sm">
                        {p.last_working_day ? formatDate(p.last_working_day) : "—"}
                      </td>
                      <td className="px-4 py-2 text-sm tabular-nums">{days} days</td>
                      <td className="px-4 py-2">
                        {canOps && (
                          <Button variant="secondary" size="sm" disabled={busy}
                                  onClick={() => openAssessment(p)}>
                            Assess kit
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ---- STAGE 2 ---- */}
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-success-700" />
            <div>
              <h3 className="text-sm font-medium">Cleared by operations — Finance</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                The outcome only. Payment waits on a wet signature: the certificate prints, he
                signs it, someone records it here, and only then can the money go out.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  {["Guard", "Covers to", "Kit outcome", "Fine", "Undisbursed", "Signed", ""].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {queue.length === 0 && !loading && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    Nothing has been cleared by operations yet.
                  </td></tr>
                )}
                {queue.map((r) => (
                  <tr key={r.certificate_id}>
                    <td className="px-4 py-2 text-sm">{r.full_name}</td>
                    <td className="px-4 py-2 text-sm">{r.covers_to ? formatDate(r.covers_to) : "—"}</td>
                    <td className="px-4 py-2 text-sm text-muted-foreground">{r.kit_summary ?? "—"}</td>
                    <td className="px-4 py-2 text-sm tabular-nums">{money(r.kit_fine_total)}</td>
                    <td className="px-4 py-2 text-sm tabular-nums">{money(r.undisbursed_salary)}</td>
                    <td className="px-4 py-2 text-sm">
                      {r.signed_at
                        ? <span className="text-success-700">{formatDate(r.signed_at)}</span>
                        : <span className="text-muted-foreground">Awaiting</span>}
                    </td>
                    <td className="px-4 py-2">
                      {canFin && !r.signed_at && (
                        <Button variant="ghost" size="sm" disabled={busy}
                                onClick={() => recordSignature(r.certificate_id)}>
                          Record signature
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ---- THE ASSESSMENT ---- */}
      {open && (
        <Modal isOpen onClose={() => setOpen(null)}
               title={`Assess kit — ${open.emp.full_name}`} size="lg">
          <div className="space-y-3">
            {open.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                He holds no kit on record. Clearing him now records that — it does not invent
                an issuance that never happened.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-muted/40 border-b border-border">
                    <tr>
                      {["Item", "Qty", "Taken on at", "Outcome", "Suggested", "Fine charged"].map((h) => (
                        <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {open.items.map((it) => (
                      <tr key={it.id}>
                        <td className="px-3 py-2 text-sm">
                          {typeName.get(it.item_type_id) ?? "—"}
                          {it.size ? <span className="text-muted-foreground"> · {it.size}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-sm tabular-nums">{it.quantity}</td>
                        <td className="px-3 py-2 text-sm capitalize">{it.opening_condition}</td>
                        <td className="px-3 py-2">
                          <ThemedSelect value={it.outcome ?? ""}
                            onChange={(e) => setOutcome(it, e.target.value)}>
                            <option value="">—</option>
                            {OUTCOMES.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                          </ThemedSelect>
                        </td>
                        <td className="px-3 py-2 text-sm tabular-nums text-muted-foreground">
                          {money(it.suggested_fine)}
                        </td>
                        <td className="px-3 py-2">
                          <input className={FIELD + " w-28"} type="number" min={0} value={it.fine}
                                 onChange={(e) => overrideFine(it, e.target.value)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              The fine is suggested, never imposed — every figure is overridable, and the
              suggestion is already adjusted for the condition he received the item in.
              Clearing him locks his attendance: nothing can be recorded against him afterwards.
            </p>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <span className="text-sm">
                Total fine PKR {money(open.items.reduce((a, i) => a + Number(i.fine || 0), 0))}
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setOpen(null)}>Close</Button>
                <Button onClick={clearOps}
                        disabled={busy || open.items.some((i) => !i.outcome)}>
                  {busy ? "Clearing…" : "Clear (Operations)"}
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
