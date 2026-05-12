import { useEffect, useMemo, useRef, useState } from "react";
import { Search, ChevronDown, X } from "lucide-react";
import type { Client } from "../lib/supabase";

type Props = {
  clients: Client[];
  value: string;
  onChange: (v: string) => void;
  allValue?: string;
  allLabel?: string;
  extraOption?: { value: string; label: string };
  filterFn?: (c: Client) => boolean;
  className?: string;
};

// Combobox: typing filters; click a match to select; clear button to reset.
export default function ClientFilterSelect({
  clients,
  value,
  onChange,
  allValue = "",
  allLabel = "All Clients",
  extraOption,
  filterFn,
  className = "",
}: Props) {
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
        className="w-full md:w-56 flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-md text-sm bg-white text-left hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900"
      >
        <Search className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" strokeWidth={1.5} />
        <span className={`flex-1 truncate ${value === allValue ? "text-slate-500" : "text-slate-900"}`}>
          {selectedLabel}
        </span>
        {value !== allValue && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              select(allValue);
            }}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Clear filter"
          >
            <X className="w-3.5 h-3.5" />
          </span>
        )}
        <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" strokeWidth={1.5} />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full md:w-72 bg-white border border-slate-200 rounded-md shadow-lg">
          <div className="p-2 border-b border-slate-200">
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to filter…"
              className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => select(allValue)}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 ${value === allValue ? "bg-blue-50 text-blue-700" : "text-slate-700"}`}
            >
              {allLabel}
            </button>
            {extraOption && (
              <button
                type="button"
                onClick={() => select(extraOption.value)}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 ${value === extraOption.value ? "bg-blue-50 text-blue-700" : "text-slate-700"}`}
              >
                {extraOption.label}
              </button>
            )}
            {matches.length === 0 && (
              <div className="px-3 py-2 text-xs text-slate-500">No matches.</div>
            )}
            {matches.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => select(c.id)}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 ${value === c.id ? "bg-blue-50 text-blue-700" : "text-slate-700"}`}
              >
                <span>{c.name}</span>
                {c.client_code && (
                  <span className="text-xs text-slate-500 ml-2 font-mono">{c.client_code}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
