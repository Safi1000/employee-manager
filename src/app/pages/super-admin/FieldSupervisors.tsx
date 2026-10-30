import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Ban, Building2, Check, ChevronDown, ChevronRight, KeyRound, Loader2, MapPin, Phone, Plus,
  Search, ShieldCheck, Smartphone, UserCheck, Users, X,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import Tabs from "../../components/Tabs";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { useRegion } from "../../lib/region";

/**
 * Operations ▸ Field Supervisors (30 Oct 2026). Replaces the Field accounts card
 * that sat in Access & Governance: Shayan asked for "a separate page … proper
 * clients then sites, show how many people are under each supervisor".
 *
 * Two views of one fact — which field login covers which site:
 *   Supervisors      each login, its phone, and its sites grouped by client
 *                    with the guards under it;
 *   Clients & sites  every client → its sites, the guards there, and who covers
 *                    each one, with the sites nobody covers called out.
 *
 * Guard counts come from admin_field_coverage() (0610), which counts
 * field_site_roster(site) — the list the supervisor's phone shows — so this
 * page and the phone cannot disagree. A supervisor's total is the sum over
 * their sites (a guard sits on one site's roster only). Nothing is added up
 * here beyond those per-site counts.
 *
 * The region switch in the top bar narrows both views and the headline figures
 * to that region's clients (clients.branch_id); a supervisor shows when any of
 * their sites is in it.
 *
 * Super admins only, like every admin_field_* function. A supervisor signs in
 * with their employee code + a 6-digit PIN on ONE approved phone and sees only
 * their own sites' guards — no pay, no CNIC numbers.
 */

type Device = { id: string; label: string | null; status: "active" | "pending"; first_seen: string; last_seen: string | null };
type Account = {
  user_id: string; name: string; employee_code: string | null;
  sites: { id: string; name: string }[]; devices: Device[];
  disabled_at: string | null; last_login: string | null;
};
type Cover = {
  site_id: string; site_name: string; location: string | null; client_id: string; client_name: string;
  region: string | null; guards: number; flagged: number;
  supervisors: { user_id: string; name: string; disabled: boolean }[];
};
type ClientGroup = { client_id: string; client_name: string; region: string | null; sites: Cover[]; guards: number; flagged: number; covered: number };
type RosterRow = { employee_id: string; full_name: string; employee_code: string | null; shift: string | null; phone: string | null; has_photo: boolean; flags: string[] };
type Emp = { id: string; full_name: string; employee_code: string; designation: string | null };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A site counts as covered when a login that is not disabled covers it. */
const isCovered = (c: Cover) => c.supervisors.some((s) => !s.disabled);

function groupByClient(rows: Cover[]): ClientGroup[] {
  const map = new Map<string, ClientGroup>();
  for (const r of rows) {
    const g = map.get(r.client_id) ?? { client_id: r.client_id, client_name: r.client_name, region: r.region, sites: [], guards: 0, flagged: 0, covered: 0 };
    g.sites.push(r); g.guards += r.guards; g.flagged += r.flagged; if (isCovered(r)) g.covered += 1;
    map.set(r.client_id, g);
  }
  return [...map.values()].sort((a, b) => a.client_name.localeCompare(b.client_name));
}

async function invokeField(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("field-account", { body });
  let res = data as { error?: string; ok?: boolean } | null;
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") { try { res = await ctx.json(); } catch { /* not JSON */ } }
  return res?.error ?? (error ? error.message : null);
}

const inputCls = "rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground";

