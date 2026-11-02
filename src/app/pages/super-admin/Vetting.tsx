import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Search, X } from "lucide-react";
import Header from "../../components/Header";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { useRegion } from "../../lib/region";
import { usePageState } from "../../lib/pageState";
import { formatDate } from "../../lib/date";

/**
 * VETTING (3 Nov 2026 audit). Police verification was on file for 1 of 402
 * active guards, NADRA for 2, orientation, weapons certification and photos for
 * none — the largest compliance exposure in the system, and nowhere to work it
 * down. This is the queue: every active guard against the checklist, by client,
 * with the two verifications and orientation ticked in place (employees.edit).
 * It writes only the guard's own vetting fields.
 */
type Guard = {
  id: string; full_name: string; guard_code: string | null; employee_code: string | null; client_id: string | null; branch_id: string | null;
  cnic_number: string | null; cnic_expiry: string | null; photo_url: string | null;
  police_verification_status: string | null; police_verification_date: string | null;
  nadra_verisys_status: string | null; nadra_verisys_date: string | null;
  orientation_done: boolean | null; orientation_date: string | null;
  weapons_certified: boolean | null; weapons_cert_expiry: string | null;
  guard_service_licence_expiry: string | null; iban: string | null; bank_account: string | null;
};
type Step = { key: string; label: string; done: (g: Guard) => boolean };
const today = () => new Date().toISOString().slice(0, 10);
const STEPS: Step[] = [
  { key: "cnic", label: "CNIC", done: (g) => !!g.cnic_number && (!g.cnic_expiry || g.cnic_expiry >= today()) },
  { key: "photo", label: "Photo", done: (g) => !!g.photo_url },
  { key: "police", label: "Police verification", done: (g) => g.police_verification_status === "cleared" },
  { key: "nadra", label: "NADRA Verisys", done: (g) => g.nadra_verisys_status === "cleared" },
  { key: "orientation", label: "Orientation", done: (g) => !!g.orientation_done },
  { key: "weapons", label: "Weapons cert.", done: (g) => !!g.weapons_certified && (!g.weapons_cert_expiry || g.weapons_cert_expiry >= today()) },
  { key: "licence", label: "Guard licence", done: (g) => !!g.guard_service_licence_expiry && g.guard_service_licence_expiry >= today() },
  { key: "bank", label: "Bank details", done: (g) => !!(g.iban || g.bank_account) },
];

