import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  X,
  ChevronRight,
  Clock,
  Users,
  MapPin,
  Building2,
} from "lucide-react";
import Header from "../../components/Header";
import MobileCardList from "../../components/MobileCardList";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import Tabs from "../../components/Tabs";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase } from "../../lib/supabase";

// ── Types (Phase 1: sites / shift_definitions / strength contract_lines) ──────
type ShiftCode = "day" | "evening" | "night";
type ReliefMode = "embedded" | "pool" | "none";
type LineCategory =
  | "SR_SUPERVISOR"
  | "SUPERVISOR"
  | "ASST_SUPERVISOR"
  | "GUARD"
  | "RELIEVER"
  | "WEAPON"
  | "EQUIPMENT";

const CATEGORIES: LineCategory[] = [
  "GUARD",
  "SR_SUPERVISOR",
  "SUPERVISOR",
  "ASST_SUPERVISOR",
  "RELIEVER",
  "WEAPON",
  "EQUIPMENT",
];
const SHIFTS: ShiftCode[] = ["day", "evening", "night"];
const RELIEF_MODES: ReliefMode[] = ["none", "embedded", "pool"];

const CATEGORY_LABEL: Record<LineCategory, string> = {
  SR_SUPERVISOR: "Senior Supervisor",
  SUPERVISOR: "Supervisor",
  ASST_SUPERVISOR: "Assistant Supervisor",
  GUARD: "Guard",
  RELIEVER: "Reliever",
  WEAPON: "Weapon",
  EQUIPMENT: "Equipment",
};

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

type Site = {
  id: string;
  client_id: string;
  name: string;
  location: string | null;
  is_default: boolean;
};

type ShiftDef = {
  id: string;
  site_id: string;
  shift_code: ShiftCode;
  start_time: string;
  end_time: string;
  duration_hours: number;
  crosses_midnight: boolean;
};

type StrengthLine = {
  id: string;
  contract_id: string;
  site_id: string | null;
  category: LineCategory;
  shift_code: ShiftCode | null;
  billed_qty: number | null;
  relief_allowance: number;
  required_on_ground: number | null;
  relief_mode: ReliefMode;
  billing_rate: number | null;
  client_ot_rate: number | null;
  effective_from: string | null;
  effective_to: string | null;
};

type ContractLite = { id: string; client_id: string; contract_code: string | null };
type SiteGuard = {
  guard_id: string;
  site_id: string | null;
  full_name: string;
  code: string;
  display_number: number | null;
};

// Compute duration in hours from HH:MM strings, wrapping past midnight.
function computeDuration(start: string, end: string): { hours: number; crosses: boolean } {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return { hours: 0, crosses: false };
  let mins = eh * 60 + em - (sh * 60 + sm);
  let crosses = false;
  if (mins <= 0) {
    mins += 24 * 60;
    crosses = true;
  }
  return { hours: Math.round((mins / 60) * 10) / 10, crosses };
}

const varianceBadge = (v: number) => {
  if (v === 0) return "bg-success-50 text-success-700 border-success-200";
  if (v < 0) return "bg-danger-50 text-danger-700 border-danger-200"; // over-enrolled
  return "bg-warning-50 text-warning-800 border-warning-200"; // under-enrolled
};

