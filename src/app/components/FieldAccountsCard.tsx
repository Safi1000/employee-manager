import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Check, KeyRound, Loader2, MapPin, Plus, Smartphone, UserCheck, X } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import { supabase, friendlyDbError } from "../lib/supabase";

/**
 * Field accounts (0607): site-supervisor logins for the Android field app.
 * Super admins only (Shayan, 29 Oct 2026). A supervisor signs in on ONE phone
 * with their employee code + a 6-digit PIN; a new phone waits here for
 * approval, and approving it signs the old one out of the app for good. The
 * login reaches nothing in Bastion except its own sites' rosters.
 */

type Device = { id: string; label: string | null; status: "active" | "pending"; first_seen: string; last_seen: string | null };
type Account = {
  user_id: string; name: string; employee_code: string | null;
  sites: { id: string; name: string }[]; devices: Device[];
  disabled_at: string | null; last_login: string | null;
};
type Site = { id: string; name: string; client: string | null };
type Emp = { id: string; full_name: string; employee_code: string; designation: string | null };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never";

async function invokeField(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("field-account", { body });
  let res = data as { error?: string; ok?: boolean } | null;
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") { try { res = await ctx.json(); } catch { /* not JSON */ } }
  return res?.error ?? (error ? error.message : null);
}

function SitePicker({ sites, value, onChange }: { sites: Site[]; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState("");
  const shown = sites.filter((s) => `${s.name} ${s.client ?? ""}`.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return (
    <div className="flex flex-col gap-1.5">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sites…"
        className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground" />
      <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
        {shown.map((s) => (
          <label key={s.id} className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-muted/40">
            <input type="checkbox" checked={value.includes(s.id)}
              onChange={(e) => onChange(e.target.checked ? [...value, s.id] : value.filter((v) => v !== s.id))} />
            <span className="text-foreground">{s.name}</span>
            {s.client && s.client !== s.name && <span className="text-xs text-muted-foreground">· {s.client}</span>}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{value.length} site{value.length === 1 ? "" : "s"} chosen</p>
    </div>
  );
}

export default function FieldAccountsCard() {
  const [rows, setRows] = useState<Account[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [emps, setEmps] = useState<Emp[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [resetting, setResetting] = useState<Account | null>(null);
  // create / edit form
  const [empQ, setEmpQ] = useState("");
  const [empId, setEmpId] = useState("");
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [pin, setPin] = useState("");
  const [modalErr, setModalErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("admin_field_accounts");
    if (error) { setErr(friendlyDbError(error)); return; }
    setRows((data ?? []) as Account[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void supabase.from("sites").select("id, name, client:client_id(name)").order("name").then(({ data }) =>
      setSites(((data ?? []) as unknown as { id: string; name: string; client: { name: string } | null }[])
        .map((s) => ({ id: s.id, name: s.name, client: s.client?.name ?? null }))));
  }, []);

  const loadEmps = useCallback(async () => {
    if (emps.length) return;
    const { data } = await supabase.from("employees").select("id, full_name, employee_code, designation")
      .in("status", ["Active", "On Leave"]).order("full_name");
    setEmps((data ?? []) as Emp[]);
  }, [emps.length]);

  const empMatches = useMemo(() => {
    const q = empQ.trim().toLowerCase();
    if (!q) return emps.filter((e) => /sup/i.test(e.designation ?? "")).slice(0, 8);
    return emps.filter((e) => `${e.full_name} ${e.employee_code}`.toLowerCase().includes(q)).slice(0, 8);
  }, [empQ, emps]);

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
  const saveSites = async () => {
    if (!editing) return;
    setBusy("sites"); setModalErr(null);
    const { error } = await supabase.rpc("admin_field_set_sites", { p_user_id: editing.user_id, p_sites: siteIds });
    setBusy(null);
    if (error) { setModalErr(friendlyDbError(error)); return; }
    setEditing(null); void load();
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

  const pending = rows?.reduce((n, a) => n + a.devices.filter((d) => d.status === "pending").length, 0) ?? 0;

  return (
    <div className="mb-4 rounded-2xl border border-border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <h3 className="text-sm font-semibold text-foreground">Field accounts</h3>
          {rows && <span className="text-xs text-muted-foreground">{rows.length} supervisor login{rows.length === 1 ? "" : "s"}</span>}
          {pending > 0 && <span className="rounded bg-heed/10 px-1.5 text-xs font-semibold text-heed">{pending} phone{pending === 1 ? "" : "s"} waiting</span>}
        </div>
        <Button size="sm" variant="secondary" onClick={() => { setCreating(true); setModalErr(null); setPin(""); setEmpId(""); setEmpQ(""); setSiteIds([]); void loadEmps(); }}>
          <Plus className="mr-1.5 h-4 w-4" strokeWidth={1.5} /> New field login
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Site supervisors sign in to the field app with their employee code and a PIN, on one approved phone. They see only their own sites' guards — no pay, no CNIC numbers, nothing else in Bastion.</p>
      {err && <p className="mt-2 text-xs text-danger-700 dark:text-danger-500">{err}</p>}
      {note && <p className="mt-2 text-xs text-up">{note}</p>}

      {rows === null ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No field logins yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {rows.map((a) => (
            <li key={a.user_id} className="flex flex-col gap-2 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className={`text-sm font-medium ${a.disabled_at ? "text-muted-foreground line-through" : "text-foreground"}`}>
                    {a.name} <span className="font-ledger text-xs text-muted-foreground">{a.employee_code}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <MapPin className="mr-0.5 inline h-3 w-3" />{a.sites.length ? a.sites.map((s) => s.name).join(", ") : "No sites yet"} · last sign-in {when(a.last_login)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(a); setSiteIds(a.sites.map((s) => s.id)); setModalErr(null); }}>Sites</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setResetting(a); setPin(""); setModalErr(null); }}><KeyRound className="mr-1 h-3.5 w-3.5" />PIN</Button>
                  {a.disabled_at ? (
                    <Button size="sm" variant="ghost" disabled={busy === a.user_id} onClick={() => void setDisabled(a, false)}><UserCheck className="mr-1 h-3.5 w-3.5" />Enable</Button>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={busy === a.user_id} onClick={() => void setDisabled(a, true)}><Ban className="mr-1 h-3.5 w-3.5" />Disable</Button>
                  )}
                </div>
              </div>
              {a.devices.length === 0 ? (
                <p className="text-xs text-muted-foreground">No phone yet — the first phone they sign in on becomes theirs.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {a.devices.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1 text-xs">
                      <span className="text-foreground">
                        <Smartphone className="mr-1 inline h-3 w-3" />{d.label ?? "Phone"} ·{" "}
                        <span className={d.status === "pending" ? "font-semibold text-heed" : "text-up"}>{d.status === "pending" ? "waiting for approval" : "approved"}</span>
                        <span className="text-muted-foreground"> · first seen {when(d.first_seen)}</span>
                      </span>
                      <span className="flex gap-1">
                        {d.status === "pending" && (
                          <Button size="sm" variant="secondary" disabled={busy === d.id} onClick={() => void decide(d, "active", a.name)}>
                            <Check className="mr-1 h-3.5 w-3.5" />Approve
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" disabled={busy === d.id} onClick={() => void decide(d, "revoked", a.name)}>
                          <X className="mr-1 h-3.5 w-3.5" />{d.status === "pending" ? "Refuse" : "Cut off"}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <Modal isOpen onClose={() => setCreating(false)} title="New field login" size="md" error={modalErr} onDismissError={() => setModalErr(null)}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="lbl">Supervisor</span>
              <input value={empQ} onChange={(e) => { setEmpQ(e.target.value); setEmpId(""); }} placeholder="Search by name or code…"
                className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground" />
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
              <SitePicker sites={sites} value={siteIds} onChange={setSiteIds} />
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="lbl">6-digit PIN</span>
              <input inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                className="w-36 rounded-lg border border-border bg-card px-2.5 py-1.5 font-ledger text-sm tracking-widest text-foreground" />
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
        <Modal isOpen onClose={() => setEditing(null)} title={`Sites — ${editing.name}`} size="md" error={modalErr} onDismissError={() => setModalErr(null)}>
          <div className="flex flex-col gap-4">
            <SitePicker sites={sites} value={siteIds} onChange={setSiteIds} />
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
              className="w-36 rounded-lg border border-border bg-card px-2.5 py-1.5 font-ledger text-sm tracking-widest text-foreground" />
            <p className="text-xs text-muted-foreground">Their phone is signed out straight away; they sign in again with the new PIN.</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setResetting(null)}>Cancel</Button>
              <Button size="sm" disabled={busy === "pin"} onClick={() => void resetPin()}>Set PIN</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
