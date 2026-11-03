import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search, ShieldCheck } from "lucide-react";
import { PERMISSION_GROUPS } from "../lib/supabase";
import { APPROVAL_KEYS, RESTRICTED_KEYS, PRESETS, isHeldBack, nearestPreset } from "../lib/permissionPresets";

/**
 * The permission grant (3 Nov 2026). Start from a preset — it only fills the
 * ticks — then add or remove anything. Approvals are tagged so they are never
 * handed out by accident. Search, per-group counts and tick-all, groups fold.
 */
export default function PermissionPicker({ selected, onChange, disabled }: {
  selected: Set<string>; onChange: (next: Set<string>) => void; disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const total = PERMISSION_GROUPS.reduce((n, g) => n + g.items.length, 0);
  const near = useMemo(() => nearestPreset(selected), [selected]);
  const term = q.trim().toLowerCase();
  const toggle = (k: string) => { const n = new Set(selected); if (n.has(k)) n.delete(k); else n.add(k); onChange(n); };
  const setGroup = (keys: string[], on: boolean) => { const n = new Set(selected); keys.forEach((k) => (on ? n.add(k) : n.delete(k))); onChange(n); };
  const approvalsHeld = [...selected].filter((k) => APPROVAL_KEYS.has(k)).length;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs text-muted-foreground mb-1.5">Start from a preset — it fills the ticks, and you can change any of them after.</p>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" disabled={disabled} title={p.what} onClick={() => onChange(new Set(p.keys))}
              className={`px-2.5 py-1 rounded-lg border text-xs ${near?.preset.key === p.key ? "bg-foreground text-background border-foreground" : "bg-card border-border hover:bg-muted"} disabled:opacity-50`}>
              {p.label}
            </button>
          ))}
          <button type="button" disabled={disabled} onClick={() => onChange(new Set())} className="px-2.5 py-1 rounded-lg text-xs text-muted-foreground hover:underline">Clear</button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1.5">
          {selected.size} of {total} permissions
          {near ? ` · based on ${near.preset.label}${near.added || near.removed ? ` (+${near.added} / −${near.removed})` : ""}` : selected.size ? " · custom" : ""}
          {approvalsHeld ? ` · ${approvalsHeld} approval${approvalsHeld === 1 ? "" : "s"}` : ""}
        </p>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a permission" className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-border bg-card text-sm" />
      </div>

      <div className="space-y-1.5">
        {PERMISSION_GROUPS.map((g) => {
          const items = g.items.filter((i) => !term || `${i.label} ${i.key} ${g.label}`.toLowerCase().includes(term));
          if (!items.length) return null;
          const on = g.items.filter((i) => selected.has(i.key)).length;
          const isOpen = !!term || open.has(g.label);
          return (
            <div key={g.label} className="rounded-lg border border-border">
              <div className="flex items-center gap-2 px-3 py-2">
                <button type="button" onClick={() => setOpen((prev) => { const n = new Set(prev); if (n.has(g.label)) n.delete(g.label); else n.add(g.label); return n; })}
                  className="flex-1 flex items-center gap-1.5 text-left text-sm font-medium text-foreground">
                  {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}{g.label}
                  <span className={`ml-1 text-xs font-normal ${on ? "text-foreground" : "text-muted-foreground"}`}>{on}/{g.items.length}</span>
                </button>
                {!disabled && (
                  <span className="flex gap-2 text-[11px]">
                    <button type="button" className="text-brand-700 dark:text-brand-500 hover:underline" onClick={() => setGroup(g.items.filter((i) => !isHeldBack(i.key)).map((i) => i.key), true)} title="Everything here except approvals and restricted keys">All</button>
                    <button type="button" className="text-muted-foreground hover:underline" onClick={() => setGroup(g.items.map((i) => i.key), false)}>None</button>
                  </span>
                )}
              </div>
              {isOpen && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 px-3 pb-3">
                  {items.map((i) => (
                    <label key={i.key} className={`flex items-start gap-2 text-sm ${disabled ? "opacity-50" : "cursor-pointer"}`}>
                      <input type="checkbox" checked={selected.has(i.key)} onChange={() => toggle(i.key)} disabled={disabled} className="mt-0.5 rounded border-border" />
                      <span className="text-foreground">
                        {i.label}
                        {APPROVAL_KEYS.has(i.key) && <span className="ml-1.5 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold bg-warning-50 text-warning-700 dark:text-warning-500 align-middle"><ShieldCheck className="w-2.5 h-2.5" />Approval</span>}
                        {RESTRICTED_KEYS.has(i.key) && <span className="ml-1.5 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold bg-danger-50 text-danger-700 align-middle"><ShieldCheck className="w-2.5 h-2.5" />Restricted</span>}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
