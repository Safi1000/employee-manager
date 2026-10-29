import { useCallback, useEffect, useState } from "react";
import { Loader2, Mail, ShieldAlert } from "lucide-react";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";
import { deviceLabel } from "./UserSecurityModal";

/**
 * This week's security (0596): the same answer security_digest() gives the
 * Monday email, on demand. "Worth a look" first — gaps, red checks, a week with
 * no good backup, more than 20 files downloaded by one person, logins between
 * midnight and 5am, new devices, keys granted — then the counts behind it.
 */

type Digest = {
  logins: { name: string; logins: number; new_devices: number; odd_hours: number }[];
  new_devices: { name: string; device: string | null; ip: string | null; at: string }[];
  two_factor: { name: string; required_from: string }[];
  disabled: { name: string; reason: string | null; at: string }[];
  exports: { by_person: { name: string; files: number }[] };
  permissions: { name: string | null; added: string[]; removed: string[] }[];
  backups: { ok: boolean | null }[];
  red_checks: { check: string }[];
  gaps: { kind: string; object: string }[];
};

const EXPORT_SPIKE = 20;

function attention(d: Digest): string[] {
  const out: string[] = [];
  for (const g of d.gaps) out.push(`Security gap: ${g.kind} — ${g.object}`);
  for (const c of d.red_checks) out.push(`Check failing: ${c.check}`);
  if (!d.backups.some((b) => b.ok)) out.push(d.backups.length ? "No successful backup this week" : "No backup ran this week");
  for (const x of d.exports.by_person) if (x.files > EXPORT_SPIKE) out.push(`${x.name} downloaded ${x.files} files`);
  for (const l of d.logins) if (l.odd_hours > 0) out.push(`${l.name}: ${l.odd_hours} login(s) between midnight and 5am`);
  for (const n of d.new_devices) out.push(`${n.name} signed in on a new device (${deviceLabel(n.device)})`);
  for (const p of d.permissions) if (p.added.length) out.push(`${p.name ?? "A login"} was given ${p.added.join(", ")}`);
  return out;
}

export default function SecurityDigestCard({ companyId }: { companyId: string | null }) {
  const [d, setD] = useState<Digest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    const { data, error } = await supabase.rpc("security_digest", { p_company_id: companyId, p_days: 7 });
    if (error) { setErr(friendlyDbError(error)); return; }
    setD(data as Digest);
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  const emailMe = async () => {
    setBusy(true); setErr(null); setNote(null);
    const { data, error } = await supabase.functions.invoke("security-digest", { body: {} });
    setBusy(false);
    const res = data as { sent?: string[]; failed?: string[]; error?: string } | null;
    const msg = error?.message ?? res?.error ?? (res?.failed?.length ? res.failed.join("; ") : null);
    if (msg) setErr(msg); else setNote(`Sent to ${res?.sent?.join(", ") || "you"}.`);
  };

  const look = d ? attention(d) : [];
  const files = d ? d.exports.by_person.reduce((s, x) => s + x.files, 0) : 0;
  const logins = d ? d.logins.reduce((s, x) => s + x.logins, 0) : 0;

  return (
    <div className="mb-4 rounded-2xl border border-border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <h3 className="text-sm font-semibold text-foreground">Security this week</h3>
          {d && <span className={`text-xs ${look.length ? "text-heed" : "text-up"}`}>{look.length ? `${look.length} worth a look` : "Nothing unusual"}</span>}
        </div>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void emailMe()}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Mail className="mr-1.5 h-4 w-4" strokeWidth={1.5} />} Email me this now
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Emailed to every super admin each Monday 8am. The last seven days.</p>
      {err && <p className="mt-2 text-xs text-danger-700 dark:text-danger-500">{err}</p>}
      {note && <p className="mt-2 text-xs text-up">{note}</p>}
      {!d && !err && <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>}
      {d && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Logins", logins],
              ["New devices", d.new_devices.length],
              ["Files downloaded", files],
              ["Two-factor owed", d.two_factor.length],
            ].map(([label, n]) => (
              <div key={label as string} className="rounded-xl border border-border px-3 py-2">
                <span className="lbl">{label}</span>
                <p className="mt-0.5 font-ledger text-sm text-foreground">{n}</p>
              </div>
            ))}
          </div>
          {look.length > 0 && (
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-foreground">
              {look.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          )}
          {d.two_factor.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">Still without an authenticator: {d.two_factor.map((t) => t.name).join(", ")}.</p>
          )}
        </>
      )}
    </div>
  );
}
