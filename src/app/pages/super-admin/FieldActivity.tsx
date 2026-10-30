import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, MapPin } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Tabs from "../../components/Tabs";
import { useAuth } from "../../lib/auth";
import { PERMISSION_GROUPS, supabase, friendlyDbError } from "../../lib/supabase";

/**
 * Workforce ▸ Field Activity (0621). DECIDED by Shayan, 30 Oct 2026: everything
 * done in the field app is recorded at once and acknowledged here — "not exactly
 * an approval but an acknowledgement that this, this and this was done in the
 * mobile application".
 *
 * One line per thing done: what, where, who, when, and whether the phone was
 * inside the site's area. Acknowledge a line, or a whole day at once. Lines that
 * have a real decision elsewhere (site attendance review, formal warnings,
 * expense requests, trips, employee updates, documents) are acknowledged by that
 * decision and show who made it.
 *
 * Who may acknowledge each kind is Shayan's to decide, on the "Who acknowledges"
 * tab (super admins): any holder of one of the listed permissions. Super admins
 * may always acknowledge. The server checks each line again.
 */

type Line = {
  id: string; kind: string; summary: string; actor_name: string | null; actor_kind: string | null; created_at: string;
  geo: { inside?: boolean | null; distance_m?: number | null; lat?: number; lng?: number } | null;
  ack_at: string | null; ack_by_name: string | null; ack_note: string | null; sites: { name: string } | null;
};
type Rule = { kind: string; any_of: string[]; label: string };

