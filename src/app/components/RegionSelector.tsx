import { useEffect, useRef, useState } from "react";
import { ChevronDown, Building, MapPin, Lock } from "lucide-react";
import { useRegion } from "../lib/region";

// The global region context switch (spec section 3):
// "All regions / each region / Head Office. Every screen filters to the
// selection." Lives in the app chrome, above the page outlet, so it reads as
// a property of the whole app rather than of any one screen.
//
// RMD logins are locked to their region and get a static badge, no selector.
export default function RegionSelector() {
  const { regionId, setRegionId, regions, region, locked, loading } = useRegion();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Nothing to switch between: single-region companies get no chrome.
  if (loading || regions.length <= 1) {
    if (!locked) return null;
  }

  // Locked (RMD): show which region they're in, but no way out of it.
  if (locked) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted border border-border text-sm text-foreground min-h-9"
        title="Your account is scoped to this region."
      >
        <MapPin className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.5} />
        <span className="truncate max-w-40">{region?.name ?? "Your region"}</span>
        <Lock className="w-3 h-3 text-muted-foreground" strokeWidth={1.5} />
      </div>
    );
  }

  // Head Office and "All regions" are merged into one consolidated option, so a
  // selected HO row reads the same as consolidated in the trigger.
  const isConsolidated = !region || region.is_head_office;
  const label = isConsolidated ? "Head Office / All Regions" : region!.name;
  const Icon = isConsolidated ? Building : MapPin;

  const select = (id: string | null) => {
    setRegionId(id);
    setOpen(false);
  };

  const optionClass = (active: boolean) =>
    `w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-accent flex items-center gap-2 ${
      active ? "bg-brand-500/15 text-foreground font-semibold" : "text-foreground"
    }`;

  // Few regions (2026-10-20): a one-tap segmented switch instead of a menu —
  // the scope is always visible and changing it is one click, not two.
  const choices = regions.filter((r) => !r.is_head_office);
  if (choices.length > 0 && choices.length <= 4) {
    const pill = (active: boolean) =>
      `inline-flex items-center gap-1.5 px-3 md:px-3.5 py-1.5 rounded-lg text-sm whitespace-nowrap transition-all min-h-8 ${
        active ? "bg-foreground text-background font-semibold shadow-sm" : "text-muted-foreground hover:text-foreground"
      }`;
    return (
      <div role="radiogroup" aria-label="Region" className="inline-flex items-center gap-1 p-1 rounded-xl bg-muted border border-border/60 max-w-full overflow-x-auto">
        <button type="button" role="radio" aria-checked={isConsolidated} onClick={() => select(null)} className={pill(isConsolidated)}>
          <Building className="w-3.5 h-3.5" strokeWidth={1.75} />
          <span className="sm:hidden">All</span><span className="hidden sm:inline">All regions</span>
        </button>
        {choices.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={regionId === r.id} onClick={() => select(r.id)} className={pill(regionId === r.id)}>
            <MapPin className="w-3.5 h-3.5" strokeWidth={1.75} />
            {r.name}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 px-3 py-2 border border-border rounded-xl text-sm bg-card min-h-9 hover:border-brand-500/60 focus:outline-none focus:ring-2 focus:ring-ring/60"
      >
        <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" strokeWidth={1.5} />
        {/* "Head Office / All Regions" cannot fit a phone row alongside the
            menu and theme buttons, and truncating it to "Head Office / All…"
            reads worse than simply saying less. The long form returns at `sm`. */}
        <span className={`truncate max-w-40 ${region ? "text-foreground" : "text-muted-foreground"}`}>
          <span className="sm:hidden">{isConsolidated ? "All Regions" : region!.name}</span>
          <span className="hidden sm:inline">{label}</span>
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" strokeWidth={1.5} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-30 mt-1.5 w-64 bg-popover border border-border rounded-xl shadow-[0_12px_32px_rgba(25,26,16,0.18)] p-1.5"
        >
          <button type="button" onClick={() => select(null)} className={optionClass(isConsolidated)}>
            <Building className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.5} />
            <span className="flex-1">Head Office / All Regions</span>
            <span className="text-xs text-muted-foreground">Consolidated</span>
          </button>

          <div className="my-1 border-t border-border" />

          {/* Head Office is folded into the consolidated option above. */}
          {regions.filter((r) => !r.is_head_office).map((r) => (
            <button
              type="button"
              key={r.id}
              onClick={() => select(r.id)}
              className={optionClass(regionId === r.id)}
            >
              {r.is_head_office ? (
                <Building className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.5} />
              ) : (
                <MapPin className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.5} />
              )}
              <span className="flex-1 truncate">{r.name}</span>
              {r.code && <span className="text-xs text-muted-foreground font-mono">{r.code}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
