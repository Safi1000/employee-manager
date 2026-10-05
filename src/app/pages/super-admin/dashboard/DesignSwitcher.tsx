import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Palette, X } from "lucide-react";

// Floating picker for the dashboard's design. Sits left of the assistant
// button (bottom-right) so the two never overlap.
//
// The choice is remembered in localStorage per browser — it is a viewing
// preference, not company data, and the page renders the Classic design if
// storage is unavailable.

export type DesignId = "classic" | "watchtower" | "ledger" | "aurora";

const STORAGE_KEY = "txs.dashboardDesign";

export function readDesign(): DesignId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "classic" || v === "watchtower" || v === "ledger" || v === "aurora") return v;
  } catch { /* storage unavailable */ }
  return "classic";
}

export function saveDesign(id: DesignId) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* storage unavailable */ }
}

type Option = { id: DesignId; name: string; tagline: string; preview: ReactNode };

const OPTIONS: Option[] = [
  {
    id: "watchtower",
    name: "Watchtower",
    tagline: "Tactical command centre. Radar, readouts, live ops log.",
    preview: (
      <div className="relative h-full w-full overflow-hidden" style={{ background: "#05080a" }}>
        <div className="absolute inset-0" style={{ backgroundImage: "linear-gradient(rgba(57,255,160,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(57,255,160,.08) 1px,transparent 1px)", backgroundSize: "10px 10px" }} />
        <div className="absolute left-3 top-1/2 -translate-y-1/2 h-12 w-12 rounded-full" style={{ border: "1px solid rgba(57,255,160,.6)", background: "conic-gradient(from 0deg, rgba(57,255,160,.45), transparent 25%)" }} />
        <div className="absolute right-3 top-3 space-y-1.5">
          <div className="h-1.5 w-14" style={{ background: "#39ffa0" }} />
          <div className="h-1.5 w-10" style={{ background: "#ffb020" }} />
          <div className="h-1.5 w-12" style={{ background: "rgba(57,255,160,.4)" }} />
        </div>
        <div className="absolute right-3 bottom-3 font-mono text-[8px]" style={{ color: "#39ffa0" }}>&gt; SYS NOMINAL_</div>
      </div>
    ),
  },
  {
    id: "ledger",
    name: "The Ledger",
    tagline: "A morning broadsheet. Headlines, columns, league tables.",
    preview: (
      <div className="h-full w-full px-3 py-2" style={{ background: "#f3ede1", color: "#1b1712" }}>
        <div className="text-center text-[11px] leading-none" style={{ fontFamily: "Georgia, serif", fontWeight: 900, letterSpacing: "-.02em" }}>The Bastion Ledger</div>
        <div className="mt-1 h-px" style={{ background: "#1b1712" }} />
        <div className="mt-px h-px" style={{ background: "#1b1712" }} />
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          <div className="col-span-2 space-y-1">
            <div className="h-1.5 w-full" style={{ background: "#1b1712" }} />
            <div className="h-1.5 w-3/4" style={{ background: "#1b1712" }} />
            <div className="h-px w-full" style={{ background: "#a39a8a" }} />
            <div className="h-px w-full" style={{ background: "#a39a8a" }} />
            <div className="h-px w-5/6" style={{ background: "#a39a8a" }} />
          </div>
          <div className="space-y-1 border-l pl-1.5" style={{ borderColor: "#a39a8a" }}>
            <div className="h-3 w-full" style={{ background: "#8c1c13" }} />
            <div className="h-px w-full" style={{ background: "#a39a8a" }} />
            <div className="h-px w-full" style={{ background: "#a39a8a" }} />
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "aurora",
    name: "Aurora",
    tagline: "Luminous glass bento over a living gradient.",
    preview: (
      <div className="relative h-full w-full overflow-hidden" style={{ background: "#0b0b1e" }}>
        <div className="absolute -left-4 -top-6 h-20 w-20 rounded-full blur-xl" style={{ background: "#7c5cff" }} />
        <div className="absolute right-0 top-2 h-16 w-16 rounded-full blur-xl" style={{ background: "#00d4c8" }} />
        <div className="absolute bottom-[-20px] left-10 h-16 w-20 rounded-full blur-xl" style={{ background: "#ff6aa2" }} />
        <div className="absolute inset-2 grid grid-cols-3 grid-rows-2 gap-1">
          <div className="col-span-2 rounded-md" style={{ background: "rgba(255,255,255,.14)", border: "1px solid rgba(255,255,255,.25)" }} />
          <div className="row-span-2 rounded-md" style={{ background: "rgba(255,255,255,.14)", border: "1px solid rgba(255,255,255,.25)" }} />
          <div className="rounded-md" style={{ background: "rgba(255,255,255,.14)", border: "1px solid rgba(255,255,255,.25)" }} />
          <div className="rounded-md" style={{ background: "rgba(255,255,255,.14)", border: "1px solid rgba(255,255,255,.25)" }} />
        </div>
      </div>
    ),
  },
  {
    id: "classic",
    name: "Classic",
    tagline: "The current dashboard, unchanged.",
    preview: (
      <div className="h-full w-full p-2 bg-slate-50">
        <div className="grid grid-cols-4 gap-1">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-4 rounded-sm bg-white border border-slate-200" />)}
        </div>
        <div className="mt-1 grid grid-cols-2 gap-1">
          <div className="h-10 rounded-sm bg-white border border-slate-200" />
          <div className="h-10 rounded-sm bg-white border border-slate-200" />
        </div>
      </div>
    ),
  },
];

export default function DesignSwitcher({ value, onChange }: { value: DesignId; onChange: (id: DesignId) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = OPTIONS.find((o) => o.id === value) ?? OPTIONS[3];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [open]);

  return (
    <div
      ref={ref}
      className="fixed right-24 z-40"
      style={{ bottom: "calc(var(--safe-bottom, 0px) + 1.75rem)", fontFamily: "'Hanken Grotesk', system-ui, sans-serif" }}
    >
      {open && (
        <div className="absolute bottom-14 right-0 w-[min(560px,calc(100vw-7rem))] rounded-2xl border border-white/10 bg-[#0f1115]/95 p-4 text-white shadow-2xl backdrop-blur-xl">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Dashboard design</p>
              <p className="text-xs text-white/50">Same data, four ways of looking at it.</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-md p-1 text-white/50 hover:bg-white/10 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {OPTIONS.map((o) => {
              const active = o.id === value;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => { onChange(o.id); setOpen(false); }}
                  className={`group overflow-hidden rounded-xl border text-left transition-all ${
                    active ? "border-white/70 ring-2 ring-white/30" : "border-white/10 hover:border-white/40"
                  }`}
                >
                  <div className="h-20 w-full transition-transform duration-300 group-hover:scale-[1.03]">{o.preview}</div>
                  <div className="flex items-start gap-2 bg-white/[.03] px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{o.name}</p>
                      <p className="text-[11px] leading-snug text-white/50">{o.tagline}</p>
                    </div>
                    {active && <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-400" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 items-center gap-2 rounded-full border border-white/15 bg-[#0f1115] pl-3 pr-4 text-sm text-white shadow-lg transition-transform hover:scale-[1.03]"
        aria-expanded={open}
        title="Switch dashboard design"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 via-fuchsia-500 to-amber-400">
          <Palette className="h-3.5 w-3.5" />
        </span>
        <span className="hidden sm:inline text-white/60">Design:</span>
        <span className="font-semibold">{current.name}</span>
      </button>
    </div>
  );
}
