import { useEffect, useState } from "react";
import { Ban, Loader2, LogOut, ShieldCheck, ShieldOff, UserCheck } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";

/**
 * One login's security, for Access & Governance (0591): two-factor state, the
 * last 50 logins with device and address, and the three actions — sign out
 * everywhere, disable / enable, reset two-factor (a lost phone). Each action is
 * a users.manage RPC that refuses oneself and the super-super-admin.
 */

export type UserSecurity = {
  user_id: string;
  two_factor: boolean;
  mfa_required_from: string | null;
  last_login: string | null;
  last_ip: string | null;
  last_device: string | null;
  disabled_at: string | null;
  disabled_reason: string | null;
};

type LoginEvent = { id: string; logged_in_at: string; ip: string | null; user_agent: string | null; new_device: boolean };
type ExportRow = { id: string; exported_at: string; file_name: string; screen: string | null };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

/** "Chrome on macOS" from a user agent — enough to recognise a device, not to fingerprint it. */
export function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export default function UserSecurityModal({
  user, security, onClose, onChanged,
}: {
  user: { id: string; full_name: string | null; email: string | null };
  security: UserSecurity | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [events, setEvents] = useState<LoginEvent[] | null>(null);
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void supabase.from("login_events").select("id, logged_in_at, ip, user_agent, new_device")
      .eq("user_id", user.id).order("logged_in_at", { ascending: false }).limit(50)
      .then(({ data }) => setEvents((data ?? []) as LoginEvent[]));
    // 0595: files this login downloaded.
    void supabase.from("export_log").select("id, exported_at, file_name, screen")
      .eq("user_id", user.id).order("exported_at", { ascending: false }).limit(20)
      .then(({ data }) => setExports((data ?? []) as ExportRow[]));
  }, [user.id]);

  const run = async (key: string, fn: () => PromiseLike<{ error: unknown }>, done: string) => {
    setBusy(key); setErr(null); setNote(null);
    const { error } = await fn();
    setBusy(null);
    if (error) { setErr(friendlyDbError(error as never)); return; }
    setNote(done);
    onChanged();
  };

  const name = user.full_name ?? user.email ?? "this user";
  const disabled = !!security?.disabled_at;

  return (
    <Modal isOpen onClose={onClose} title={`Security — ${name}`} size="lg" error={err} onDismissError={() => setErr(null)}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div className="rounded-xl border border-border px-3 py-2.5">
            <span className="lbl">Two-factor</span>
            <p className={`mt-1 text-sm font-semibold ${security?.two_factor ? "text-up" : "text-heed"}`}>
              {security?.two_factor ? "On" : "Not set up"}
            </p>
            {!security?.two_factor && security?.mfa_required_from && (
              <p className="text-xs text-muted-foreground">Compulsory from {when(security.mfa_required_from)}</p>
            )}
          </div>
          <div className="rounded-xl border border-border px-3 py-2.5">
            <span className="lbl">Last login</span>
            <p className="mt-1 text-sm text-foreground">{when(security?.last_login ?? null)}</p>
            <p className="text-xs text-muted-foreground">{deviceLabel(security?.last_device ?? null)}{security?.last_ip ? ` · ${security.last_ip}` : ""}</p>
          </div>
          <div className="rounded-xl border border-border px-3 py-2.5">
            <span className="lbl">Status</span>
            <p className={`mt-1 text-sm font-semibold ${disabled ? "text-down" : "text-up"}`}>{disabled ? "Disabled" : "Active"}</p>
            {disabled && <p className="text-xs text-muted-foreground">{security?.disabled_reason} · {when(security?.disabled_at ?? null)}</p>}
          </div>
        </div>

        {note && <p className="text-sm text-up">{note}</p>}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={busy !== null}
            onClick={() => {
              if (!window.confirm(`Sign ${name} out on every device now?`)) return;
              void run("out", () => supabase.rpc("end_user_sessions", { p_user_id: user.id }), "Signed out everywhere.");
            }}>
            {busy === "out" ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <LogOut className="w-4 h-4 mr-1.5" strokeWidth={1.5} />}
            Sign out everywhere
          </Button>
          {disabled ? (
            <Button variant="secondary" size="sm" disabled={busy !== null}
              onClick={() => void run("on", () => supabase.rpc("set_user_disabled", { p_user_id: user.id, p_disabled: false }), "Login enabled again.")}>
              <UserCheck className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Enable login
            </Button>
          ) : (
            <Button variant="danger" size="sm" disabled={busy !== null}
              onClick={() => {
                const reason = window.prompt(`Why is ${name}'s login being disabled?`);
                if (!reason?.trim()) return;
                void run("off", () => supabase.rpc("set_user_disabled", { p_user_id: user.id, p_disabled: true, p_reason: reason.trim() }), "Login disabled and signed out everywhere.");
              }}>
              <Ban className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Disable login
            </Button>
          )}
          <Button variant="secondary" size="sm" disabled={busy !== null || !security?.two_factor}
            title={security?.two_factor ? undefined : "No authenticator is set up yet"}
            onClick={() => {
              if (!window.confirm(`Remove ${name}'s authenticator? They will be signed out and must set up a new one at their next login.`)) return;
              void run("mfa", () => supabase.rpc("reset_user_mfa", { p_user_id: user.id }), "Two-factor reset — they set it up again at next login.");
            }}>
            <ShieldOff className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Reset two-factor
          </Button>
        </div>

        <div>
          <h4 className="lbl mb-2 flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.5} /> Recent logins</h4>
          {events === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          ) : events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No logins on record.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-2.5 py-1.5 font-medium">When</th>
                    <th className="text-left px-2.5 py-1.5 font-medium">Device</th>
                    <th className="text-left px-2.5 py-1.5 font-medium">Address</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td className="px-2.5 py-1.5 whitespace-nowrap text-muted-foreground">{when(e.logged_in_at)}</td>
                      <td className="px-2.5 py-1.5 text-foreground">
                        {deviceLabel(e.user_agent)}
                        {e.new_device && <span className="ml-1.5 rounded bg-heed/10 px-1 text-[10px] font-semibold text-heed">NEW</span>}
                      </td>
                      <td className="px-2.5 py-1.5 font-ledger text-muted-foreground">{e.ip ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {exports.length > 0 && (
          <div>
            <h4 className="lbl mb-2">Recent exports</h4>
            <ul className="max-h-48 overflow-y-auto divide-y divide-border rounded-lg border border-border text-xs">
              {exports.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-3 px-2.5 py-1.5">
                  <span className="truncate text-foreground" title={x.file_name}>{x.file_name}</span>
                  <span className="shrink-0 text-muted-foreground">{when(x.exported_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
