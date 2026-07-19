import { useEffect, useRef, useState } from "react";
import { ChevronDown, Globe, Building, MapPin, Lock } from "lucide-react";
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
        className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-100 border border-slate-200 text-sm text-slate-700"
        title="Your account is scoped to this region."
      >
        <MapPin className="w-3.5 h-3.5 text-slate-400" strokeWidth={1.5} />
        <span className="truncate max-w-40">{region?.name ?? "Your region"}</span>
        <Lock className="w-3 h-3 text-slate-400" strokeWidth={1.5} />
      </div>
    );
  }

  const label = region ? region.name : "All regions";
  const Icon = !region ? Globe : region.is_head_office ? Building : MapPin;

  const select = (id: string | null) => {
    setRegionId(id);
    setOpen(false);
  };

  const optionClass = (active: boolean) =>
    `w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 flex items-center gap-2 ${
      active ? "bg-brand-50 text-brand-700" : "text-slate-700"
    }`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 px-3 py-1.5 border border-slate-200 rounded-md text-sm bg-white hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900"
      >
        <Icon className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" strokeWidth={1.5} />
        <span className={`truncate max-w-40 ${region ? "text-slate-900" : "text-slate-500"}`}>
          {label}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" strokeWidth={1.5} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-30 mt-1 w-64 bg-white border border-slate-200 rounded-md shadow-lg py-1"
        >
          <button type="button" onClick={() => select(null)} className={optionClass(!regionId)}>
            <Globe className="w-3.5 h-3.5 text-slate-400" strokeWidth={1.5} />
            <span className="flex-1">All regions</span>
            <span className="text-xs text-slate-400">Consolidated</span>
          </button>

          <div className="my-1 border-t border-slate-100" />

          {regions.map((r) => (
            <button
              type="button"
              key={r.id}
              onClick={() => select(r.id)}
              className={optionClass(regionId === r.id)}
            >
              {r.is_head_office ? (
                <Building className="w-3.5 h-3.5 text-slate-400" strokeWidth={1.5} />
              ) : (
                <MapPin className="w-3.5 h-3.5 text-slate-400" strokeWidth={1.5} />
              )}
              <span className="flex-1 truncate">{r.name}</span>
              {r.code && <span className="text-xs text-slate-400 font-mono">{r.code}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
