import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, ChevronDown, X } from "lucide-react";
import type { Client } from "../lib/supabase";

// Only these three fields are rendered, so callers may pass anything
// client-shaped — e.g. the attendance bulk-mark modal, whose list mixes real
// clients with "unassigned, by category" buckets. Generic over the element type
// so a `filterFn` reading Client-only fields still type-checks.
export type ClientLike = { id: string; name: string; client_code?: string | null };

type Props<T extends ClientLike> = {
  clients: T[];
  value: string;
  onChange: (v: string) => void;
  allValue?: string;
  allLabel?: string;
  extraOption?: { value: string; label: string };
  filterFn?: (c: T) => boolean;
  className?: string;
  // Width utility for the trigger button. Defaults to the standalone "md:w-56";
  // pass "w-full" to let it fill a grid/flex cell instead.
  buttonClassName?: string;
  /** Optional per-row badge (e.g. a verification status), shown after the name. */
  renderBadge?: (c: T) => React.ReactNode;
  /** Leave out the "All" choice — for pickers where one client must be chosen. */
  hideAll?: boolean;
};

// Combobox: typing filters; click a match to select; clear button to reset.
export default function ClientFilterSelect<T extends ClientLike = Client>({
  clients,
  value,
  onChange,
  allValue = "",
  allLabel = "All Clients",
  extraOption,
  filterFn,
  className = "",
  buttonClassName = "md:w-56",
  renderBadge,
  hideAll = false,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  const filteredClients = useMemo(() => {
    return filterFn ? clients.filter(filterFn) : clients;
  }, [clients, filterFn]);

  // Compute display label for current selection.
  const selectedLabel = useMemo(() => {
    if (value === allValue) return allLabel;
    if (extraOption && value === extraOption.value) return extraOption.label;
    const c = clients.find((x) => x.id === value);
    if (!c) return allLabel;
    return c.client_code ? `${c.name} (${c.client_code})` : c.name;
  }, [value, clients, allValue, allLabel, extraOption]);

  // Filtered dropdown items based on typed query.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return filteredClients;
    return filteredClients.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.client_code ?? "").toLowerCase().includes(q),
    );
  }, [filteredClients, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const select = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full ${buttonClassName} flex items-center gap-2 px-3 py-2 border border-border rounded-md text-sm bg-card text-left hover:border-border focus:outline-none focus:ring-2 focus:ring-brand-500/40`}
      >
        <Search className="w-3.5 h-3.5 text-muted-foreground/70 flex-shrink-0" strokeWidth={1.5} />
        <span className={`flex-1 truncate ${value === allValue ? "text-muted-foreground" : "text-foreground"}`}>
          {selectedLabel}
        </span>
        {value !== allValue && !hideAll && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              select(allValue);
            }}
            className="text-muted-foreground/70 hover:text-foreground"
            aria-label="Clear filter"
          >
            <X className="w-3.5 h-3.5" />
          </span>
        )}
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/70 flex-shrink-0" strokeWidth={1.5} />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full md:w-72 bg-card border border-border rounded-md shadow-lg">
          <div className="p-2 border-b border-border">
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to filter…"
              className="w-full px-2 py-1.5 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {!hideAll && (
              <button
                type="button"
                onClick={() => select(allValue)}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/50 ${value === allValue ? "bg-brand-50 text-brand-700" : "text-foreground"}`}
              >
                {allLabel}
              </button>
            )}
            {extraOption && (
              <button
                type="button"
                onClick={() => select(extraOption.value)}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/50 ${value === extraOption.value ? "bg-brand-50 text-brand-700" : "text-foreground"}`}
              >
                {extraOption.label}
              </button>
            )}
            {matches.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matches.</div>
            )}
            {matches.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => select(c.id)}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/50 ${value === c.id ? "bg-brand-50 text-brand-700" : "text-foreground"}`}
              >
                <span>{c.name}</span>
                {c.client_code && (
                  <span className="text-xs text-muted-foreground ml-2 font-mono">{c.client_code}</span>
                )}
                {renderBadge && <span className="ml-2">{renderBadge(c)}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
