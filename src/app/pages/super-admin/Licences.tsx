import { useEffect, useMemo, useState } from "react";
import { Loader2, AlertCircle, X, ArrowUpDown, Search, Calendar } from "lucide-react";
import { Link } from "react-router";
import Header from "../../components/Header";
import {
  supabase,
  CONTRACT_TYPE_LABEL,
  type Client,
  type Contract,
  type Employee,
  type ImportantDate,
} from "../../lib/supabase";

type RowKind =
  | "weapon_licence"
  | "guard_service_licence"
  | "medical_fitness"
  | "probation_end"
  | "contract_end"
  | "important_date";

const KIND_LABEL: Record<RowKind, string> = {
  weapon_licence: "Weapon Licence",
  guard_service_licence: "Guard Service Licence",
  medical_fitness: "Medical Fitness",
  probation_end: "Probation End",
  contract_end: "Contract End",
  important_date: "Company Compliance",
};

const KIND_HREF: Record<RowKind, string> = {
  weapon_licence: "/super-admin/employees",
  guard_service_licence: "/super-admin/employees",
  medical_fitness: "/super-admin/employees",
  probation_end: "/super-admin/employees",
  contract_end: "/super-admin/contracts",
  important_date: "/super-admin/compliance",
};

type ExpiryRow = {
  id: string;
  kind: RowKind;
  title: string;
  subtitle: string;
  expiry_date: string;
  days_remaining: number;
  href: string;
};

const todayISO = () => new Date().toISOString().slice(0, 10);

const daysBetween = (futureISO: string, base = todayISO()): number => {
  const a = new Date(futureISO + "T00:00:00").getTime();
  const b = new Date(base + "T00:00:00").getTime();
  return Math.round((a - b) / 86400000);
};

const colourFor = (days: number): { dot: string; row: string; text: string; label: string } => {
  if (days < 0) return { dot: "bg-danger-600", row: "bg-danger-50/40", text: "text-danger-700", label: "Expired" };
  if (days <= 30) return { dot: "bg-danger-500", row: "bg-danger-50/30", text: "text-danger-700", label: "< 30 days" };
  if (days <= 90) return { dot: "bg-warning-500", row: "bg-warning-50/30", text: "text-warning-700", label: "< 90 days" };
  return { dot: "bg-success-500", row: "", text: "text-success-700", label: "> 90 days" };
};

