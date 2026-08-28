import { useEffect, useMemo, useRef, useState } from "react";
import { Search, ChevronDown } from "lucide-react";

/**
 * Searchable expense-category picker — the same combobox shape as
 * ClientFilterSelect, but for a REQUIRED form field rather than a list filter,
 * so it has no "All"/clear affordance and reports emptiness through `required`.
 *
 * A plain <select> was fine when there were a handful of categories; with a long
 * list, finding one meant scrolling a native dropdown with no way to type. This
 * keeps the same value contract (a category id, "" when nothing is chosen) so it
 * drops into the existing form state untouched.
 */
export type CategoryOption = { id: string; name: string };

export default function CategoryPicker({
  categories,
  value,
  onChange,
  placeholder = "Select category",
  className = "",
  disabled = false,
}: {
  categories: CategoryOption[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedName = useMemo(
    () => categories.find((c) => c.id === value)?.name ?? "",
    [categories, value],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [categories, query]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
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
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-md text-sm bg-white text-left hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:bg-slate-50 disabled:text-slate-400"
      >
        <Search className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" strokeWidth={1.5} />
        <span className={`flex-1 truncate ${selectedName ? "text-slate-900" : "text-slate-500"}`}>
          {selectedName || placeholder}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" strokeWidth={1.5} />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full bg-white border border-slate-200 rounded-md shadow-lg">
          <div className="p-2 border-b border-slate-200">
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search categories…"
              className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {matches.length === 0 && (
              <div className="px-3 py-2 text-xs text-slate-500">No matching category.</div>
            )}
            {matches.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => select(c.id)}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 ${value === c.id ? "bg-brand-50 text-brand-700" : "text-slate-700"}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