/** Clients → sites, with a whole-client tick, guard counts and who already covers each site. */
function SitePicker({ cover, value, onChange, self }: { cover: Cover[]; value: string[]; onChange: (v: string[]) => void; self?: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const chosen = new Set(value);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = needle ? cover.filter((c) => `${c.client_name} ${c.site_name} ${c.location ?? ""} ${c.region ?? ""}`.toLowerCase().includes(needle)) : cover;
    return groupByClient(rows);
  }, [cover, q]);
  const guardsChosen = cover.filter((c) => chosen.has(c.site_id)).reduce((n, c) => n + c.guards, 0);

  const setMany = (ids: string[], on: boolean) => {
    const next = new Set(value);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    onChange([...next]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client, site or region…" className={`${inputCls} w-full pl-8`} />
      </div>
      <div className="max-h-80 overflow-y-auto rounded-lg border border-border divide-y divide-border">
        {groups.map((g) => {
          const ids = g.sites.map((s) => s.site_id);
          const n = ids.filter((id) => chosen.has(id)).length;
          const single = g.sites.length === 1;
          const expanded = open[g.client_id] ?? (!!q.trim() || (n > 0 && n < ids.length));
          return (
            <div key={g.client_id}>
              <div className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-muted/40">
                <input type="checkbox" checked={n === ids.length} ref={(el) => { if (el) el.indeterminate = n > 0 && n < ids.length; }}
                  onChange={(e) => setMany(ids, e.target.checked)} aria-label={`All of ${g.client_name}`} />
                <button type="button" className="flex flex-1 items-center gap-1.5 text-left" onClick={() => !single && setOpen((o) => ({ ...o, [g.client_id]: !expanded }))}>
                  {!single && (expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />)}
                  <span className="text-sm font-medium text-foreground">{g.client_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {single ? (g.sites[0].site_name !== g.client_name ? `· ${g.sites[0].site_name} ` : "") : `· ${plural(ids.length, "site")} `}
                    · {plural(g.guards, "guard")}{g.region ? ` · ${g.region}` : ""}
                  </span>
                </button>
                {single && <OtherSupervisors c={g.sites[0]} self={self} />}
              </div>
              {!single && expanded && g.sites.map((s) => (
                <label key={s.site_id} className="flex cursor-pointer items-center gap-2 py-1 pl-9 pr-2.5 text-sm hover:bg-muted/40">
                  <input type="checkbox" checked={chosen.has(s.site_id)} onChange={(e) => setMany([s.site_id], e.target.checked)} />
                  <span className="text-foreground">{s.site_name}</span>
                  <span className="text-xs text-muted-foreground">{s.location ? `${s.location} · ` : ""}{plural(s.guards, "guard")}</span>
                  <span className="ml-auto"><OtherSupervisors c={s} self={self} /></span>
                </label>
              ))}
            </div>
          );
        })}
        {groups.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">No match.</p>}
      </div>
      <p className="text-xs text-muted-foreground">{plural(value.length, "site")} chosen · {plural(guardsChosen, "guard")} under this supervisor</p>
    </div>
  );
}

function OtherSupervisors({ c, self }: { c: Cover; self?: string }) {
  const others = c.supervisors.filter((s) => s.user_id !== self && !s.disabled);
  if (!others.length) return null;
  return <span className="whitespace-nowrap text-xs text-muted-foreground">also {others.map((s) => s.name).join(", ")}</span>;
}

/** The guards at one site — the same list the supervisor's phone shows. */
function RosterModal({ site, onClose }: { site: Cover; onClose: () => void }) {
  const [rows, setRows] = useState<RosterRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void supabase.rpc("field_site_roster", { p_site_id: site.site_id }).then(({ data, error }) => {
      if (error) setErr(friendlyDbError(error)); else setRows((data ?? []) as RosterRow[]);
    });
  }, [site.site_id]);
  const byShift = useMemo(() => {
    const m = new Map<string, RosterRow[]>();
    (rows ?? []).forEach((r) => { const k = r.shift || "No shift"; m.set(k, [...(m.get(k) ?? []), r]); });
    return [...m.entries()];
  }, [rows]);
  return (
    <Modal isOpen onClose={onClose} title={`${site.site_name} · ${site.client_name}`} size="lg" error={err} onDismissError={() => setErr(null)}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          What the supervisor's phone shows for this site.{" "}
          {site.supervisors.length ? `Covered by ${site.supervisors.map((s) => s.name + (s.disabled ? " (disabled)" : "")).join(", ")}.` : "No supervisor covers it."}
        </p>
        {rows === null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active guards are posted here.</p>
        ) : byShift.map(([shift, list]) => (
          <div key={shift}>
            <p className="lbl mb-1">{shift} · {list.length}</p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {list.map((r) => (
                <li key={r.employee_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-sm">
                  <span className="text-foreground">{r.full_name} <span className="font-ledger text-xs text-muted-foreground">{r.employee_code}</span></span>
                  <span className="flex flex-wrap items-center gap-2 text-xs">
                    {r.flags.map((f) => <span key={f} className="rounded bg-heed/10 px-1.5 font-medium text-heed">{f}</span>)}
                    {r.phone && <a href={`tel:${r.phone}`} className="text-muted-foreground hover:text-foreground"><Phone className="mr-0.5 inline h-3 w-3" />{r.phone}</a>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export default function FieldSupervisors() {
  const [view, setView] = useState<"supervisors" | "clients">("supervisors");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [cover, setCover] = useState<Cover[] | null>(null);
  const [emps, setEmps] = useState<Emp[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openSup, setOpenSup] = useState<Record<string, boolean>>({});
  const [openClient, setOpenClient] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const { region } = useRegion();
  const [onlyUncovered, setOnlyUncovered] = useState(false);
  // modals
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [resetting, setResetting] = useState<Account | null>(null);
  const [roster, setRoster] = useState<Cover | null>(null);
  const [assigning, setAssigning] = useState<Cover | null>(null);
  const [empQ, setEmpQ] = useState("");
  const [empId, setEmpId] = useState("");
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [pin, setPin] = useState("");
  const [modalErr, setModalErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, c] = await Promise.all([supabase.rpc("admin_field_accounts"), supabase.rpc("admin_field_coverage")]);
    if (a.error || c.error) { setErr(friendlyDbError((a.error ?? c.error)!)); return; }
    setAccounts((a.data ?? []) as Account[]);
    setCover((c.data ?? []) as Cover[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const loadEmps = useCallback(async () => {
    if (emps.length) return;
    const { data } = await supabase.from("employees").select("id, full_name, employee_code, designation")
      .in("status", ["Active", "On Leave"]).order("full_name");
    setEmps((data ?? []) as Emp[]);
  }, [emps.length]);

  const empMatches = useMemo(() => {
    const term = empQ.trim().toLowerCase();
    if (!term) return emps.filter((e) => /sup/i.test(e.designation ?? "")).slice(0, 8);
    return emps.filter((e) => `${e.full_name} ${e.employee_code}`.toLowerCase().includes(term)).slice(0, 8);
  }, [empQ, emps]);

  const coverById = useMemo(() => new Map((cover ?? []).map((c) => [c.site_id, c])), [cover]);
  // The top-bar region, by the branch name admin_field_coverage returns.
  const regionCover = useMemo(() => (cover ?? []).filter((c) => !region || c.region === region.name), [cover, region]);

  // Headline figures — each a count over admin_field_coverage's per-site rows.
  const stats = useMemo(() => {
    const rows = regionCover;
    const manned = rows.filter((c) => c.guards > 0);
    return {
      logins: (accounts ?? []).filter((a) => !a.disabled_at).length,
      pending: (accounts ?? []).reduce((n, a) => n + a.devices.filter((d) => d.status === "pending").length, 0),
      sitesCovered: manned.filter(isCovered).length,
      sitesManned: manned.length,
      guardsCovered: manned.filter(isCovered).reduce((n, c) => n + c.guards, 0),
      guardsTotal: manned.reduce((n, c) => n + c.guards, 0),
      uncovered: manned.filter((c) => !isCovered(c)).length,
    };
  }, [accounts, regionCover]);

  const clientGroups = useMemo(() => {
    const term = q.trim().toLowerCase();
    let rows = regionCover;
    if (onlyUncovered) rows = rows.filter((c) => c.guards > 0 && !isCovered(c));
    if (term) rows = rows.filter((c) => `${c.client_name} ${c.site_name} ${c.location ?? ""} ${c.supervisors.map((s) => s.name).join(" ")}`.toLowerCase().includes(term));
    return groupByClient(rows).sort((a, b) => b.guards - a.guards || a.client_name.localeCompare(b.client_name));
  }, [regionCover, q, onlyUncovered]);

  const supRows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (accounts ?? [])
      .map((a) => {
        const sites = a.sites.map((s) => coverById.get(s.id)).filter(Boolean) as Cover[];
        return { a, sites, groups: groupByClient(sites), guards: sites.reduce((n, s) => n + s.guards, 0), flagged: sites.reduce((n, s) => n + s.flagged, 0) };
      })
      .filter((r) => !region || r.sites.some((s) => s.region === region.name))
      .filter((r) => !term || `${r.a.name} ${r.a.employee_code ?? ""} ${r.sites.map((s) => `${s.client_name} ${s.site_name}`).join(" ")}`.toLowerCase().includes(term))
      .sort((x, y) => Number(!!x.a.disabled_at) - Number(!!y.a.disabled_at) || x.a.name.localeCompare(y.a.name));
  }, [accounts, coverById, q, region]);

  const pinOk = /^\d{6}$/.test(pin);

  const create = async () => {
    if (!empId || !pinOk) { setModalErr("Choose the employee and a 6-digit PIN."); return; }
    setBusy("create"); setModalErr(null);
    const msg = await invokeField({ action: "create", employee_id: empId, pin, site_ids: siteIds });
    setBusy(null);
    if (msg) { setModalErr(msg); return; }
    const emp = emps.find((e) => e.id === empId);
    setNote(`Field login created. ${emp?.full_name} signs in with code ${emp?.employee_code} and the PIN you set — tell them the PIN in person.`);
    setCreating(false); setPin(""); setEmpId(""); setSiteIds([]); void load();
  };
  const writeSites = async (userId: string, ids: string[]) => {
    const { error } = await supabase.rpc("admin_field_set_sites", { p_user_id: userId, p_sites: ids });
    return error ? friendlyDbError(error) : null;
  };
  const saveSites = async () => {
    if (!editing) return;
    setBusy("sites"); setModalErr(null);
    const msg = await writeSites(editing.user_id, siteIds);
    setBusy(null);
    if (msg) { setModalErr(msg); return; }
    setEditing(null); void load();
  };
  const assignTo = async (a: Account) => {
    if (!assigning) return;
    setBusy(a.user_id); setModalErr(null);
    const msg = await writeSites(a.user_id, [...new Set([...a.sites.map((s) => s.id), assigning.site_id])]);
    setBusy(null);
    if (msg) { setModalErr(msg); return; }
    setNote(`${assigning.site_name} added to ${a.name}'s sites.`);
    setAssigning(null); void load();
  };
  const unassign = async (c: Cover, userId: string, name: string) => {
    const a = accounts?.find((x) => x.user_id === userId);
    if (!a || !window.confirm(`Take ${c.site_name} off ${name}'s sites? Its guards disappear from their phone.`)) return;
    setBusy(`${c.site_id}:${userId}`); setErr(null);
    const msg = await writeSites(userId, a.sites.map((s) => s.id).filter((id) => id !== c.site_id));
    setBusy(null);
    if (msg) setErr(msg); else void load();
  };
  const resetPin = async () => {
    if (!resetting || !pinOk) { setModalErr("Enter a 6-digit PIN."); return; }
    setBusy("pin"); setModalErr(null);
    const msg = await invokeField({ action: "reset_pin", user_id: resetting.user_id, pin });
    setBusy(null);
    if (msg) { setModalErr(msg); return; }
    setNote(`PIN reset for ${resetting.name}. Their phone is signed out; they sign in again with the new PIN.`);
    setResetting(null); setPin("");
  };
  const decide = async (d: Device, status: "active" | "revoked", who: string) => {
    if (status === "revoked" && !window.confirm(`Cut off this phone for ${who}? They will need a phone you approve to use the app again.`)) return;
    setBusy(d.id); setErr(null);
    const { error } = await supabase.rpc("admin_field_decide_device", { p_device_row_id: d.id, p_status: status });
    setBusy(null);
    if (error) setErr(friendlyDbError(error)); else void load();
  };
  const setDisabled = async (a: Account, disabled: boolean) => {
    let reason: string | null = null;
    if (disabled) { reason = window.prompt(`Why is ${a.name}'s field login being disabled?`); if (!reason?.trim()) return; }
    setBusy(a.user_id); setErr(null);
    const { error } = await supabase.rpc("set_user_disabled", { p_user_id: a.user_id, p_disabled: disabled, p_reason: reason?.trim() ?? null });
    setBusy(null);
    if (error) setErr(friendlyDbError(error)); else void load();
  };

  const openCreate = () => { setCreating(true); setModalErr(null); setPin(""); setEmpId(""); setEmpQ(""); setSiteIds([]); void loadEmps(); };
  const loading = accounts === null || cover === null;

  const tiles = [
    { label: "Supervisor logins", value: `${stats.logins}`, icon: Users, tint: "text-muted-foreground" },
    { label: "Phones waiting", value: `${stats.pending}`, icon: Smartphone, tint: stats.pending ? "text-heed" : "text-muted-foreground" },
    { label: "Sites covered", value: `${stats.sitesCovered} / ${stats.sitesManned}`, icon: MapPin, tint: "text-muted-foreground" },
    { label: "Guards covered", value: `${stats.guardsCovered} / ${stats.guardsTotal}`, icon: ShieldCheck, tint: "text-muted-foreground" },
    { label: "Sites with nobody", value: `${stats.uncovered}`, icon: AlertTriangle, tint: stats.uncovered ? "text-heed" : "text-up" },
  ];

  return (
    <>
      <Header
        title="Field Supervisors"
        subtitle="Who supervises which sites in the field app, and how many guards each one answers for"
        actions={<Button size="sm" onClick={openCreate}><Plus className="mr-1.5 h-4 w-4" strokeWidth={1.5} /> New field login</Button>}
      />

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4 md:p-8">
        {err && (
          <div className="flex items-start gap-2 rounded-md border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700">
            <AlertTriangle className="mt-0.5 h-4 w-4" /><div className="flex-1">{err}</div>
            <button onClick={() => setErr(null)} aria-label="Dismiss"><X className="h-4 w-4" /></button>
          </div>
        )}
        {note && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-card p-3 text-sm text-up">
            <Check className="mt-0.5 h-4 w-4" /><div className="flex-1">{note}</div>
            <button onClick={() => setNote(null)} aria-label="Dismiss"><X className="h-4 w-4" /></button>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {tiles.map((t) => (
            <div key={t.label} className="inline-flex items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2">
              <t.icon className={`h-4 w-4 shrink-0 ${t.tint}`} strokeWidth={2} />
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</span>
              <span className="text-base font-semibold tabular-nums text-foreground">{loading ? "…" : t.value}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <Tabs value={view} onChange={setView} items={[
            { value: "supervisors", label: "Supervisors", count: stats.logins },
            { value: "clients", label: "Clients & sites", count: stats.uncovered || undefined },
          ]} />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center md:ml-auto">
            <div className="relative sm:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={view === "clients" ? "Search client, site, supervisor…" : "Search supervisor, client, site…"}
                className="w-full rounded-md border border-border bg-card py-2 pl-10 pr-3 text-sm text-foreground" />
            </div>
            {view === "clients" && (
                <label className="flex select-none items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
                  <input type="checkbox" checked={onlyUncovered} onChange={(e) => setOnlyUncovered(e.target.checked)} /> Only sites with nobody
                </label>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : view === "supervisors" ? (
          supRows.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
              {accounts!.length ? (region ? `No supervisor covers a site in ${region.name}${q.trim() ? " that matches the search" : ""}.` : "No supervisor matches the search.") : "No field logins yet. Use New field login to create the first one."}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {supRows.map(({ a, sites, groups, guards, flagged }) => {
                const expanded = openSup[a.user_id] ?? false;
                const phone = a.devices.find((d) => d.status === "active");
                return (
                  <div key={a.user_id} className={`rounded-lg border border-border bg-card ${a.disabled_at ? "opacity-60" : ""}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3 p-4">
                      <button type="button" className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={() => setOpenSup((o) => ({ ...o, [a.user_id]: !expanded }))}>
                        {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                        <div className="min-w-0">
                          <p className={`text-sm font-semibold ${a.disabled_at ? "text-muted-foreground line-through" : "text-foreground"}`}>
                            {a.name} <span className="font-ledger text-xs font-normal text-muted-foreground">{a.employee_code}</span>
                            {a.disabled_at && <span className="ml-2 rounded bg-muted px-1.5 text-xs font-medium text-muted-foreground no-underline">disabled</span>}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {sites.length ? `${plural(groups.length, "client")} · ${plural(sites.length, "site")}` : "No sites yet"}
                            {" · "}{phone ? <span className="text-up">phone approved</span> : a.devices.some((d) => d.status === "pending") ? <span className="font-semibold text-heed">phone waiting</span> : "no phone yet"}
                            {" · "}last sign-in {when(a.last_login)}
                          </p>
                        </div>
                      </button>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className="text-xl font-semibold tabular-nums text-foreground">{guards}</p>
                          <p className="text-xs text-muted-foreground">guards{flagged ? <span className="text-heed"> · {flagged} flagged</span> : null}</p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Button size="sm" variant="secondary" onClick={() => { setEditing(a); setSiteIds(a.sites.map((s) => s.id)); setModalErr(null); }}><MapPin className="mr-1 h-3.5 w-3.5" />Sites</Button>
                          <Button size="sm" variant="ghost" onClick={() => { setResetting(a); setPin(""); setModalErr(null); }}><KeyRound className="mr-1 h-3.5 w-3.5" />PIN</Button>
                          {a.disabled_at ? (
                            <Button size="sm" variant="ghost" disabled={busy === a.user_id} onClick={() => void setDisabled(a, false)}><UserCheck className="mr-1 h-3.5 w-3.5" />Enable</Button>
                          ) : (
                            <Button size="sm" variant="ghost" disabled={busy === a.user_id} onClick={() => void setDisabled(a, true)}><Ban className="mr-1 h-3.5 w-3.5" />Disable</Button>
                          )}
                        </div>
                      </div>
                    </div>

                    {a.devices.filter((d) => d.status === "pending").map((d) => (
                      <div key={d.id} className="mx-4 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-heed/10 px-3 py-2 text-xs">
                        <span className="text-foreground"><Smartphone className="mr-1 inline h-3.5 w-3.5" />{d.label ?? "A phone"} wants to sign in · first seen {when(d.first_seen)}
                          {phone && <span className="text-muted-foreground"> · approving it cuts off the current phone</span>}</span>
                        <span className="flex gap-1">
                          <Button size="sm" variant="secondary" disabled={busy === d.id} onClick={() => void decide(d, "active", a.name)}><Check className="mr-1 h-3.5 w-3.5" />Approve</Button>
                          <Button size="sm" variant="ghost" disabled={busy === d.id} onClick={() => void decide(d, "revoked", a.name)}><X className="mr-1 h-3.5 w-3.5" />Refuse</Button>
                        </span>
                      </div>
                    ))}

                    {expanded && (
                      <div className="border-t border-border px-4 py-3">
                        {phone && (
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-1.5 text-xs">
                            <span className="text-foreground"><Smartphone className="mr-1 inline h-3.5 w-3.5" />{phone.label ?? "Phone"} · approved · last seen {when(phone.last_seen)}</span>
                            <Button size="sm" variant="ghost" disabled={busy === phone.id} onClick={() => void decide(phone, "revoked", a.name)}><X className="mr-1 h-3.5 w-3.5" />Cut off</Button>
                          </div>
                        )}
                        {groups.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No sites yet — the phone will show nothing until you give them sites.</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                                  <th className="py-1.5 pr-3 font-medium">Client / site</th>
                                  <th className="py-1.5 pr-3 font-medium">Region</th>
                                  <th className="py-1.5 pr-3 text-right font-medium">Guards</th>
                                  <th className="py-1.5 text-right font-medium">Flagged</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border">
                                {groups.map((g) => (
                                  g.sites.length === 1 ? (
                                    <tr key={g.client_id} className="cursor-pointer hover:bg-muted/40" onClick={() => setRoster(g.sites[0])}>
                                      <td className="py-1.5 pr-3 text-foreground">{g.client_name}{g.sites[0].site_name !== g.client_name && <span className="text-muted-foreground"> · {g.sites[0].site_name}</span>}</td>
                                      <td className="py-1.5 pr-3 text-muted-foreground">{g.region ?? "—"}</td>
                                      <td className="py-1.5 pr-3 text-right tabular-nums text-foreground">{g.guards}</td>
                                      <td className={`py-1.5 text-right tabular-nums ${g.flagged ? "text-heed" : "text-muted-foreground"}`}>{g.flagged || "—"}</td>
                                    </tr>
                                  ) : [
                                    <tr key={g.client_id} className="bg-muted/20">
                                      <td className="py-1.5 pr-3 font-medium text-foreground">{g.client_name} <span className="text-xs font-normal text-muted-foreground">· {plural(g.sites.length, "site")}</span></td>
                                      <td className="py-1.5 pr-3 text-muted-foreground">{g.region ?? "—"}</td>
                                      <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">{g.guards}</td>
                                      <td className={`py-1.5 text-right tabular-nums ${g.flagged ? "text-heed" : "text-muted-foreground"}`}>{g.flagged || "—"}</td>
                                    </tr>,
                                    ...g.sites.map((s) => (
                                      <tr key={s.site_id} className="cursor-pointer hover:bg-muted/40" onClick={() => setRoster(s)}>
                                        <td className="py-1 pl-5 pr-3 text-foreground">{s.site_name}{s.location && <span className="text-xs text-muted-foreground"> · {s.location}</span>}</td>
                                        <td className="py-1 pr-3" />
                                        <td className="py-1 pr-3 text-right tabular-nums text-foreground">{s.guards}</td>
                                        <td className={`py-1 text-right tabular-nums ${s.flagged ? "text-heed" : "text-muted-foreground"}`}>{s.flagged || "—"}</td>
                                      </tr>
                                    )),
                                  ]
                                ))}
                              </tbody>
                            </table>
                            <p className="mt-2 text-xs text-muted-foreground">Click a site to see its guards as the phone shows them. Flagged = an expired CNIC, licence or medical.</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          clientGroups.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
              {onlyUncovered ? "Every site with guards has a supervisor." : "No client matches the filters."}
            </div>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {clientGroups.map((g) => {
                const expanded = openClient[g.client_id] ?? (onlyUncovered || !!q.trim());
                const manned = g.sites.filter((s) => s.guards > 0).length;
                const coveredManned = g.sites.filter((s) => s.guards > 0 && isCovered(s)).length;
                return (
                  <div key={g.client_id}>
                    <button type="button" className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-muted/30"
                      onClick={() => setOpenClient((o) => ({ ...o, [g.client_id]: !expanded }))}>
                      {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                      <Building2 className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
                      <span className="text-sm font-semibold text-foreground">{g.client_name}</span>
                      <span className="text-xs text-muted-foreground">{g.region ?? "No region"} · {plural(g.sites.length, "site")}</span>
                      <span className="ml-auto flex items-center gap-3 text-xs">
                        <span className="tabular-nums text-foreground">{plural(g.guards, "guard")}</span>
                        {g.flagged > 0 && <span className="text-heed">{g.flagged} flagged</span>}
                        {manned === 0 ? <span className="text-muted-foreground">no guards posted</span>
                          : coveredManned === manned ? <span className="text-up">covered</span>
                          : <span className="font-semibold text-heed">{manned === 1 ? "site has nobody" : `${manned - coveredManned} of ${manned} sites have nobody`}</span>}
                      </span>
                    </button>
                    {expanded && (
                      <ul className="divide-y divide-border border-t border-border bg-muted/10">
                        {g.sites.map((s) => (
                          <li key={s.site_id} className="flex flex-wrap items-center gap-3 py-2 pl-12 pr-4">
                            <button type="button" className="min-w-0 text-left" onClick={() => setRoster(s)}>
                              <span className="text-sm text-foreground hover:underline">{s.site_name}</span>
                              {s.location && <span className="text-xs text-muted-foreground"> · {s.location}</span>}
                            </button>
                            <span className="text-xs tabular-nums text-muted-foreground">{plural(s.guards, "guard")}{s.flagged ? <span className="text-heed"> · {s.flagged} flagged</span> : null}</span>
                            <span className="ml-auto flex flex-wrap items-center gap-1.5">
                              {s.supervisors.map((sv) => (
                                <span key={sv.user_id} className={`inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs ${sv.disabled ? "text-muted-foreground line-through" : "text-foreground"}`}>
                                  <UserCheck className="h-3 w-3" />{sv.name}
                                  <button type="button" aria-label={`Remove ${sv.name}`} disabled={busy === `${s.site_id}:${sv.user_id}`}
                                    className="text-muted-foreground hover:text-foreground" onClick={() => void unassign(s, sv.user_id, sv.name)}><X className="h-3 w-3" /></button>
                                </span>
                              ))}
                              {s.guards > 0 && !isCovered(s) && <span className="text-xs font-semibold text-heed">nobody</span>}
                              <Button size="sm" variant="ghost" onClick={() => { setAssigning(s); setModalErr(null); }}><Plus className="mr-1 h-3.5 w-3.5" />Supervisor</Button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>

      {roster && <RosterModal site={roster} onClose={() => setRoster(null)} />}

      {assigning && (
        <Modal isOpen onClose={() => setAssigning(null)} title={`Supervisor for ${assigning.site_name}`} size="md" error={modalErr} onDismissError={() => setModalErr(null)}>
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">{assigning.client_name} · {plural(assigning.guards, "guard")}. The site is added to the login you pick; its other sites stay.</p>
            {(accounts ?? []).filter((a) => !a.disabled_at).length === 0 ? (
              <p className="text-sm text-muted-foreground">No field logins yet. Create one with New field login.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {(accounts ?? []).filter((a) => !a.disabled_at).map((a) => {
                  const has = a.sites.some((s) => s.id === assigning.site_id);
                  const total = a.sites.reduce((n, s) => n + (coverById.get(s.id)?.guards ?? 0), 0);
                  return (
                    <li key={a.user_id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span className="text-foreground">{a.name} <span className="text-xs text-muted-foreground">{a.employee_code} · {plural(a.sites.length, "site")} · {plural(total, "guard")}</span></span>
                      {has ? <span className="text-xs text-up">already covers it</span> : (
                        <Button size="sm" variant="secondary" disabled={busy === a.user_id} onClick={() => void assignTo(a)}>Add</Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Modal>
      )}

      {creating && (
        <Modal isOpen onClose={() => setCreating(false)} title="New field login" size="lg" error={modalErr} onDismissError={() => setModalErr(null)}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="lbl">Supervisor</span>
              <input value={empQ} onChange={(e) => { setEmpQ(e.target.value); setEmpId(""); }} placeholder="Search by name or code…" className={inputCls} />
              {!empId && (
                <ul className="max-h-48 overflow-y-auto rounded-lg border border-border text-sm">
                  {empMatches.map((e) => (
                    <li key={e.id}>
                      <button type="button" onClick={() => { setEmpId(e.id); setEmpQ(`${e.full_name} (${e.employee_code})`); }}
                        className="w-full px-2.5 py-1.5 text-left text-foreground hover:bg-muted/50">
                        {e.full_name} <span className="text-xs text-muted-foreground">{e.employee_code}{e.designation ? ` · ${e.designation}` : ""}</span>
                      </button>
                    </li>
                  ))}
                  {empMatches.length === 0 && <li className="px-2.5 py-1.5 text-xs text-muted-foreground">No match.</li>}
                </ul>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="lbl">Sites they cover</span>
              <SitePicker cover={cover ?? []} value={siteIds} onChange={setSiteIds} />
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="lbl">6-digit PIN</span>
              <input inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                className={`${inputCls} w-36 font-ledger tracking-widest`} />
              <span className="text-xs text-muted-foreground">Give it to the supervisor in person. Not 111111 or 123456.</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
              <Button size="sm" disabled={busy === "create"} onClick={() => void create()}>
                {busy === "create" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Create login
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal isOpen onClose={() => setEditing(null)} title={`Sites — ${editing.name}`} size="lg" error={modalErr} onDismissError={() => setModalErr(null)}>
          <div className="flex flex-col gap-4">
            <SitePicker cover={cover ?? []} value={siteIds} onChange={setSiteIds} self={editing.user_id} />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button size="sm" disabled={busy === "sites"} onClick={() => void saveSites()}>Save sites</Button>
            </div>
          </div>
        </Modal>
      )}

      {resetting && (
        <Modal isOpen onClose={() => setResetting(null)} title={`New PIN — ${resetting.name}`} size="sm" error={modalErr} onDismissError={() => setModalErr(null)}>
          <div className="flex flex-col gap-4">
            <input inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="6 digits"
              className={`${inputCls} w-36 font-ledger tracking-widest`} />
            <p className="text-xs text-muted-foreground">Their phone is signed out straight away; they sign in again with the new PIN.</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setResetting(null)}>Cancel</Button>
              <Button size="sm" disabled={busy === "pin"} onClick={() => void resetPin()}>Set PIN</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