export default function Licences() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [importantDates, setImportantDates] = useState<ImportantDate[]>([]);
  const [kindFilter, setKindFilter] = useState<"all" | RowKind>("all");
  const [bandFilter, setBandFilter] = useState<"all" | "expired" | "30" | "90" | "future">("all");
  const [search, setSearch] = useState("");
  const [sortDesc, setSortDesc] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [empRes, conRes, cliRes, idRes] = await Promise.all([
      supabase
        .from("employees")
        .select(
          "id, employee_code, full_name, weapon_licence_expiry, guard_service_licence_expiry, medical_fitness_expiry, probation_end_date, status",
        ),
      supabase.from("contracts").select("*"),
      supabase.from("clients").select("id, name, client_code"),
      supabase.from("important_dates").select("*").order("due_date"),
    ]);
    if (empRes.error) setError(empRes.error.message);
    setEmployees((empRes.data ?? []) as Employee[]);
    setContracts((conRes.data ?? []) as Contract[]);
    setClients((cliRes.data ?? []) as Client[]);
    setImportantDates((idRes.data ?? []) as ImportantDate[]);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const rows = useMemo<ExpiryRow[]>(() => {
    const out: ExpiryRow[] = [];
    const clientById = new Map(clients.map((c) => [c.id, c]));

    // Employee-driven licences
    for (const e of employees) {
      if (e.status === "Inactive") continue;
      if (e.weapon_licence_expiry) {
        out.push({
          id: `weapon-${e.id}`,
          kind: "weapon_licence",
          title: e.full_name,
          subtitle: `${e.employee_code} · Weapon licence`,
          expiry_date: e.weapon_licence_expiry,
          days_remaining: daysBetween(e.weapon_licence_expiry),
          href: KIND_HREF.weapon_licence,
        });
      }
      if (e.guard_service_licence_expiry) {
        out.push({
          id: `guard-${e.id}`,
          kind: "guard_service_licence",
          title: e.full_name,
          subtitle: `${e.employee_code} · Guard service licence`,
          expiry_date: e.guard_service_licence_expiry,
          days_remaining: daysBetween(e.guard_service_licence_expiry),
          href: KIND_HREF.guard_service_licence,
        });
      }
      if (e.medical_fitness_expiry) {
        out.push({
          id: `medical-${e.id}`,
          kind: "medical_fitness",
          title: e.full_name,
          subtitle: `${e.employee_code} · Medical fitness`,
          expiry_date: e.medical_fitness_expiry,
          days_remaining: daysBetween(e.medical_fitness_expiry),
          href: KIND_HREF.medical_fitness,
        });
      }
      if (e.probation_end_date) {
        out.push({
          id: `probation-${e.id}`,
          kind: "probation_end",
          title: e.full_name,
          subtitle: `${e.employee_code} · Probation ends`,
          expiry_date: e.probation_end_date,
          days_remaining: daysBetween(e.probation_end_date),
          href: KIND_HREF.probation_end,
        });
      }
    }

    // Contract end dates
    for (const c of contracts) {
      if (!c.end_date) continue;
      if (c.status !== "active") continue;
      const client = clientById.get(c.client_id);
      out.push({
        id: `contract-${c.id}`,
        kind: "contract_end",
        title: client?.name ?? "(deleted client)",
        subtitle: `${c.contract_code} · ${CONTRACT_TYPE_LABEL[c.contract_type]}`,
        expiry_date: c.end_date,
        days_remaining: daysBetween(c.end_date),
        href: KIND_HREF.contract_end,
      });
    }

    // Company-level important dates (PESRA, SECP, etc.)
    for (const d of importantDates) {
      out.push({
        id: `id-${d.id}`,
        kind: "important_date",
        title: d.title,
        subtitle: `${d.category} · ${d.priority}`,
        expiry_date: d.due_date,
        days_remaining: daysBetween(d.due_date),
        href: KIND_HREF.important_date,
      });
    }

    return out.sort((a, b) => (sortDesc ? b.days_remaining - a.days_remaining : a.days_remaining - b.days_remaining));
  }, [employees, contracts, clients, importantDates, sortDesc]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (kindFilter !== "all" && r.kind !== kindFilter) return false;
      if (bandFilter === "expired" && r.days_remaining >= 0) return false;
      if (bandFilter === "30" && (r.days_remaining < 0 || r.days_remaining > 30)) return false;
      if (bandFilter === "90" && (r.days_remaining < 0 || r.days_remaining > 90 || r.days_remaining <= 30)) return false;
      if (bandFilter === "future" && r.days_remaining <= 90) return false;
      if (q && !r.title.toLowerCase().includes(q) && !r.subtitle.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, kindFilter, bandFilter, search]);

  const counts = useMemo(() => {
    const c = { expired: 0, d30: 0, d90: 0, future: 0 };
    for (const r of rows) {
      if (r.days_remaining < 0) c.expired += 1;
      else if (r.days_remaining <= 30) c.d30 += 1;
      else if (r.days_remaining <= 90) c.d90 += 1;
      else c.future += 1;
    }
    return c;
  }, [rows]);

  return (
    <>
      <Header
        title="Licences & Renewals"
        subtitle="Every expiring item across guards, contracts and company compliance — sorted by days remaining"
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Summary tiles — clickable to filter */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryTile
            label="Expired"
            count={counts.expired}
            dot="bg-danger-600"
            active={bandFilter === "expired"}
            onClick={() => setBandFilter(bandFilter === "expired" ? "all" : "expired")}
          />
          <SummaryTile
            label="< 30 days"
            count={counts.d30}
            dot="bg-danger-500"
            active={bandFilter === "30"}
            onClick={() => setBandFilter(bandFilter === "30" ? "all" : "30")}
          />
          <SummaryTile
            label="< 90 days"
            count={counts.d90}
            dot="bg-warning-500"
            active={bandFilter === "90"}
            onClick={() => setBandFilter(bandFilter === "90" ? "all" : "90")}
          />
          <SummaryTile
            label="> 90 days"
            count={counts.future}
            dot="bg-success-500"
            active={bandFilter === "future"}
            onClick={() => setBandFilter(bandFilter === "future" ? "all" : "future")}
          />
        </div>

        {/* Filters */}
        <div className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by employee, contract code, or title…"
              className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as "all" | RowKind)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="all">All categories</option>
            {(Object.keys(KIND_LABEL) as RowKind[]).map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k]}</option>
            ))}
          </select>
        </div>

        {/* Table */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Item</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Category</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Expiry Date</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">
                    <button
                      type="button"
                      onClick={() => setSortDesc(!sortDesc)}
                      className="inline-flex items-center gap-1 hover:text-slate-900"
                    >
                      Days Remaining
                      <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Status</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-500 text-sm">
                      Nothing matches the current filters. Add expiry dates on Employees, Contracts, or the Compliance Calendar.
                    </td>
                  </tr>
                )}
                {!loading && filteredRows.map((row) => {
                  const c = colourFor(row.days_remaining);
                  return (
                    <tr key={row.id} className={`hover:bg-slate-50 transition-colors ${c.row}`}>
                      <td className="px-4 py-3 text-sm">
                        <div className="text-slate-900">{row.title}</div>
                        <div className="text-xs text-slate-500">{row.subtitle}</div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{KIND_LABEL[row.kind]}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">
                        <span className="inline-flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-slate-400" />
                          {row.expiry_date}
                        </span>
                      </td>
                      <td className={`px-4 py-3 text-sm text-right ${c.text}`}>
                        {row.days_remaining < 0
                          ? `${Math.abs(row.days_remaining)} days ago`
                          : `${row.days_remaining} days`}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <span className="inline-flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                          <span className={c.text}>{c.label}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        <Link
                          to={row.href}
                          className="text-brand-600 hover:text-brand-700 text-xs"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function SummaryTile({
  label,
  count,
  dot,
  active,
  onClick,
}: {
  label: string;
  count: number;
  dot: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left bg-white p-4 rounded-lg border transition-colors ${
        active ? "border-brand-600 ring-2 ring-brand-100" : "border-slate-200 hover:border-slate-300"
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      </div>
      <div className="text-2xl text-slate-900">{count}</div>
    </button>
  );
}
