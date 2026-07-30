import { useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import { supabase } from "../../lib/supabase";
import { Building2, Users, MapPin, AlertCircle, Loader2, Search } from "lucide-react";

// Operations ▸ Deployment — the surviving useful half of the old "Sites &
// Strength": a per-client contracted-vs-active headcount snapshot. The per-post /
// per-site drill-down was dropped (contracts don't define posts; supervisors run
// day-to-day deployment) and billing reconciliation moved to Invoices.

type ReconRow = {
  client_id: string;
  client_name: string;
  site_count: number;
  contracted_billed_qty: number;
  required_on_ground: number;
  enrolled_active: number;
  enrolled_total: number;
  variance: number;
};

const varianceBadge = (v: number) => {
  if (v === 0) return "bg-success-50 text-success-700 border-success-200";
  if (v < 0) return "bg-danger-50 text-danger-700 border-danger-200"; // over-enrolled
  return "bg-warning-50 text-warning-800 border-warning-200"; // under-enrolled
};

export default function Deployment() {
  const [recon, setRecon] = useState<ReconRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyMismatch, setOnlyMismatch] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error } = await supabase
        .from("v_client_strength_reconciliation")
        .select("*")
        .order("client_name");
      if (error) setError(error.message);
      else setRecon((data ?? []) as ReconRow[]);
      setLoading(false);
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return recon.filter((r) => {
      if (q && !r.client_name.toLowerCase().includes(q)) return false;
      if (onlyMismatch && r.variance === 0) return false;
      return true;
    });
  }, [recon, search, onlyMismatch]);

  const totals = useMemo(
    () =>
      recon.reduce(
        (acc, r) => {
          acc.contracted += r.contracted_billed_qty;
          acc.enrolled += r.enrolled_active;
          acc.sites += r.site_count;
          if (r.variance !== 0) acc.mismatched += 1;
          return acc;
        },
        { contracted: 0, enrolled: 0, sites: 0, mismatched: 0 },
      ),
    [recon],
  );

  return (
    <>
      <Header
        title="Deployment"
        subtitle="Per-client contracted vs. active (enrolled) headcount snapshot"
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {[
            { label: "Contracted (billed)", value: totals.contracted, icon: Building2, tint: "text-brand-600 dark:text-brand-500" },
            { label: "Enrolled (active)", value: totals.enrolled, icon: Users, tint: "text-success-600 dark:text-success-500" },
            { label: "Sites", value: totals.sites, icon: MapPin, tint: "text-muted-foreground" },
            { label: "Clients mismatched", value: totals.mismatched, icon: AlertCircle, tint: totals.mismatched > 0 ? "text-warning-600 dark:text-warning-500" : "text-success-600 dark:text-success-500" },
          ].map((t) => (
            <div key={t.label} className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-card">
              <t.icon className={`w-4 h-4 shrink-0 ${t.tint}`} strokeWidth={2} />
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</span>
              <span className="text-base font-semibold tabular-nums text-foreground">{t.value}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="relative flex-1 sm:w-64 sm:flex-none">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search client…"
              className="w-full pl-10 pr-3 py-2 border border-border bg-card rounded-md text-sm text-foreground"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground select-none whitespace-nowrap">
            <input type="checkbox" checked={onlyMismatch} onChange={(e) => setOnlyMismatch(e.target.checked)} />
            Only mismatches
          </label>
        </div>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Client</th>
                  <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Sites</th>
                  <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Contracted</th>
                  <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">On-ground req.</th>
                  <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Enrolled (active)</th>
                  <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Variance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground text-sm">
                      No clients match the current filters.
                    </td>
                  </tr>
                )}
                {!loading &&
                  filtered.map((r) => (
                    <tr key={r.client_id} className="hover:bg-accent/50 transition-colors">
                      <td className="px-4 py-3 text-sm font-medium text-foreground">{r.client_name}</td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.site_count}</td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.contracted_billed_qty}</td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.required_on_ground}</td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.enrolled_active}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={`inline-block px-2 py-0.5 rounded-md text-xs border font-medium ${varianceBadge(r.variance)}`}>
                          {r.variance > 0 ? `+${r.variance}` : r.variance}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Variance = contracted − enrolled(active). Positive (amber) = understaffed; negative (red) = over-enrolled.
        </p>
      </div>
    </>
  );
}
