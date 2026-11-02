import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { STATE_LABEL, staffChangeCount, type StaffChanges } from "../lib/staffChanges";

/**
 * Staff changes (0632) on screen — the same reading as section 4 of the
 * attendance report PDF: entered since the last attendance report, plus
 * documents running out in 30 days.
 */
const d = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

export default function StaffChangesPanel({ data, title = "Staff changes" }: { data: StaffChanges; title?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const since = new Date(data.from).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const groups: [string, string, { k: string; text: string }[]][] = [
    ["hired", "Hired", data.hired.map((h, i) => ({ k: `h${i}`, text: `${h.name}${h.category ? ` · ${h.category}` : ""}${h.client ? ` · ${h.client}` : ""}${h.join_date ? ` · joins ${d(h.join_date)}` : ""}` }))],
    ["left", "Left", data.separated.map((x, i) => ({ k: `s${i}`, text: `${x.name} · ${STATE_LABEL[x.to_state] ?? x.to_state}${x.last_day ? ` · last day ${d(x.last_day)}` : ""}${x.reason ? ` · ${x.reason}` : ""}` }))],
    ["rehired", "Re-hired", data.rehired.map((x, i) => ({ k: `r${i}`, text: `${x.name}${x.join_date ? ` · joins ${d(x.join_date)}` : ""}` }))],
    ["moved", "Transferred", data.transferred.map((x, i) => ({ k: `t${i}`, text: `${x.name} → ${x.to_client} from ${d(x.from)}` }))],
    ["pay", "Pay changed", data.salary_changes.map((x, i) => ({ k: `p${i}`, text: `${x.name} · ${Math.round(Number(x.base)).toLocaleString("en-US")} from ${d(x.from_date)}${x.reason ? ` · ${x.reason}` : ""}` }))],
    ["docs", "Documents expiring (30 days)", data.expiring.map((x, i) => ({ k: `e${i}`, text: `${x.name} · ${x.document} · ${d(x.date)}` }))],
  ];
  return (
    <div className="border border-border rounded-xl bg-card">
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-baseline gap-2">
        <h3 className="font-semibold text-foreground">{title}</h3>
        <span className="text-xs text-muted-foreground">entered since {since} · {staffChangeCount(data)} change{staffChangeCount(data) === 1 ? "" : "s"} · goes into the attendance report</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-border">
        {groups.map(([key, label, rows]) => (
          <button key={key} type="button" onClick={() => setOpen(open === key ? null : key)} disabled={!rows.length}
            className={`bg-card px-3 py-2.5 text-left ${open === key ? "ring-2 ring-inset ring-brand-500" : ""} disabled:cursor-default`}>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1">
              {rows.length ? (open === key ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />) : null}{label}
            </div>
            <div className="text-xl font-semibold text-foreground tabular-nums">{rows.length}</div>
          </button>
        ))}
      </div>
      {open && (
        <ul className="px-4 py-3 text-sm space-y-1 max-h-80 overflow-y-auto">
          {groups.find(([k]) => k === open)?.[2].map((r) => <li key={r.k} className="text-foreground">{r.text}</li>)}
        </ul>
      )}
    </div>
  );
}
