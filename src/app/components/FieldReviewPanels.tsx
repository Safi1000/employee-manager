import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, MapPin, RotateCcw, X } from "lucide-react";
import Button from "./Button";
import { FieldPhotos } from "./FieldActivity";
import { supabase, friendlyDbError } from "../lib/supabase";

/**
 * The Field Review tabs for what office staff send from the app (0622–0624).
 * Each reads the app's OWN panel — never the books:
 *
 *   MoneyRequestsPanel   field_money_requests (field.money_approve): approve,
 *                        return or reject; once approved, record the real entry in
 *                        Expenses & Advances as usual and mark the request recorded.
 *   TripsPanel           field_trips: odometer photos and km; put the trip on the
 *                        fuel sheet as usual and mark it added.
 *   EmployeeUpdatesPanel field_employee_changes and field_documents
 *                        (employees.edit): apply or refuse details; accept or
 *                        reject scanned documents (accepting ticks the checklist).
 *
 * Deciding here also acknowledges the item's Field Activity line.
 */

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const pkr = (n: number) => `PKR ${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const inputCls = "rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground";

function Empty({ text }: { text: string }) {
  return <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">{text}</div>;
}
function Loading() {
  return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
}

// ------------------------------------------------------------------ money
type Money = {
  id: string; kind: "expense" | "advance"; requester_name: string; amount: number; category_name: string | null; description: string;
  expense_date: string; status: string; decided_by_name: string | null; decision_note: string | null; recorded_at: string | null; created_at: string;
};

export function MoneyRequestsPanel({ onError, onCount }: { onError: (s: string) => void; onCount?: (n: number) => void }) {
  const [rows, setRows] = useState<Money[] | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from("field_money_requests").select("*")
      .or("status.eq.pending,and(status.eq.approved,recorded_at.is.null)").order("created_at");
    if (error) onError(friendlyDbError(error));
    const list = (data ?? []) as Money[];
    setRows(list); onCount?.(list.filter((r) => r.status === "pending").length);
  }, [onError, onCount]);
  useEffect(() => { void load(); }, [load]);
  if (rows === null) return <Loading />;
  if (!rows.length) return <Empty text="No expense or advance requests waiting." />;
  return <div className="space-y-3">{rows.map((r) => <MoneyCard key={r.id} r={r} onDone={load} onError={onError} />)}</div>;
}

function MoneyCard({ r, onDone, onError }: { r: Money; onDone: () => void; onError: (s: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState(false);
  const act = async (fn: string, args: Record<string, unknown>) => {
    setBusy(true);
    const { error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) { onError(friendlyDbError(error)); return; }
    onDone();
  };
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">{pkr(r.amount)} <span className="font-normal text-muted-foreground">· {r.kind === "advance" ? "Advance" : "Expense"}{r.category_name ? ` · ${r.category_name}` : ""}</span></div>
          <div className="text-sm">{r.description}</div>
          <div className="text-xs text-muted-foreground">{r.requester_name} · for {day(r.expense_date)} · sent {when(r.created_at)}
            {" · "}<button type="button" className="underline hover:text-foreground" onClick={() => setPhotos((p) => !p)}>receipt</button></div>
        </div>
        {r.status === "approved" && <span className="text-xs text-up">Approved by {r.decided_by_name}</span>}
      </div>
      {photos && <FieldPhotos refTable="field_money_requests" refId={r.id} />}
      {r.status === "pending" ? (
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputCls} min-w-[200px] flex-1`} placeholder="Note (needed to return or reject)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" disabled={busy} onClick={() => void act("decide_field_money_request", { p_id: r.id, p_decision: "approved", p_note: note || null })}><Check className="mr-1 h-3.5 w-3.5" />Approve</Button>
          <Button size="sm" variant="secondary" disabled={busy || !note.trim()} onClick={() => void act("decide_field_money_request", { p_id: r.id, p_decision: "returned", p_note: note })}><RotateCcw className="mr-1 h-3.5 w-3.5" />Return</Button>
          <Button size="sm" variant="ghost" disabled={busy || !note.trim()} onClick={() => void act("decide_field_money_request", { p_id: r.id, p_decision: "rejected", p_note: note })}><X className="mr-1 h-3.5 w-3.5" />Reject</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex-1 text-xs text-muted-foreground">Record it in Expenses &amp; Advances as usual, then mark it recorded here.</p>
          <input className={`${inputCls} w-56`} placeholder="Reference (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act("mark_field_money_recorded", { p_id: r.id, p_note: note || null })}>Mark recorded</Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ trips
type Trip = { id: string; driver_name: string; purpose: string; start_at: string; start_odometer: number; end_odometer: number; km: number;
  start_geo: { lat?: number; lng?: number } | null; clients: { name: string } | null; fuel_cards: { label: string; card_last4: string | null } | null };