export default function SitesStrength() {
  const [recon, setRecon] = useState<ReconRow[]>([]);
  // Phase 9 §10.6: contracted vs deployed vs attendance-on-ground vs shortfall.
  const [billing, setBilling] = useState<{ client_id: string; client_name: string; contracted: number; deployed: number; attendance_on_ground: number; shortfall: number }[]>([]);
  const [contracts, setContracts] = useState<ContractLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyMismatch, setOnlyMismatch] = useState(false);
  // Which reconciliation view is shown — kept as tabs so the two heavy tables
  // don't stack and the page reads like the rest of the system.
  const [view, setView] = useState<"strength" | "billing">("strength");

  // Drill-in state
  const [openClient, setOpenClient] = useState<ReconRow | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [shiftDefs, setShiftDefs] = useState<ShiftDef[]>([]);
  const [strengthLines, setStrengthLines] = useState<StrengthLine[]>([]);
  // Phase 4: guards currently posted to each site (active deployment rows).
  const [guards, setGuards] = useState<SiteGuard[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadRecon = async () => {
    setLoading(true);
    setError(null);
    const [{ data: rec, error: recErr }, { data: ct, error: ctErr }, { data: bill }] = await Promise.all([
      supabase.from("v_client_strength_reconciliation").select("*").order("client_name"),
      supabase.from("contracts").select("id, client_id, contract_code"),
      supabase.from("v_client_billing_reconciliation").select("*").order("shortfall", { ascending: false }),
    ]);
    if (recErr) setError(recErr.message);
    else setRecon((rec ?? []) as ReconRow[]);
    if (!ctErr) setContracts((ct ?? []) as ContractLite[]);
    setBilling((bill ?? []) as typeof billing);
    setLoading(false);
  };

  useEffect(() => {
    loadRecon();
  }, []);

  const loadDetail = async (client: ReconRow) => {
    setOpenClient(client);
    setDetailLoading(true);
    const { data: s } = await supabase
      .from("sites")
      .select("*")
      .eq("client_id", client.client_id)
      .order("is_default", { ascending: false })
      .order("name");
    const siteRows = (s ?? []) as Site[];
    const siteIds = siteRows.map((x) => x.id);
    const [{ data: sd }, { data: sl }, { data: dep }] = await Promise.all([
      siteIds.length
        ? supabase.from("shift_definitions").select("*").in("site_id", siteIds)
        : Promise.resolve({ data: [] as ShiftDef[] }),
      siteIds.length
        ? supabase.from("contract_lines").select("*").in("site_id", siteIds)
        : Promise.resolve({ data: [] as StrengthLine[] }),
      siteIds.length
        ? supabase
            .from("deployments")
            .select("guard_id, site_id, employees:guard_id(full_name, guard_code, employee_code, display_number)")
            .in("site_id", siteIds)
            .is("end_date", null)
        : Promise.resolve({ data: [] as unknown[] }),
    ]);
    setSites(siteRows);
    setShiftDefs((sd ?? []) as ShiftDef[]);
    setStrengthLines((sl ?? []) as StrengthLine[]);
    setGuards(
      ((dep ?? []) as any[]).map((r) => ({
        guard_id: r.guard_id,
        site_id: r.site_id,
        full_name: r.employees?.full_name ?? "—",
        code: r.employees?.guard_code ?? r.employees?.employee_code ?? "—",
        display_number: r.employees?.display_number ?? null,
      })),
    );
    setDetailLoading(false);
  };

  const refreshDetail = async () => {
    if (openClient) await loadDetail(openClient);
    await loadRecon();
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return recon.filter((r) => {
      if (q && !r.client_name.toLowerCase().includes(q)) return false;
      if (onlyMismatch && r.variance === 0) return false;
      return true;
    });
  }, [recon, search, onlyMismatch]);

  const totals = useMemo(() => {
    return recon.reduce(
      (acc, r) => {
        acc.contracted += r.contracted_billed_qty;
        acc.enrolled += r.enrolled_active;
        acc.sites += r.site_count;
        if (r.variance !== 0) acc.mismatched += 1;
        return acc;
      },
      { contracted: 0, enrolled: 0, sites: 0, mismatched: 0 },
    );
  }, [recon]);

  const clientContract = (clientId: string) =>
    contracts.find((c) => c.client_id === clientId) ?? null;

  return (
    <>
      <Header
        title="Sites & Strength"
        subtitle="Contracted vs. enrolled strength per client — sites, shifts and strength lines"
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

        {/* Compact summary strip — clear at a glance, minimal footprint. */}
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

        {/* Tabs + filters */}
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <Tabs
            value={view}
            onChange={setView}
            items={[
              { value: "strength", label: "Strength reconciliation" },
              { value: "billing", label: "Billing reconciliation" },
            ]}
          />
          {view === "strength" && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 md:ml-auto">
              <div className="relative flex-1 sm:w-64">
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
                <input
                  type="checkbox"
                  checked={onlyMismatch}
                  onChange={(e) => setOnlyMismatch(e.target.checked)}
                />
                Only mismatches
              </label>
            </div>
          )}
        </div>

        {/* Strength reconciliation table */}
        {view === "strength" && (
        <>
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {/* Phone: one card per client. Six numeric columns compare badly on a
              handset; what matters is the variance, so it leads as the badge
              and the rest sit underneath as the workings. */}
          <MobileCardList
            rows={loading ? [] : filtered}
            loading={loading}
            empty="No clients match the current filters."
            rowKey={(r) => r.client_id}
            onClick={(r) => loadDetail(r)}
            title={(r) => r.client_name}
            badge={(r) => (
              <span className={`inline-block px-2 py-0.5 rounded-md text-xs border font-medium ${varianceBadge(r.variance)}`}>
                {r.variance > 0 ? `+${r.variance}` : r.variance}
              </span>
            )}
            fields={[
              { label: "Sites", value: (r) => <span className="tabular-nums">{r.site_count}</span> },
              { label: "Contracted", value: (r) => <span className="tabular-nums">{r.contracted_billed_qty}</span> },
              { label: "On-ground req.", value: (r) => <span className="tabular-nums">{r.required_on_ground}</span> },
              { label: "Enrolled (active)", value: (r) => <span className="tabular-nums">{r.enrolled_active}</span> },
            ]}
          />

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Client</th>
                  <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Sites</th>
                  <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Contracted</th>
                  <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">On-ground req.</th>
                  <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Enrolled (active)</th>
                  <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Variance</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground text-sm">
                      No clients match the current filters.
                    </td>
                  </tr>
                )}
                {!loading &&
                  filtered.map((r) => (
                    <tr
                      key={r.client_id}
                      className="hover:bg-accent/50 cursor-pointer transition-colors"
                      onClick={() => loadDetail(r)}
                    >
                      <td className="px-4 py-3 text-sm font-medium text-foreground">{r.client_name}</td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.site_count}</td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.contracted_billed_qty}</td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.required_on_ground}</td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.enrolled_active}</td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-md text-xs border font-medium ${varianceBadge(
                            r.variance,
                          )}`}
                        >
                          {r.variance > 0 ? `+${r.variance}` : r.variance}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ChevronRight className="w-4 h-4 text-muted-foreground inline-block" />
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
        </>
        )}

        {/* §10.6: billing reconciliation — contracted vs deployed vs on-ground vs shortfall */}
        {view === "billing" && (
        <div>
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Client</th>
                    <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Contracted</th>
                    <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Deployed</th>
                    <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">On ground (att.)</th>
                    <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Shortfall</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {!loading && billing.filter((b) => b.contracted > 0 || b.deployed > 0).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground text-sm">
                        No billing lines to reconcile yet.
                      </td>
                    </tr>
                  )}
                  {billing.filter((b) => b.contracted > 0 || b.deployed > 0).map((b) => (
                    <tr key={b.client_id} className="hover:bg-accent/50 transition-colors">
                      <td className="px-4 py-3 text-sm font-medium text-foreground">{b.client_name}</td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground">{b.contracted}</td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground">{b.deployed}</td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground">{b.attendance_on_ground}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={`inline-block px-2 py-0.5 rounded-md text-xs border font-medium ${b.shortfall > 0 ? "bg-warning-50 text-warning-800 border-warning-200" : "bg-success-50 text-success-700 border-success-200"}`}>
                          {b.shortfall > 0 ? `−${b.shortfall}` : "0"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Shortfall = contracted − deployed. A client contracted for more than is on ground surfaces recruitment exposure (ties to the §8.10 vacancy queue).</p>
        </div>
        )}
      </div>

      {openClient && (
        <ClientDetailModal
          client={openClient}
          contract={clientContract(openClient.client_id)}
          sites={sites}
          shiftDefs={shiftDefs}
          strengthLines={strengthLines}
          guards={guards}
          loading={detailLoading}
          onClose={() => setOpenClient(null)}
          onChanged={refreshDetail}
          onError={setError}
        />
      )}
    </>
  );
}

// ── Client detail: sites, per-site shift definitions and strength lines ───────
function ClientDetailModal({
  client,
  contract,
  sites,
  shiftDefs,
  strengthLines,
  guards,
  loading,
  onClose,
  onChanged,
  onError,
}: {
  client: ReconRow;
  contract: ContractLite | null;
  sites: Site[];
  shiftDefs: ShiftDef[];
  strengthLines: StrengthLine[];
  guards: SiteGuard[];
  loading: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [siteModal, setSiteModal] = useState<Site | "new" | null>(null);
  const [shiftModal, setShiftModal] = useState<{ site: Site; def: ShiftDef | null } | null>(null);
  const [lineModal, setLineModal] = useState<{ site: Site; line: StrengthLine | null } | null>(null);

  const del = async (table: string, id: string) => {
    if (!confirm("Delete this record?")) return;
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) onError(error.message);
    else await onChanged();
  };

  return (
    <Modal isOpen onClose={onClose} title={`${client.client_name} — Sites & Strength`} size="lg">
      {loading ? (
        <div className="py-10 text-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
        </div>
      ) : (
        <div className="space-y-5">
          {/* Summary stat pills + add-site action. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Contracted</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">{client.contracted_billed_qty}</span>
            </div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Enrolled</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">{client.enrolled_active}</span>
            </div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Variance</span>
              <span className={`px-1.5 py-0.5 rounded-md border text-xs font-semibold tabular-nums ${varianceBadge(client.variance)}`}>
                {client.variance > 0 ? `+${client.variance}` : client.variance}
              </span>
            </div>
            <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setSiteModal("new")}>
              <Plus className="w-4 h-4 mr-1" /> Add site
            </Button>
          </div>

          {sites.length === 0 && (
            <div className="text-sm text-muted-foreground border border-dashed border-border rounded-xl p-8 text-center">
              No sites yet. Add the first site for this client.
            </div>
          )}

          {sites.map((site) => {
            const siteShifts = shiftDefs.filter((s) => s.site_id === site.id);
            const siteLines = strengthLines.filter((l) => l.site_id === site.id);
            const siteBilled = siteLines.reduce((a, l) => a + (l.billed_qty ?? 0), 0);
            const siteGuards = guards.filter((g) => g.site_id === site.id);
            return (
              <div key={site.id} className="border border-border rounded-xl overflow-hidden bg-card shadow-sm">
                {/* Site header */}
                <div className="px-4 py-3 flex items-start justify-between gap-3 border-b border-border">
                  <div className="min-w-0 flex items-start gap-2.5">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-500">
                      <Building2 className="w-4 h-4" strokeWidth={2} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground truncate">{site.name}</span>
                        {site.is_default && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide bg-brand-500/15 text-brand-700 dark:text-brand-500 border border-brand-200 rounded-full px-2 py-0.5">
                            default
                          </span>
                        )}
                      </div>
                      {site.location && (
                        <div className="text-xs text-muted-foreground flex items-center gap-1 truncate mt-0.5">
                          <MapPin className="w-3 h-3 shrink-0" /> {site.location}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[11px] font-medium text-muted-foreground bg-secondary rounded-md px-2 py-1 mr-1 tabular-nums">billed {siteBilled}</span>
                    <button className="w-8 h-8 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" onClick={() => setSiteModal(site)}>
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button className="w-8 h-8 grid place-items-center rounded-md text-muted-foreground hover:text-danger-600 hover:bg-danger-50 transition-colors" onClick={() => del("sites", site.id)}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="p-4 grid md:grid-cols-2 gap-5">
                  {/* Shift definitions */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" /> Shifts
                      </div>
                      <button
                        className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 dark:text-brand-500 hover:bg-brand-500/10 rounded-md px-2 py-1 transition-colors"
                        onClick={() => setShiftModal({ site, def: null })}
                      >
                        <Plus className="w-3.5 h-3.5" /> Add
                      </button>
                    </div>
                    {siteShifts.length === 0 ? (
                      <div className="text-xs text-muted-foreground border border-dashed border-border rounded-lg px-3 py-2.5">No shifts defined.</div>
                    ) : (
                      <ul className="space-y-1.5">
                        {siteShifts
                          .sort((a, b) => a.start_time.localeCompare(b.start_time))
                          .map((s) => (
                            <li
                              key={s.id}
                              className="group flex items-center justify-between gap-2 text-sm border border-border rounded-lg px-3 py-2 hover:border-brand-500/40 transition-colors"
                            >
                              <span className="capitalize text-foreground truncate">
                                {s.shift_code} · {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)} ·{" "}
                                {s.duration_hours}h{s.crosses_midnight ? " ⤵" : ""}
                              </span>
                              <span className="flex gap-0.5 shrink-0">
                                <button className="w-7 h-7 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" onClick={() => setShiftModal({ site, def: s })}>
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button className="w-7 h-7 grid place-items-center rounded-md text-muted-foreground hover:text-danger-600 hover:bg-danger-50 transition-colors" onClick={() => del("shift_definitions", s.id)}>
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </span>
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>

                  {/* Strength lines */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                        <Users className="w-3.5 h-3.5" /> Strength lines
                      </div>
                      <button
                        className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 dark:text-brand-500 hover:bg-brand-500/10 rounded-md px-2 py-1 transition-colors disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
                        disabled={!contract}
                        title={contract ? "" : "Client has no contract — cannot add strength line"}
                        onClick={() => contract && setLineModal({ site, line: null })}
                      >
                        <Plus className="w-3.5 h-3.5" /> Add
                      </button>
                    </div>
                    {siteLines.length === 0 ? (
                      <div className="text-xs text-muted-foreground border border-dashed border-border rounded-lg px-3 py-2.5">
                        {contract ? "No strength lines." : "No contract on file for this client."}
                      </div>
                    ) : (
                      <ul className="space-y-1.5">
                        {siteLines.map((l) => (
                          <li
                            key={l.id}
                            className="group flex items-center justify-between gap-2 text-sm border border-border rounded-lg px-3 py-2 hover:border-brand-500/40 transition-colors"
                          >
                            <span className="text-foreground truncate">
                              {CATEGORY_LABEL[l.category]}
                              {l.shift_code ? ` · ${l.shift_code}` : ""} · billed {l.billed_qty ?? 0}
                              {l.relief_allowance ? ` − ${l.relief_allowance} relief` : ""} ={" "}
                              <strong>{l.required_on_ground ?? 0}</strong>
                            </span>
                            <span className="flex gap-0.5 shrink-0">
                              <button className="w-7 h-7 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" onClick={() => setLineModal({ site, line: l })}>
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button className="w-7 h-7 grid place-items-center rounded-md text-muted-foreground hover:text-danger-600 hover:bg-danger-50 transition-colors" onClick={() => del("contract_lines", l.id)}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
                {/* Client → site → guards: who is currently posted here. */}
                <div className="px-4 pb-4 pt-1 border-t border-border">
                  <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 mb-2 mt-3">
                    <Users className="w-3.5 h-3.5" /> Guards ({siteGuards.length})
                  </div>
                  {siteGuards.length === 0 ? (
                    <div className="text-xs text-muted-foreground">No guards posted here.</div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {siteGuards.map((g) => (
                        <span key={g.guard_id} className="inline-flex items-center gap-1.5 text-xs bg-secondary border border-border rounded-md px-2 py-1">
                          <span className="text-foreground">{g.full_name}</span>
                          <span className="text-muted-foreground font-mono text-[11px]">{g.code}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {siteModal && (
        <SiteFormModal
          clientId={client.client_id}
          site={siteModal === "new" ? null : siteModal}
          onClose={() => setSiteModal(null)}
          onSaved={async () => {
            setSiteModal(null);
            await onChanged();
          }}
          onError={onError}
        />
      )}
      {shiftModal && (
        <ShiftFormModal
          site={shiftModal.site}
          def={shiftModal.def}
          onClose={() => setShiftModal(null)}
          onSaved={async () => {
            setShiftModal(null);
            await onChanged();
          }}
          onError={onError}
        />
      )}
      {lineModal && contract && (
        <StrengthLineFormModal
          site={lineModal.site}
          contractId={contract.id}
          line={lineModal.line}
          onClose={() => setLineModal(null)}
          onSaved={async () => {
            setLineModal(null);
            await onChanged();
          }}
          onError={onError}
        />
      )}
    </Modal>
  );
}

// ── Site form ────────────────────────────────────────────────────────────────
function SiteFormModal({
  clientId,
  site,
  onClose,
  onSaved,
  onError,
}: {
  clientId: string;
  site: Site | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(site?.name ?? "");
  const [location, setLocation] = useState(site?.location ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fail = (m: string) => { setErr(m); onError(m); };

  const save = async () => {
    if (!name.trim()) {
      fail("Site name is required.");
      return;
    }
    setSaving(true);
    setErr(null);
    const payload = { name: name.trim(), location: location.trim() || null };
    const { error } = site
      ? await supabase.from("sites").update(payload).eq("id", site.id)
      : await supabase.from("sites").insert({ ...payload, client_id: clientId });
    setSaving(false);
    if (error) fail(error.message);
    else await onSaved();
  };

  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title={site ? "Edit site" : "Add site"}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm text-muted-foreground">Site name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full px-3 py-2 border border-border rounded-md text-sm" />
        </label>
        <label className="block">
          <span className="text-sm text-muted-foreground">Location</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} className="mt-1 w-full px-3 py-2 border border-border rounded-md text-sm" />
        </label>
      </div>
    </Modal>
  );
}

// ── Shift definition form ─────────────────────────────────────────────────────
function ShiftFormModal({
  site,
  def,
  onClose,
  onSaved,
  onError,
}: {
  site: Site;
  def: ShiftDef | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [shiftCode, setShiftCode] = useState<ShiftCode>(def?.shift_code ?? "day");
  const [start, setStart] = useState((def?.start_time ?? "08:00").slice(0, 5));
  const [end, setEnd] = useState((def?.end_time ?? "20:00").slice(0, 5));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fail = (m: string) => { setErr(m); onError(m); };

  const { hours, crosses } = computeDuration(start, end);

  const save = async () => {
    setSaving(true);
    setErr(null);
    const payload = {
      shift_code: shiftCode,
      start_time: start,
      end_time: end,
      duration_hours: hours,
      crosses_midnight: crosses,
    };
    const { error } = def
      ? await supabase.from("shift_definitions").update(payload).eq("id", def.id)
      : await supabase.from("shift_definitions").insert({ ...payload, site_id: site.id });
    setSaving(false);
    if (error) fail(error.message);
    else await onSaved();
  };

  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title={def ? "Edit shift" : "Add shift"}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm text-muted-foreground">Shift</span>
          <ThemedSelect value={shiftCode} onChange={(e) => setShiftCode(e.target.value as ShiftCode)} className="mt-1 w-full px-3 py-2 border border-border rounded-md text-sm">
            {SHIFTS.map((s) => (
              <option key={s} value={s} className="capitalize">{s}</option>
            ))}
          </ThemedSelect>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm text-muted-foreground">Start</span>
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 w-full px-3 py-2 border border-border rounded-md text-sm" />
          </label>
          <label className="block">
            <span className="text-sm text-muted-foreground">End</span>
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="mt-1 w-full px-3 py-2 border border-border rounded-md text-sm" />
          </label>
        </div>
        <div className="text-xs text-muted-foreground">
          Duration <strong>{hours}h</strong>
          {crosses && <span className="ml-2 text-warning-700">crosses midnight</span>}
        </div>
      </div>
    </Modal>
  );
}

// ── Strength line form ────────────────────────────────────────────────────────
function StrengthLineFormModal({
  site,
  contractId,
  line,
  onClose,
  onSaved,
  onError,
}: {
  site: Site;
  contractId: string;
  line: StrengthLine | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [category, setCategory] = useState<LineCategory>(line?.category ?? "GUARD");
  const [shiftCode, setShiftCode] = useState<ShiftCode>(line?.shift_code ?? "day");
  const [billedQty, setBilledQty] = useState(String(line?.billed_qty ?? ""));
  const [relief, setRelief] = useState(String(line?.relief_allowance ?? 0));
  const [reliefMode, setReliefMode] = useState<ReliefMode>(line?.relief_mode ?? "none");
  const [billingRate, setBillingRate] = useState(String(line?.billing_rate ?? ""));
  const [otRate, setOtRate] = useState(String(line?.client_ot_rate ?? ""));
  const [effFrom, setEffFrom] = useState(line?.effective_from ?? "");
  const [effTo, setEffTo] = useState(line?.effective_to ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fail = (m: string) => { setErr(m); onError(m); };

  const req = Math.max(0, (Number(billedQty) || 0) - (Number(relief) || 0));

  const save = async () => {
    setSaving(true);
    setErr(null);
    const payload = {
      category,
      shift_code: shiftCode,
      billed_qty: billedQty === "" ? null : Number(billedQty),
      relief_allowance: Number(relief) || 0,
      relief_mode: reliefMode,
      billing_rate: billingRate === "" ? null : Number(billingRate),
      client_ot_rate: otRate === "" ? null : Number(otRate),
      effective_from: effFrom || null,
      effective_to: effTo || null,
    };
    const { error } = line
      ? await supabase.from("contract_lines").update(payload).eq("id", line.id)
      : await supabase.from("contract_lines").insert({
          ...payload,
          site_id: site.id,
          contract_id: contractId,
        });
    setSaving(false);
    if (error) fail(error.message);
    else await onSaved();
  };

  const inputCls = "mt-1 w-full px-3 py-2 border border-border rounded-md text-sm";

  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title={line ? "Edit strength line" : "Add strength line"}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Save
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm text-muted-foreground">Category</span>
          <ThemedSelect value={category} onChange={(e) => setCategory(e.target.value as LineCategory)} className={inputCls}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
            ))}
          </ThemedSelect>
        </label>
        <label className="block">
          <span className="text-sm text-muted-foreground">Shift</span>
          <ThemedSelect value={shiftCode} onChange={(e) => setShiftCode(e.target.value as ShiftCode)} className={inputCls}>
            {SHIFTS.map((s) => (
              <option key={s} value={s} className="capitalize">{s}</option>
            ))}
          </ThemedSelect>
        </label>
        <label className="block">
          <span className="text-sm text-muted-foreground">Billed qty</span>
          <input type="number" min={0} value={billedQty} onChange={(e) => setBilledQty(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className="text-sm text-muted-foreground">Relief allowance</span>
          <input type="number" min={0} value={relief} onChange={(e) => setRelief(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className="text-sm text-muted-foreground">Relief mode</span>
          <ThemedSelect value={reliefMode} onChange={(e) => setReliefMode(e.target.value as ReliefMode)} className={inputCls}>
            {RELIEF_MODES.map((m) => (
              <option key={m} value={m} className="capitalize">{m}</option>
            ))}
          </ThemedSelect>
        </label>
        <div className="flex items-end">
          <div className="text-sm text-muted-foreground">
            Required on ground: <strong className="text-foreground">{req}</strong>
          </div>
        </div>
        <label className="block">
          <span className="text-sm text-muted-foreground">Billing rate (/guard/mo)</span>
          <input type="number" min={0} value={billingRate} onChange={(e) => setBillingRate(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className="text-sm text-muted-foreground">Client OT rate</span>
          <input type="number" min={0} value={otRate} onChange={(e) => setOtRate(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className="text-sm text-muted-foreground">Effective from</span>
          <input type="date" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className="text-sm text-muted-foreground">Effective to</span>
          <input type="date" value={effTo} onChange={(e) => setEffTo(e.target.value)} className={inputCls} />
        </label>
      </div>
    </Modal>
  );
}