export default function Vetting() {
  const { profile, company } = useAuth();
  const canEdit = hasPermission(profile, "employees.edit");
  const { regionId } = useRegion();
  const [guards, setGuards] = useState<Guard[] | null>(null);
  const [clients, setClients] = useState<Map<string, string>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = usePageState<string>("Vetting.missing", "police");
  const [clientFilter, setClientFilter] = usePageState<string>("Vetting.client", "all");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    if (!company?.id) return;
    const [g, c] = await Promise.all([
      supabase.from("employees").select("id, full_name, guard_code, employee_code, client_id, branch_id, cnic_number, cnic_expiry, photo_url, police_verification_status, police_verification_date, nadra_verisys_status, nadra_verisys_date, orientation_done, orientation_date, weapons_certified, weapons_cert_expiry, guard_service_licence_expiry, iban, bank_account")
        .eq("company_id", company.id).eq("lifecycle_state", "active").neq("category", "office_staff").order("full_name"),
      supabase.from("clients").select("id, name").eq("company_id", company.id),
    ]);
    if (g.error) setErr(friendlyDbError(g.error));
    setGuards((g.data ?? []) as Guard[]);
    setClients(new Map(((c.data ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name])));
  }, [company?.id]);
  useEffect(() => { void load(); }, [load]);

  const inScope = useMemo(() => (guards ?? []).filter((g) => (!regionId || g.branch_id === regionId) && (clientFilter === "all" || g.client_id === clientFilter)), [guards, regionId, clientFilter]);
  const coverage = STEPS.map((s) => ({ ...s, n: inScope.filter(s.done).length }));
  const step = STEPS.find((s) => s.key === missing);
  const list = inScope.filter((g) => (!step || !step.done(g)) && (!q.trim() || `${g.full_name} ${g.guard_code ?? ""} ${g.cnic_number ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())));
  const byClient = useMemo(() => {
    const m = new Map<string, { total: number; done: number }>();
    for (const g of inScope) { const k = g.client_id ?? ""; const t = m.get(k) ?? { total: 0, done: 0 }; t.total += 1; if (STEPS.every((s) => s.done(g))) t.done += 1; m.set(k, t); }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [inScope]);

  const update = async (g: Guard, patch: Partial<Guard>) => {
    setGuards((prev) => (prev ?? []).map((x) => (x.id === g.id ? { ...x, ...patch } : x)));
    const { error } = await supabase.from("employees").update(patch).eq("id", g.id);
    if (error) { setErr(friendlyDbError(error)); void load(); return; }
    if (patch.orientation_done && company?.id) {
      // Training history (0637 gates it to employees.edit); a refusal here doesn't undo the tick.
      void supabase.from("employee_training_records").insert({ company_id: company.id, employee_id: g.id, kind: "orientation", completed_on: patch.orientation_date ?? today() });
    }
  };
  const VettingCell = ({ g, field, dateField }: { g: Guard; field: "police_verification_status" | "nadra_verisys_status"; dateField: "police_verification_date" | "nadra_verisys_date" }) => {
    const v = g[field];
    if (!canEdit) return <span className={v === "cleared" ? "text-up" : v === "adverse" ? "text-down font-semibold" : "text-muted-foreground"}>{v ?? "—"}{g[dateField] ? ` · ${formatDate(g[dateField])}` : ""}</span>;
    return (
      <span className="inline-flex items-center gap-1">
        <select value={v ?? ""} onChange={(e) => void update(g, { [field]: e.target.value || null, [dateField]: e.target.value ? today() : null } as Partial<Guard>)}
          className={`px-1.5 py-0.5 rounded border border-border bg-card text-xs ${v === "cleared" ? "text-up" : v === "adverse" ? "text-down" : ""}`}>
          <option value="">Not sent</option><option value="pending">Sent, awaiting</option><option value="cleared">Cleared</option><option value="adverse">Adverse</option>
        </select>
        {g[dateField] && <span className="text-[10px] text-muted-foreground">{formatDate(g[dateField])}</span>}
      </span>
    );
  };

  return (
    <>
      <Header title="Vetting" subtitle="Every active guard against the hiring checklist — police verification, NADRA, orientation, licences — worked down by client" />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4">
        {err && <div className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{err}</div>}
        {!guards ? <div className="text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div> : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
              {coverage.map((s) => {
                const pct = inScope.length ? Math.round((s.n / inScope.length) * 100) : 0;
                return (
                  <button key={s.key} type="button" onClick={() => setMissing(missing === s.key ? "" : s.key)}
                    className={`text-left rounded-xl border px-3 py-2 bg-card ${missing === s.key ? "border-brand-500 ring-1 ring-brand-500" : "border-border hover:border-brand-500/60"}`}>
                    <div className="text-[11px] text-muted-foreground">{s.label}</div>
                    <div className={`font-ledger text-xl font-semibold ${pct < 50 ? "text-down" : pct < 90 ? "text-heed" : "text-up"}`}>{pct}%</div>
                    <div className="text-[11px] text-muted-foreground">{s.n} / {inScope.length}</div>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="px-3 py-1.5 rounded-lg border border-border bg-card text-sm">
                <option value="all">All clients</option>
                {byClient.map(([id, t]) => <option key={id} value={id}>{clients.get(id) ?? "Not under a client"} — {t.done}/{t.total} fully vetted</option>)}
              </select>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, code or CNIC" className="pl-8 pr-3 py-1.5 rounded-lg border border-border bg-card text-sm" />
              </div>
              <span className="text-sm text-muted-foreground">{list.length} guard{list.length === 1 ? "" : "s"}{step ? ` missing ${step.label.toLowerCase()}` : ""}</span>
            </div>

            <div className="rounded-xl border border-border bg-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/60"><tr className="text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">Guard</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Police</th><th className="px-3 py-2">NADRA</th>
                  <th className="px-3 py-2">Orientation</th><th className="px-3 py-2">Checklist</th>
                </tr></thead>
                <tbody>
                  {list.slice(0, 300).map((g) => (
                    <tr key={g.id} className="border-t border-border align-top">
                      <td className="px-3 py-2"><div className="text-foreground">{g.full_name}</div><div className="text-[11px] text-muted-foreground">{g.guard_code ?? g.employee_code ?? ""}{g.cnic_number ? ` · ${g.cnic_number}` : ""}</div></td>
                      <td className="px-3 py-2 text-xs">{g.client_id ? clients.get(g.client_id) ?? "" : "—"}</td>
                      <td className="px-3 py-2 text-xs"><VettingCell g={g} field="police_verification_status" dateField="police_verification_date" /></td>
                      <td className="px-3 py-2 text-xs"><VettingCell g={g} field="nadra_verisys_status" dateField="nadra_verisys_date" /></td>
                      <td className="px-3 py-2 text-xs">
                        {canEdit ? (
                          <label className="inline-flex items-center gap-1.5">
                            <input type="checkbox" checked={!!g.orientation_done} onChange={(e) => void update(g, { orientation_done: e.target.checked, orientation_date: e.target.checked ? today() : null })} />
                            {g.orientation_date ? formatDate(g.orientation_date) : "Done"}
                          </label>
                        ) : g.orientation_done ? "Done" : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex flex-wrap gap-1">{STEPS.map((s) => (
                          <span key={s.key} title={s.label} className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] ${s.done(g) ? "bg-success-50 text-success-700 dark:text-success-500" : "bg-muted text-muted-foreground"}`}>
                            {s.done(g) ? <Check className="w-2.5 h-2.5" /> : <X className="w-2.5 h-2.5" />}{s.label.split(" ")[0]}
                          </span>
                        ))}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {list.length > 300 && <p className="px-3 py-2 text-xs text-muted-foreground">Showing the first 300 — filter by client to see the rest.</p>}
            </div>
            <p className="text-xs text-muted-foreground">Photos, licences, weapons certificates and bank details are entered on the guard's record (Employees); this page counts them.</p>
          </>
        )}
      </div>
    </>
  );
}
