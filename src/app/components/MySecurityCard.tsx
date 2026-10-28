import { useEffect, useState } from "react";
import { LogOut, ShieldCheck } from "lucide-react";
import Button from "./Button";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { deviceLabel } from "./UserSecurityModal";

/**
 * My own login security (0591), on My Profile: is two-factor on, my last ten
 * logins (a device I do not recognise is the thing to notice), and "sign out my
 * other devices" — every session but this one.
 */

type Status = { mfa_required_from: string | null; factors: number };
type LoginEvent = { id: string; logged_in_at: string; ip: string | null; user_agent: string | null; new_device: boolean };

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function MySecurityCard() {
  const { profile } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!profile?.id) return;
    void supabase.rpc("my_session_status").then(({ data }) => setStatus((data ?? null) as Status | null));
    void supabase.from("login_events").select("id, logged_in_at, ip, user_agent, new_device")
      .eq("user_id", profile.id).order("logged_in_at", { ascending: false }).limit(10)
      .then(({ data }) => setEvents((data ?? []) as LoginEvent[]));
  }, [profile?.id]);

  const signOutOthers = async () => {
    if (!window.confirm("Sign out of Bastion on every other device? This one stays signed in.")) return;
    const { error } = await supabase.auth.signOut({ scope: "others" });
    setMsg(error ? error.message : "Signed out on every other device.");
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <h3 className="text-sm font-semibold text-foreground">Login security</h3>
          {status && (
            <span className={`text-xs ${status.factors > 0 ? "text-up" : "text-heed"}`}>
              {status.factors > 0
                ? "Two-factor on"
                : status.mfa_required_from
                  ? `Two-factor compulsory from ${new Date(status.mfa_required_from).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
                  : "Two-factor not set up"}
            </span>
          )}
        </div>
        <Button size="sm" variant="secondary" onClick={() => void signOutOthers()}>
          <LogOut className="mr-1.5 h-4 w-4" strokeWidth={1.5} /> Sign out other devices
        </Button>
      </div>
      {msg && <p className="mt-2 text-xs text-muted-foreground">{msg}</p>}
      {events.length > 0 && (
        <ul className="mt-3 divide-y divide-border text-xs">
          {events.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="text-foreground">
                {deviceLabel(e.user_agent)}
                {e.new_device && <span className="ml-1.5 rounded bg-heed/10 px-1 text-[10px] font-semibold text-heed">NEW</span>}
              </span>
              <span className="font-ledger text-muted-foreground">{e.ip ?? "—"} · {when(e.logged_in_at)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">A device you don't recognise? Change your password and tell your administrator.</p>
    </div>
  );
}
