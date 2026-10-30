import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, Check, Loader2, MapPin, Plus, X } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import { supabase, friendlyDbError } from "../lib/supabase";

/**
 * The field app's records, for Operations ▸ Field Supervisors (30 Oct 2026):
 *
 *   SiteLocations   each site's point and area (0614). Shayan supplies them: a
 *                   point pasted from Google Maps and a rough area ("Emaar about
 *                   50 km, Nova ISB one building"). A site with none is simply
 *                   not compared — the phone still records where it was.
 *   VisitsPanel     visits from the app (0615) with their checklist and photos.
 *   SiteTasksPanel  tasks set on a site for the field app (0619), and what the
 *                   site said back.
 *
 * Photos are read from field_photos (office logins only; never a supervisor).
 */

type SiteRow = { id: string; name: string; location: string | null; geo_lat: number | null; geo_lng: number | null; geo_radius_m: number | null; clients: { name: string } | null };
type Photo = { id: string; data: string; taken_by_name: string; created_at: string };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const inputCls = "rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground";

/** "33.6844, 73.0479", a Google Maps link with @lat,lng or ?q=lat,lng, or "!3d…!4d…". */
export function parsePoint(s: string): { lat: number; lng: number } | null {
  const t = s.trim();
  const m = t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ?? t.match(/[?&](?:q|query|ll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/)
    ?? t.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ?? t.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

export function SiteLocations({ regionClientNames }: { regionClientNames?: Set<string> | null }) {
  const [rows, setRows] = useState<SiteRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<SiteRow | null>(null);
  const [point, setPoint] = useState("");
  const [km, setKm] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("sites").select("id, name, location, geo_lat, geo_lng, geo_radius_m, clients(name)").order("name");
    if (error) setErr(friendlyDbError(error)); else setRows((data ?? []) as unknown as SiteRow[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (rows ?? [])
      .filter((r) => !regionClientNames || regionClientNames.has(r.clients?.name ?? ""))
      .filter((r) => !term || `${r.clients?.name ?? ""} ${r.name} ${r.location ?? ""}`.toLowerCase().includes(term))
      .sort((a, b) => (a.clients?.name ?? "").localeCompare(b.clients?.name ?? "") || a.name.localeCompare(b.name));
  }, [rows, q, regionClientNames]);
  const set = (rows ?? []).filter((r) => r.geo_lat !== null).length;

  const open = (r: SiteRow) => {
    setEdit(r); setErr(null);
    setPoint(r.geo_lat !== null ? `${r.geo_lat}, ${r.geo_lng}` : "");
    setKm(r.geo_radius_m !== null ? String(r.geo_radius_m / 1000) : "");
  };
  const save = async (clear = false) => {
    if (!edit) return;
    const p = clear ? null : parsePoint(point);
    const radius = clear ? null : Math.round(Number(km) * 1000);
    if (!clear && (!p || !Number.isFinite(radius) || !radius)) { setErr("Paste the point from Google Maps (or type “latitude, longitude”) and give the area in km."); return; }
    setBusy(true);
    const { error } = await supabase.rpc("admin_set_site_location", { p_site_id: edit.id, p_lat: p?.lat ?? null, p_lng: p?.lng ?? null, p_radius_m: radius });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setEdit(null); void load();
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Where each site is, and roughly how far it stretches. The phone records where it was when attendance, a visit, an incident or a report is sent, and the office sees “outside the site’s area” when it was further than this. It never stops anyone sending. {rows ? `${set} of ${rows.length} sites have a location.` : ""}
      </p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client or site…" className={`${inputCls} sm:w-72`} />
      {err && !edit && <p className="text-sm text-down">{err}</p>}
      {rows === null ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div> : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {shown.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
              <span className="text-foreground">{r.clients?.name}{r.name !== r.clients?.name && <span className="text-muted-foreground"> · {r.name}</span>}</span>
              <span className="flex items-center gap-3">
                {r.geo_lat !== null ? (
                  <a className="text-xs text-muted-foreground hover:text-foreground" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${r.geo_lat},${r.geo_lng}`}>
                    <MapPin className="mr-0.5 inline h-3 w-3" />{r.geo_lat}, {r.geo_lng} · {(r.geo_radius_m ?? 0) / 1000} km
                  </a>
                ) : <span className="text-xs text-heed">no location</span>}
                <Button size="sm" variant="ghost" onClick={() => open(r)}>{r.geo_lat !== null ? "Change" : "Set"}</Button>
              </span>
            </div>
          ))}
        </div>
      )}
      {edit && (
        <Modal isOpen onClose={() => setEdit(null)} title={`Location · ${edit.clients?.name ?? ""} · ${edit.name}`} size="sm" error={err} onDismissError={() => setErr(null)}>
          <div className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Point — paste a Google Maps link, or “latitude, longitude”</span>
              <input className={inputCls} value={point} onChange={(e) => setPoint(e.target.value)} placeholder="33.6844, 73.0479" autoFocus />
              {point && <span className="text-xs text-muted-foreground">{parsePoint(point) ? `Reads as ${parsePoint(point)!.lat}, ${parsePoint(point)!.lng}` : "Can't read a point from that yet."}</span>}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Area — how far the site stretches from that point, in km</span>
              <input className={inputCls} value={km} onChange={(e) => setKm(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.2 for one building, 50 for Emaar" inputMode="decimal" />
            </label>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void save()}><Check className="mr-1 h-3.5 w-3.5" />Save</Button>
              {edit.geo_lat !== null && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(true)}>Clear</Button>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Photos({ refTable, refId }: { refTable: string; refId: string }) {
  const [rows, setRows] = useState<Photo[] | null>(null);
  const [big, setBig] = useState<string | null>(null);
  useEffect(() => {
    void supabase.from("field_photos").select("id, data, taken_by_name, created_at").eq("ref_table", refTable).eq("ref_id", refId).order("created_at")
      .then(({ data }) => setRows((data ?? []) as Photo[]));
  }, [refTable, refId]);
  if (!rows?.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {rows.map((p) => (
        <button key={p.id} type="button" onClick={() => setBig(p.data)} className="overflow-hidden rounded-md border border-border">
          <img src={p.data} alt={`Photo by ${p.taken_by_name}`} className="h-20 w-20 object-cover" />
        </button>
      ))}
      {big && (
        <Modal isOpen onClose={() => setBig(null)} title="Photo" size="lg">
          <img src={big} alt="" className="max-h-[75vh] w-full rounded-md object-contain" />
        </Modal>
      )}
    </div>
  );
}

type Visit = {
  id: string; completed_at: string; visitor_name: string; visitor_kind: string; guards_checked: number; issues: number;
  findings: string | null; corrective_actions: string | null; geo: { inside?: boolean | null; distance_m?: number | null } | null;
  checklist: { guards: { full_name: string; checks: Record<string, boolean | null>; note: string | null }[]; site: Record<string, boolean | null> } | null;
  sites: { name: string; clients: { name: string } | null } | null;
};
const POINT_WORD: Record<string, string> = {
  present: "present", alert: "awake/alert", uniform: "uniform", id_card: "ID card", weapon: "weapon & licence", ammunition: "ammunition",
  right_post: "right post", duty_register: "duty register",
};

export function VisitsPanel({ siteIds }: { siteIds?: Set<string> | null }) {
  const [rows, setRows] = useState<Visit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Visit | null>(null);
  useEffect(() => {
    void supabase.from("supervisor_visits")
      .select("id, site_id, completed_at, visitor_name, visitor_kind, guards_checked, issues, findings, corrective_actions, geo, checklist, sites(name, clients(name))")
      .eq("source", "app").order("completed_at", { ascending: false }).limit(200)
      .then(({ data, error }) => {
        if (error) setErr(friendlyDbError(error));
        else setRows(((data ?? []) as unknown as (Visit & { site_id: string })[]).filter((v) => !siteIds || siteIds.has(v.site_id)));
      });
  }, [siteIds]);
  if (err) return <p className="text-sm text-down">{err}</p>;
  if (rows === null) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
  if (!rows.length) return <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">No visits from the field app yet.</div>;
  return (
    <>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {rows.map((v) => (
          <button key={v.id} type="button" onClick={() => setOpen(v)} className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-2 text-left text-sm hover:bg-muted/40">
            <span className="text-foreground">{v.sites?.clients?.name}{v.sites && v.sites.name !== v.sites.clients?.name && <span className="text-muted-foreground"> · {v.sites.name}</span>}
              <span className="text-xs text-muted-foreground"> · {when(v.completed_at)} · {v.visitor_name}{v.visitor_kind === "office" ? " (office)" : ""}</span></span>
            <span className="flex items-center gap-2 text-xs">
              {v.geo?.inside === false && <span className="text-heed"><MapPin className="mr-0.5 inline h-3 w-3" />outside area</span>}
              <span className={v.issues ? "font-medium text-down" : "text-up"}>{v.issues ? `${v.issues} wrong` : "all fine"}</span>
              <span className="text-muted-foreground">{v.guards_checked} checked</span>
            </span>
          </button>
        ))}
      </div>
      {open && (
        <Modal isOpen onClose={() => setOpen(null)} title={`Visit · ${open.sites?.name ?? ""} · ${when(open.completed_at)}`} size="lg">
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">By {open.visitor_name}{open.visitor_kind === "office" ? " (office)" : ""}{open.geo?.distance_m != null ? ` · phone ${Math.round(open.geo.distance_m / 100) / 10} km from the site's point` : ""}</p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {(open.checklist?.guards ?? []).map((g, i) => {
                const wrong = Object.entries(g.checks).filter(([, v]) => v === false).map(([k]) => POINT_WORD[k] ?? k);
                return (
                  <li key={i} className="px-3 py-1.5">
                    <span className="text-foreground">{g.full_name}</span>{" "}
                    {wrong.length ? <span className="text-down">— no {wrong.join(", ")}</span> : <span className="text-up">— all fine</span>}
                    {g.note && <span className="text-muted-foreground"> · {g.note}</span>}
                  </li>
                );
              })}
              {Object.entries(open.checklist?.site ?? {}).map(([k, v]) => (
                <li key={k} className="px-3 py-1.5"><span className="text-foreground">Site: {POINT_WORD[k] ?? k}</span> {v === false ? <span className="text-down">— no</span> : v ? <span className="text-up">— yes</span> : <span className="text-muted-foreground">— n/a</span>}</li>
              ))}
            </ul>
            {open.findings && <p><span className="text-muted-foreground">Found:</span> {open.findings}</p>}
            {open.corrective_actions && <p><span className="text-muted-foreground">Done about it:</span> {open.corrective_actions}</p>}
            <Photos refTable="supervisor_visits" refId={open.id} />
          </div>
        </Modal>
      )}
    </>
  );
}

type Task = {
  id: string; site_id: string; title: string; details: string | null; due_date: string | null; status: "open" | "done" | "couldnt" | "cancelled";
  created_by_name: string | null; created_at: string; done_by_name: string | null; done_at: string | null; done_note: string | null;
};

export function SiteTasksPanel({ sites }: { sites: { site_id: string; site_name: string; client_name: string }[] }) {
  const [rows, setRows] = useState<Task[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [siteId, setSiteId] = useState("");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [photosFor, setPhotosFor] = useState<string | null>(null);
  const siteName = useMemo(() => new Map(sites.map((s) => [s.site_id, s.client_name === s.site_name ? s.site_name : `${s.client_name} · ${s.site_name}`])), [sites]);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("site_tasks").select("*").neq("status", "cancelled").order("created_at", { ascending: false }).limit(300);
    if (error) setErr(friendlyDbError(error)); else setRows(((data ?? []) as Task[]).filter((t) => siteName.has(t.site_id)));
  }, [siteName]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("admin_site_task_add", { p_site_id: siteId, p_title: title, p_details: details || null, p_due: due || null });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setAdding(false); setTitle(""); setDetails(""); setDue(""); void load();
  };
  const cancel = async (t: Task) => {
    if (!window.confirm(`Cancel “${t.title}”? It disappears from the site's phone.`)) return;
    const { error } = await supabase.rpc("admin_site_task_cancel", { p_task_id: t.id });
    if (error) setErr(friendlyDbError(error)); else void load();
  };

  const sorted = [...sites].sort((a, b) => (siteName.get(a.site_id) ?? "").localeCompare(siteName.get(b.site_id) ?? ""));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Set a task on a site; whoever covers it on the field app marks it done, or couldn't — with a note, which alerts you.</p>
        <Button size="sm" onClick={() => { setAdding(true); setErr(null); }}><Plus className="mr-1 h-3.5 w-3.5" />New task</Button>
      </div>
      {err && !adding && <p className="text-sm text-down">{err}</p>}
      {rows === null ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        : rows.length === 0 ? <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">No site tasks yet.</div> : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {rows.map((t) => (
            <div key={t.id} className="flex flex-col gap-1 px-4 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-foreground">{t.title} <span className="text-xs text-muted-foreground">· {siteName.get(t.site_id)}{t.due_date ? ` · due ${t.due_date}` : ""}</span></span>
                <span className="flex items-center gap-2 text-xs">
                  <span className={t.status === "open" ? "text-heed" : t.status === "done" ? "text-up" : "text-down"}>{t.status === "open" ? "open" : t.status === "done" ? "done" : "couldn't"}</span>
                  {t.status !== "open" && <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setPhotosFor(photosFor === t.id ? null : t.id)}><Camera className="inline h-3.5 w-3.5" /></button>}
                  {t.status === "open" && <Button size="sm" variant="ghost" onClick={() => void cancel(t)}><X className="mr-1 h-3.5 w-3.5" />Cancel</Button>}
                </span>
              </div>
              {t.details && <span className="text-xs text-muted-foreground">{t.details}</span>}
              {t.done_by_name && <span className="text-xs text-muted-foreground">{t.done_by_name}, {t.done_at ? when(t.done_at) : ""}{t.done_note ? ` — ${t.done_note}` : ""}</span>}
              {photosFor === t.id && <Photos refTable="site_tasks" refId={t.id} />}
            </div>
          ))}
        </div>
      )}
      {adding && (
        <Modal isOpen onClose={() => setAdding(false)} title="New site task" size="sm" error={err} onDismissError={() => setErr(null)}>
          <div className="flex flex-col gap-3 text-sm">
            <select className={inputCls} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">Choose the site…</option>
              {sorted.map((s) => <option key={s.site_id} value={s.site_id}>{siteName.get(s.site_id)}</option>)}
            </select>
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing" />
            <textarea className={inputCls} rows={3} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Details (optional)" />
            <label className="flex items-center gap-2 text-muted-foreground">Due <input type="date" className={inputCls} value={due} onChange={(e) => setDue(e.target.value)} /></label>
            <Button size="sm" disabled={busy || !siteId || !title.trim()} onClick={() => void add()}><Check className="mr-1 h-3.5 w-3.5" />Set task</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export { Photos as FieldPhotos };