const KIND_WORD: Record<string, string> = {
  attendance: "Attendance", visit: "Visit", incident: "Incident", sos: "SOS", warning: "Warning", task: "Task", site_report: "Site report",
  office_report: "Daily Report", guard_photo: "Guard photo", expense: "Expense request", advance: "Advance request", trip: "Trip",
  employee_update: "Employee details", document: "Document",
};
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA");
const dayLabel = (k: string) => new Date(`${k}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });

export default function FieldActivity() {
  const { profile } = useAuth();
  const isSuper = profile?.role === "super_admin" || profile?.role === "super_super_admin";
  const [view, setView] = useState<"open" | "done" | "rules">("open");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [kind, setKind] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLines(null);
    let q = supabase.from("field_activity").select("id, kind, summary, actor_name, actor_kind, created_at, geo, ack_at, ack_by_name, ack_note, sites(name)")
      .order("created_at", { ascending: false }).limit(400);
    q = view === "done" ? q.not("ack_at", "is", null) : q.is("ack_at", null);
    const [l, r] = await Promise.all([q, supabase.from("field_ack_rules").select("kind, any_of, label").order("kind")]);
    if (l.error || r.error) setErr(friendlyDbError((l.error ?? r.error)!));
    setLines((l.data ?? []) as unknown as Line[]);
    setRules((r.data ?? []) as Rule[]);
  }, [view]);
  useEffect(() => { if (view !== "rules") void load(); else void supabase.from("field_ack_rules").select("kind, any_of, label").order("kind").then(({ data }) => setRules((data ?? []) as Rule[])); }, [load, view]);

  const shown = useMemo(() => (lines ?? []).filter((l) => !kind || l.kind === kind), [lines, kind]);
  const byDay = useMemo(() => {
    const m = new Map<string, Line[]>();
    shown.forEach((l) => { const k = dayKey(l.created_at); m.set(k, [...(m.get(k) ?? []), l]); });
    return [...m.entries()];
  }, [shown]);

  const ack = async (ids: string[], key: string) => {
    setBusy(key); setErr(null);
    const { error } = await supabase.rpc("acknowledge_field_activity", { p_ids: ids, p_note: null });
    setBusy(null);
    if (error) setErr(friendlyDbError(error)); else void load();
  };

  return (
    <div className="space-y-4">
      <Header title="Field Activity" subtitle="Everything done in the field app, for the office to acknowledge" />
      {err && <div className="rounded-lg border border-down/40 bg-down/10 p-3 text-sm text-down">{err}</div>}
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <Tabs value={view} onChange={setView} items={[
          { value: "open", label: "To acknowledge", count: view === "open" ? (lines?.length || undefined) : undefined },
          { value: "done", label: "Acknowledged" },
          ...(isSuper ? [{ value: "rules" as const, label: "Who acknowledges" }] : []),
        ]} />
        {view !== "rules" && (
          <select className="rounded-md border border-border bg-card px-3 py-2 text-sm md:ml-auto" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            <option value="">Everything</option>
            {Object.entries(KIND_WORD).map(([k, w]) => <option key={k} value={k}>{w}</option>)}
          </select>
        )}
      </div>

      {view === "rules" ? <RulesEditor rules={rules} onSaved={(r) => setRules(r)} onError={setErr} /> : lines === null ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : byDay.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">{view === "open" ? "Nothing waiting. Everything from the app has been acknowledged." : "Nothing acknowledged yet."}</div>
      ) : byDay.map(([k, list]) => (
        <div key={k} className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="lbl">{dayLabel(k)} · {list.length}</p>
            {view === "open" && <Button size="sm" variant="secondary" disabled={busy === k} onClick={() => void ack(list.map((l) => l.id), k)}><Check className="mr-1 h-3.5 w-3.5" />Acknowledge the day</Button>}
          </div>
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {list.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <span className={`mr-2 rounded px-1.5 text-xs font-medium ${l.kind === "sos" ? "bg-down/15 text-down" : "bg-muted text-muted-foreground"}`}>{KIND_WORD[l.kind] ?? l.kind}</span>
                  <span className="text-foreground">{l.summary}</span>
                  <div className="text-xs text-muted-foreground">
                    {time(l.created_at)} · {l.actor_name}{l.actor_kind === "supervisor" ? " (site supervisor)" : ""}
                    {l.geo?.inside === false && <span className="text-heed"> · <MapPin className="inline h-3 w-3" /> outside the site's area</span>}
                    {l.ack_at && <span> · acknowledged by {l.ack_by_name}{l.ack_note ? ` — ${l.ack_note}` : ""}</span>}
                  </div>
                </div>
                {view === "open" && <Button size="sm" variant="ghost" disabled={busy === l.id} onClick={() => void ack([l.id], l.id)}><Check className="mr-1 h-3.5 w-3.5" />Acknowledge</Button>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RulesEditor({ rules, onSaved, onError }: { rules: Rule[]; onSaved: (r: Rule[]) => void; onError: (s: string) => void }) {
  const allKeys = useMemo(() => PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))), []);
  const [editing, setEditing] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const save = async (kind: string) => {
    const { error } = await supabase.rpc("admin_set_field_ack_rule", { p_kind: kind, p_any_of: picked });
    if (error) { onError(friendlyDbError(error)); return; }
    onSaved(rules.map((r) => (r.kind === kind ? { ...r, any_of: picked } : r)));
    setEditing(null);
  };
  const label = (k: string) => allKeys.find((x) => x.key === k)?.label ?? k;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Anyone holding one of a kind's permissions may acknowledge it. Super admins always can. Change these whenever you decide.</p>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {rules.map((r) => (
          <div key={r.kind} className="space-y-2 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium text-foreground">{r.label}</div>
                <div className="text-xs text-muted-foreground">{r.any_of.length ? r.any_of.map(label).join(" · ") : "Super admins only"}</div>
              </div>
              {editing !== r.kind && <Button size="sm" variant="ghost" onClick={() => { setEditing(r.kind); setPicked(r.any_of); setQ(""); }}>Change</Button>}
            </div>
            {editing === r.kind && (
              <div className="space-y-2">
                <input className="w-full rounded-md border border-border bg-card px-3 py-1.5 text-sm" placeholder="Search permissions…" value={q} onChange={(e) => setQ(e.target.value)} />
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {allKeys.filter((k) => !q.trim() || `${k.label} ${k.group}`.toLowerCase().includes(q.toLowerCase())).map((k) => (
                    <label key={k.key} className="flex cursor-pointer items-start gap-2 text-xs">
                      <input type="checkbox" checked={picked.includes(k.key)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, k.key] : p.filter((x) => x !== k.key)))} />
                      <span><span className="text-muted-foreground">{k.group} · </span>{k.label}</span>
                    </label>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void save(r.kind)}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
