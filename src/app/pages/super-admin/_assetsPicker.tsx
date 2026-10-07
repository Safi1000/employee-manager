// The dropdown for Assets & Issuance.
//
// Roomy where ThemedSelect is compact: a full-height trigger that matches the
// inputs beside it, options with a second line (code, category, stock left),
// labels that wrap instead of being clipped, and a search box once the list is
// long enough to need one (the guard list is hundreds of names). Keyboard:
// arrows move, Enter picks, Escape closes.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";

export type PickerOption = { value: string; label: string; sub?: string; meta?: string; disabled?: boolean };

export default function Picker({
  value, onChange, options, placeholder = "Select…", disabled, searchPlaceholder, emptyText = "Nothing matches.",
}: {
  value: string;
  onChange: (v: string) => void;
  options: PickerOption[];
  placeholder?: string;
  disabled?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean; maxH: number } | null>(null);
  const searchable = options.length > 8;
  const current = options.find((o) => o.value === value) ?? null;

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return options;
    return options.filter((o) => `${o.label} ${o.sub ?? ""} ${o.meta ?? ""}`.toLowerCase().includes(n));
  }, [options, q]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = Math.min(Math.max(r.width, 320), window.innerWidth - 16);
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = below < 260 && above > below;
      setPos({
        top: up ? r.top - 6 : r.bottom + 6,
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
        width,
        up,
        maxH: Math.max(180, Math.min(380, (up ? above : below) - (searchable ? 90 : 10))),
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  const pick = (o: PickerOption) => {
    if (o.disabled) return;
    setOpen(false);
    if (o.value !== value) onChange(o.value);
    btnRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      // Close the list, not the popup it sits in.
      e.stopPropagation(); e.nativeEvent.stopImmediatePropagation();
      setOpen(false); btnRef.current?.focus(); return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); if (!open) setOpen(true); else setHi((h) => Math.min(shown.length - 1, h + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    if (e.key === "Enter" && open) { e.preventDefault(); const o = shown[hi]; if (o) pick(o); }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKey}
        className={`w-full min-h-10 px-3 py-2 flex items-center justify-between gap-3 rounded-lg border bg-background text-left text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-brand-500/40 ${
          open ? "border-brand-500 ring-2 ring-brand-500/30" : "border-border hover:border-brand-500/50"
        }`}
      >
        {current ? (
          <span className="min-w-0 flex-1">
            <span className="block text-foreground leading-snug break-words">{current.label}</span>
            {current.sub && <span className="block text-[11px] text-muted-foreground leading-snug mt-0.5">{current.sub}</span>}
          </span>
        ) : (
          <span className="flex-1 text-muted-foreground">{placeholder}</span>
        )}
        <ChevronDown className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={1.75} />
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          onKeyDown={onKey}
          style={{
            position: "fixed",
            top: pos.up ? undefined : pos.top,
            bottom: pos.up ? window.innerHeight - pos.top : undefined,
            left: pos.left,
            width: pos.width,
            zIndex: 9999,
          }}
          className="flex flex-col rounded-xl border border-border bg-popover shadow-2xl shadow-black/25 overflow-hidden animate-[feed-slide-in_0.14s_ease-out]"
        >
          {searchable && (
            <div className="p-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => { setQ(e.target.value); setHi(0); }}
                  placeholder={searchPlaceholder ?? "Search…"}
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                />
              </div>
            </div>
          )}
          <div ref={listRef} role="listbox" className="overflow-y-auto p-1.5" style={{ maxHeight: pos.maxH }}>
            {shown.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</div>}
            {shown.map((o, i) => {
              const active = o.value === value;
              return (
                <button
                  key={`${o.value}-${i}`}
                  data-i={i}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={o.disabled}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(o)}
                  className={`w-full flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    active ? "bg-brand-500/15" : i === hi ? "bg-accent" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm leading-snug break-words ${active ? "font-medium text-brand-700 dark:text-brand-500" : "text-foreground"}`}>
                      {o.label}
                    </span>
                    {o.sub && <span className="block text-xs text-muted-foreground leading-snug mt-0.5">{o.sub}</span>}
                  </span>
                  {o.meta && <span className="shrink-0 text-xs text-muted-foreground tabular-nums mt-0.5">{o.meta}</span>}
                  {active && <Check className="w-4 h-4 shrink-0 mt-0.5 text-brand-600" strokeWidth={2.5} />}
                </button>
              );
            })}
          </div>
          {searchable && (
            <div className="px-3 py-1.5 border-t border-border text-[11px] text-muted-foreground">
              {shown.length} of {options.length}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
