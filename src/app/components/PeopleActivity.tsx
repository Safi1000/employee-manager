import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { supabase, friendlyDbError } from "../lib/supabase";

/**
 * PEOPLE (0632, DECIDED 2 Nov 2026): what each login did, counted by area —
 * read from what the work already leaves behind (the audit trail, attendance
 * marks, follow-ups). Nobody logs anything extra to appear here, which also
 * means a person whose work leaves no record shows as quiet, not idle.
 */
type Row = { person_id: string; person_name: string; area: string; actions: number; last_at: string };
export type Span = "today" | "7d" | "30d";
export const SPANS: [Span, string][] = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]];
export const spanStart = (s: Span) => {
  const d = new Date();
  if (s === "today") d.setHours(0, 0, 0, 0); else d.setDate(d.getDate() - (s === "7d" ? 7 : 30));
  return d.toISOString();
};
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function PeopleActivity({ span }: { span: Span }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    const { data, error } = await supabase.rpc("people_activity", { p_from: spanStart(span), p_to: new Date().toISOString() });
    setLoading(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setRows((data ?? []) as Row[]);
  }, [span]);
  useEffect(() => { void load(); }, [load]);

  // One entry per person, busiest first; the list is the tabs.
  const people = useMemo(() => {
    const m = new Map<string, { id: string; name: string; total: number; last: string; areas: Row[] }>();
    for (const r of rows) {
      const p = m.get(r.person_id) ?? { id: r.person_id, name: r.person_name ?? "Unnamed login", total: 0, last: r.last_at, areas: [] };
      p.total += r.actions; if (r.last_at > p.last) p.last = r.last_at; p.areas.push(r);
      m.set(r.person_id, p);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [rows]);
  const current = people.find((p) => p.id === picked) ?? people[0];

  if (err) return <div className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{err}</div>;
  if (loading && !rows.length) return <div className="text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>;
  if (!people.length) return <p className="text-muted-foreground italic text-sm">Nothing recorded in this period.</p>;
  return (
    <div className="grid md:grid-cols-[16rem_1fr] gap-4">
      <div className="border border-border rounded-xl bg-card overflow-hidden self-start">
        {people.map((p) => (
          <button key={p.id} type="button" onClick={() => setPicked(p.id)}
            className={`w-full text-left px-3 py-2 border-b border-border last:border-b-0 flex items-baseline gap-2 ${current?.id === p.id ? "bg-muted" : "hover:bg-muted/50"}`}>
            <span className="flex-1 truncate text-sm text-foreground">{p.name}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{p.total.toLocaleString("en-US")}</span>
          </button>
        ))}
      </div>
      {current && (
        <div className="border border-border rounded-xl bg-card">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="font-semibold text-foreground">{current.name}</h3>
            <p className="text-xs text-muted-foreground">{current.total.toLocaleString("en-US")} recorded actions · last at {when(current.last)}</p>
          </div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="px-4 py-2">Area</th><th className="px-4 text-right">Actions</th><th className="px-4">Last</th></tr></thead>
            <tbody>{current.areas.sort((a, b) => b.actions - a.actions).map((a) => (
              <tr key={a.area} className="border-t border-border"><td className="px-4 py-1.5">{a.area}</td><td className="px-4 text-right tabular-nums">{a.actions.toLocaleString("en-US")}</td><td className="px-4 text-muted-foreground">{when(a.last_at)}</td></tr>
            ))}</tbody>
          </table>
          <p className="px-4 py-2 text-[11px] text-muted-foreground border-t border-border">Counted from the audit trail, attendance marks and follow-ups. Work that leaves no record in Bastion does not show here.</p>
        </div>
      )}
    </div>
  );
}
