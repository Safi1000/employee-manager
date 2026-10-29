import { useCallback, useEffect, useState } from "react";
import { DatabaseBackup, Loader2 } from "lucide-react";
import Button from "./Button";
import { supabase } from "../lib/supabase";

/**
 * The weekly encrypted backup (0594): its last runs and "Back up now". Every
 * Sunday 02:00 a copy of every table leaves Supabase, encrypted with a key only
 * the owner holds, into a private "Bastion Backups" Drive folder (eight weeks kept).
 */

type Run = { id: string; started_at: string; finished_at: string | null; ok: boolean | null; tables: number | null; rows_exported: number | null; bytes: number | null; error: string | null };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const size = (b: number | null) => (b == null ? "" : b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

export default function BackupCard() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.from("backup_runs").select("id, started_at, finished_at, ok, tables, rows_exported, bytes, error")
      .order("started_at", { ascending: false }).limit(5);
    setRuns((data ?? []) as Run[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const backUpNow = async () => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.functions.invoke("backup-export", { body: {} });
    setBusy(false);
    const msg = error?.message ?? (data as { error?: string } | null)?.error;
    if (msg) setErr(msg);
    void load();
  };

  const last = runs[0];
  return (
    <div className="mb-4 rounded-2xl border border-border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <DatabaseBackup className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <h3 className="text-sm font-semibold text-foreground">Backups</h3>
          <span className={`text-xs ${!last ? "text-heed" : last.ok ? "text-up" : last.ok === false ? "text-down" : "text-muted-foreground"}`}>
            {!last ? "No backup yet" : last.ok ? `Last backup ${when(last.started_at)}` : last.ok === false ? `Last backup failed ${when(last.started_at)}` : `Running since ${when(last.started_at)}`}
          </span>
        </div>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void backUpNow()}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null} Back up now
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Every Sunday 2am, encrypted with your key, to the private "Bastion Backups" folder in Drive. Eight weeks kept.</p>
      {err && <p className="mt-2 text-xs text-danger-700 dark:text-danger-500">{err}</p>}
      {runs.length > 0 && (
        <ul className="mt-2 divide-y divide-border text-xs">
          {runs.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="text-foreground">{when(r.started_at)}</span>
              <span className={r.ok ? "text-muted-foreground" : r.ok === false ? "text-down" : "text-muted-foreground"}>
                {r.ok ? `${r.tables} tables · ${r.rows_exported?.toLocaleString()} rows · ${size(r.bytes)}` : r.ok === false ? (r.error ?? "failed") : "running…"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
