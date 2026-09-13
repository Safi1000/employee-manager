// ── Billing and payroll cycles on a contract ────────────────────────────────
//
// A cycle change is an EFFECTIVE-DATED EVENT on the contract, not a setting on
// the client. Periods are derived from the events by contract_periods(), so a
// gap or an overlap cannot be entered: the next period starts the day after the
// previous one ends, by construction. This modal records the events and shows
// the periods they produce, so the operator sees the transition before it is
// billed — 1–24 Sep, then 25 Sep–24 Oct — rather than discovering it on an
// invoice.
//
// A PERIOD BELONGS TO THE MONTH ITS END FALLS IN. 25 Sep – 24 Oct is October.
//
// The payroll cycle is recorded and NOT YET CONSUMED: nothing in payroll,
// attendance or verification reads it yet (DEFERRED on the table).

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import ThemedSelect from "./ThemedSelect";
import { supabase, friendlyDbError } from "../lib/supabase";
import { formatDate } from "../lib/date";

const FIELD = "w-full px-3 py-2 border border-border rounded-md text-sm bg-background";

type CycleKind = "billing" | "payroll";
type CycleEvent = { id: string; cycle_kind: CycleKind; effective_from: string; anchor_day: number; note: string | null };
type Period = { period_start: string; period_end: string; service_month: string; anchor_day: number };

export default function ContractCyclesModal(props: {
  contractId: string;
  contractCode: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const { contractId, contractCode, canEdit, onClose } = props;
  const [events, setEvents] = useState<CycleEvent[]>([]);
  const [periods, setPeriods] = useState<Record<CycleKind, Period[]>>({ billing: [], payroll: [] });
  const [kind, setKind] = useState<CycleKind>("billing");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ effective_from: "", anchor_day: "25", note: "" });

  const load = useCallback(async () => {
    const [e, pb, pp] = await Promise.all([
      supabase.from("contract_cycle_events").select("*").eq("contract_id", contractId).order("effective_from"),
      supabase.rpc("contract_periods", { p_contract_id: contractId, p_kind: "billing" }),
      supabase.rpc("contract_periods", { p_contract_id: contractId, p_kind: "payroll" }),
    ]);
    if (e.error) setErr(e.error.message);
    setEvents((e.data ?? []) as CycleEvent[]);
    setPeriods({ billing: (pb.data ?? []) as Period[], payroll: (pp.data ?? []) as Period[] });
  }, [contractId]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.from("contract_cycle_events").insert({
      contract_id: contractId,
      cycle_kind: kind,
      effective_from: form.effective_from,
      anchor_day: Number(form.anchor_day),
      note: form.note.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setForm({ effective_from: "", anchor_day: "25", note: "" });
    load();
  };

  const remove = async (id: string) => {
    setBusy(true); setErr(null);
    const { error } = await supabase.from("contract_cycle_events").delete().eq("id", id);
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    load();
  };

  // The recent past and near future: enough to see a transition either side of today.
  const shown = periods[kind].slice(-8);
  const day = form.effective_from ? new Date(form.effective_from + "T00:00:00").getDate() : null;
  const onAnchor = day != null && day === Number(form.anchor_day);

  return (
    <Modal isOpen onClose={onClose} title={`Cycles — ${contractCode}`} size="lg">
      <div className="space-y-4">
        {err && <div className="p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">{err}</div>}

        <div className="flex gap-2">
          {(["billing", "payroll"] as CycleKind[]).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)}
              className={`px-3 py-1.5 rounded-md text-sm border ${kind === k ? "bg-brand-600 text-white border-brand-600" : "border-border"}`}>
              {k === "billing" ? "Billing" : "Payroll"}
            </button>
          ))}
        </div>

        {kind === "payroll" && (
          <p className="text-xs text-warning-700 bg-warning-50 border border-warning-200 rounded-md p-2">
            A payroll cycle is recorded here and not yet read by anything. Payroll, the attendance
            board and ops verification still run on the calendar month. Enter it so it is on record;
            it takes effect when that half lands.
          </p>
        )}

        {/* ---- EVENTS ---- */}
        <div className="border border-border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/40 border-b border-border text-xs font-medium text-muted-foreground">
            Cycle changes · the contract starts on the calendar (1st to 1st) until the first one
          </div>
          <table className="w-full">
            <tbody className="divide-y divide-border">
              {events.filter((e) => e.cycle_kind === kind).length === 0 && (
                <tr><td className="px-3 py-3 text-sm text-muted-foreground">Calendar months throughout.</td></tr>
              )}
              {events.filter((e) => e.cycle_kind === kind).map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2 text-sm">From {formatDate(e.effective_from)}</td>
                  <td className="px-3 py-2 text-sm">
                    {e.anchor_day === 1 ? "Calendar month" : `${e.anchor_day}th to ${e.anchor_day}th`}
                  </td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">{e.note ?? ""}</td>
                  <td className="px-3 py-2 text-right">
                    {canEdit && (
                      <button type="button" className="p-1 text-muted-foreground hover:text-danger-600"
                              disabled={busy} onClick={() => remove(e.id)} title="Remove — refused once a period it defines is invoiced">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canEdit && (
          <div className="grid grid-cols-12 gap-2 items-end border border-border rounded-md p-3">
            <div className="col-span-4">
              <label className="block text-xs mb-1">First day of the new cycle</label>
              <input className={FIELD} type="date" value={form.effective_from}
                     onChange={(e) => setForm({ ...form, effective_from: e.target.value })} />
            </div>
            <div className="col-span-3">
              <label className="block text-xs mb-1">Periods start on the</label>
              <ThemedSelect value={form.anchor_day} onChange={(e) => setForm({ ...form, anchor_day: e.target.value })}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{d === 1 ? "1st (calendar)" : `${d}th`}</option>
                ))}
              </ThemedSelect>
            </div>
            <div className="col-span-3">
              <label className="block text-xs mb-1">Note</label>
              <input className={FIELD} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            <div className="col-span-2">
              <Button size="sm" onClick={add} disabled={busy || !form.effective_from || !onAnchor}>Record</Button>
            </div>
            <p className="col-span-12 text-[11px] text-muted-foreground">
              The first day must fall on the day periods start on — a 25th cycle starts on a 25th. The
              period running when it takes effect is cut short the day before, so nothing is billed twice
              and no day is missed. {form.effective_from && !onAnchor && (
                <span className="text-danger-700">That date is not the {form.anchor_day}th.</span>
              )}
            </p>
          </div>
        )}

        {/* ---- THE PERIODS THEY PRODUCE ---- */}
        <div className="border border-border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-muted/40 border-b border-border text-xs font-medium text-muted-foreground">
            The periods this produces · a period belongs to the month it ends in
          </div>
          <table className="w-full">
            <thead>
              <tr>
                {["Period", "Belongs to", "Days"].map((h) => (
                  <th key={h} className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map((p) => {
                const days = Math.round((new Date(p.period_end).getTime() - new Date(p.period_start).getTime()) / 86400000) + 1;
                const short = days < 28;
                return (
                  <tr key={p.period_start} className={short ? "bg-warning-50/40" : undefined}>
                    <td className="px-3 py-1.5 text-sm">{formatDate(p.period_start)} – {formatDate(p.period_end)}</td>
                    <td className="px-3 py-1.5 text-sm">{new Date(p.service_month + "T00:00:00").toLocaleString("en", { month: "long", year: "numeric" })}</td>
                    <td className="px-3 py-1.5 text-sm tabular-nums">{days}{short ? " · short" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
