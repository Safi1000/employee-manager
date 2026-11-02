import { useEffect, useState } from "react";
import { ExternalLink, FileText, Loader2 } from "lucide-react";
import { supabase, friendlyDbError } from "../lib/supabase";
import { REPORTS_BUCKET, type ReportKind } from "../lib/reportArchive";
import { openRemoteFile } from "../lib/saveFile";

/**
 * The last report of a kind as it was SENT (0633): the kept PDF itself, shown
 * on the page, with when and who; the earlier ones listed beneath to open.
 */
type Row = { id: string; report_kind: string; report_date: string; region_label: string | null; file_path: string; file_name: string; exported_at: string; exported_by_name: string | null };
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function KeptReport({ kinds, title }: { kinds: ReportKind[]; title: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [picked, setPicked] = useState<Row | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setRows(null); setPicked(null); setErr(null);
    void supabase.rpc("report_exports_list", { p_kinds: kinds, p_limit: 30 }).then(({ data, error }) => {
      if (error) { setErr(friendlyDbError(error)); setRows([]); return; }
      const r = (data ?? []) as Row[];
      setRows(r); setPicked(r[0] ?? null);
    });
  }, [kinds.join(",")]);

  useEffect(() => {
    setUrl(null);
    if (!picked) return;
    void supabase.storage.from(REPORTS_BUCKET).createSignedUrl(picked.file_path, 3600).then(({ data }) => setUrl(data?.signedUrl ?? null));
  }, [picked]);

  if (err) return <div className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{err}</div>;
  if (!rows) return <div className="text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>;
  if (!rows.length) return (
    <div className="border border-dashed border-border rounded-xl px-4 py-10 text-center text-sm text-muted-foreground">
      No {title.toLowerCase()} has been sent since reports started being kept. The next one exported will appear here.
    </div>
  );

  return (
    <div className="space-y-3">
      {picked && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="font-semibold text-foreground">{title}{picked.region_label ? ` · ${picked.region_label}` : ""}</h3>
          <span className="text-sm text-muted-foreground">sent {when(picked.exported_at)}{picked.exported_by_name ? ` by ${picked.exported_by_name}` : ""}{picked === rows[0] ? " · the latest" : ""}</span>
          {url && <button type="button" onClick={() => void openRemoteFile(url)} className="ml-auto inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-500 hover:underline"><ExternalLink className="w-4 h-4" />Open</button>}
        </div>
      )}
      <div className="border border-border rounded-xl bg-muted overflow-hidden">
        {url ? <iframe key={url} src={`${url}#view=FitH`} title={picked?.file_name} className="w-full h-[75vh] bg-card" />
          : <div className="h-[40vh] flex items-center justify-center text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin mr-2" />Opening the report…</div>}
      </div>
      {rows.length > 1 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1.5">Earlier</p>
          <div className="flex flex-wrap gap-2">
            {rows.map((r) => (
              <button key={r.id} type="button" onClick={() => setPicked(r)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs ${picked?.id === r.id ? "bg-foreground text-background border-foreground" : "bg-card border-border text-foreground hover:bg-muted"}`}>
                <FileText className="w-3.5 h-3.5" />{when(r.exported_at)}{r.region_label ? ` · ${r.region_label}` : ""}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
