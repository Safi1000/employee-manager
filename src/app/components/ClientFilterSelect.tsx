import { useMemo, useState } from "react";
import { Search } from "lucide-react";
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
  selectClassName?: string;
};

export default function ClientFilterSelect({
  clients,
  value,
  onChange,
  allValue = "",
  allLabel = "All Clients",
  extraOption,
  filterFn,
  className = "",
  selectClassName = "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900",
}: Props) {
  const [search, setSearch] = useState("");
  const visible = useMemo(() => {
    const base = filterFn ? clients.filter(filterFn) : clients;
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.client_code ?? "").toLowerCase().includes(q),
    );
  }, [clients, search, filterFn]);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="relative">
        <Search
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400"
          strokeWidth={1.5}
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="pl-8 pr-3 py-2 border border-slate-200 rounded-md text-sm w-36 focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={selectClassName}
      >
        <option value={allValue}>{allLabel}</option>
        {extraOption && (
          <option value={extraOption.value}>{extraOption.label}</option>
        )}
        {visible.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.client_code ? ` (${c.client_code})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