export function TripsPanel({ onError }: { onError: (s: string) => void }) {
  const [rows, setRows] = useState<Trip[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from("field_trips").select("id, driver_name, purpose, start_at, start_odometer, end_odometer, km, start_geo, clients(name), fuel_cards(label, card_last4)")
      .eq("status", "ended").is("added_at", null).order("start_at");
    if (error) onError(friendlyDbError(error));
    setRows((data ?? []) as unknown as Trip[]);
  }, [onError]);
  useEffect(() => { void load(); }, [load]);
  const mark = async (id: string) => {
    const { error } = await supabase.rpc("mark_field_trip_added", { p_trip_id: id, p_note: null });
    if (error) onError(friendlyDbError(error)); else void load();
  };
  if (rows === null) return <Loading />;
  if (!rows.length) return <Empty text="No trips waiting to go on the fuel sheet." />;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Kilometres from the app. Price each trip on the fuel sheet as usual, then mark it added.</p>
      {rows.map((t) => (
        <div key={t.id} className="space-y-2 rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="font-medium">{t.km} km <span className="font-normal text-muted-foreground">· {t.driver_name}{t.fuel_cards ? ` · ${t.fuel_cards.label}` : " · no card linked"}</span></div>
              <div className="text-sm">{[t.clients?.name, t.purpose].filter(Boolean).join(" — ")}</div>
              <div className="text-xs text-muted-foreground">{when(t.start_at)} · {t.start_odometer} → {t.end_odometer}
                {t.start_geo?.lat != null && <> · <a className="underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${t.start_geo.lat},${t.start_geo.lng}`}><MapPin className="inline h-3 w-3" /> start</a></>}
                {" · "}<button type="button" className="underline hover:text-foreground" onClick={() => setOpen(open === t.id ? null : t.id)}>odometer photos</button></div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void mark(t.id)}><Check className="mr-1 h-3.5 w-3.5" />Added to fuel sheet</Button>
          </div>
          {open === t.id && <FieldPhotos refTable="field_trips" refId={t.id} />}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ employee updates and documents
type Change = { id: string; employee_id: string; changes: Record<string, string>; old_values: Record<string, string | null>; note: string | null;
  proposer_name: string; created_at: string; employees: { full_name: string; employee_code: string } | null };
type Doc = { id: string; doc_type: string; uploader_name: string; created_at: string; employees: { full_name: string; employee_code: string } | null };

export function EmployeeUpdatesPanel({ onError }: { onError: (s: string) => void }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const [c, d] = await Promise.all([
      supabase.from("field_employee_changes").select("id, employee_id, changes, old_values, note, proposer_name, created_at, employees(full_name, employee_code)").eq("status", "pending").order("created_at"),
      supabase.from("field_documents").select("id, doc_type, uploader_name, created_at, employees(full_name, employee_code)").eq("status", "received").order("created_at"),
    ]);
    if (c.error || d.error) onError(friendlyDbError((c.error ?? d.error)!));
    setChanges((c.data ?? []) as unknown as Change[]);
    setDocs((d.data ?? []) as unknown as Doc[]);
  }, [onError]);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await supabase.rpc(fn, args);
    if (error) onError(friendlyDbError(error)); else void load();
  };
  if (changes === null || docs === null) return <Loading />;
  if (!changes.length && !docs.length) return <Empty text="No employee details or documents waiting." />;
  return (
    <div className="space-y-3">
      {changes.map((c) => (
        <div key={c.id} className="space-y-2 rounded-2xl border border-border bg-card p-4">
          <div className="font-medium">{c.employees?.full_name} <span className="font-normal text-muted-foreground">· {c.employees?.employee_code} · details from {c.proposer_name}, {when(c.created_at)}</span></div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {Object.entries(c.changes).map(([k, v]) => (
                <tr key={k}><td className="py-1 pr-3 text-muted-foreground">{k.replace(/_/g, " ")}</td>
                  <td className="py-1 pr-3 text-muted-foreground line-through">{c.old_values[k] ?? "—"}</td>
                  <td className="py-1 font-medium">{v}</td></tr>
              ))}
            </tbody>
          </table>
          {c.note && <p className="text-xs text-muted-foreground">“{c.note}”</p>}
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${inputCls} min-w-[200px] flex-1`} placeholder="Note (needed to refuse)" value={note[c.id] ?? ""} onChange={(e) => setNote((n) => ({ ...n, [c.id]: e.target.value }))} />
            <Button size="sm" onClick={() => void act("decide_field_employee_change", { p_id: c.id, p_apply: true, p_note: note[c.id] || null })}><Check className="mr-1 h-3.5 w-3.5" />Apply to the record</Button>
            <Button size="sm" variant="secondary" disabled={!(note[c.id] ?? "").trim()} onClick={() => void act("decide_field_employee_change", { p_id: c.id, p_apply: false, p_note: note[c.id] })}><X className="mr-1 h-3.5 w-3.5" />Refuse</Button>
          </div>
        </div>
      ))}
      {docs.map((d) => (
        <div key={d.id} className="space-y-2 rounded-2xl border border-border bg-card p-4">
          <div className="font-medium">{d.doc_type.replace(/_/g, " ")} <span className="font-normal text-muted-foreground">· {d.employees?.full_name} ({d.employees?.employee_code}) · scanned by {d.uploader_name}, {when(d.created_at)}</span></div>
          <FieldPhotos refTable="field_documents" refId={d.id} />
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${inputCls} min-w-[200px] flex-1`} placeholder="Note (needed to reject)" value={note[d.id] ?? ""} onChange={(e) => setNote((n) => ({ ...n, [d.id]: e.target.value }))} />
            <Button size="sm" onClick={() => void act("decide_field_document", { p_id: d.id, p_accept: true, p_note: note[d.id] || null })}><Check className="mr-1 h-3.5 w-3.5" />Accept (tick checklist)</Button>
            <Button size="sm" variant="secondary" disabled={!(note[d.id] ?? "").trim()} onClick={() => void act("decide_field_document", { p_id: d.id, p_accept: false, p_note: note[d.id] })}><X className="mr-1 h-3.5 w-3.5" />Reject</Button>
          </div>
        </div>
      ))}
    </div>
  );
}
