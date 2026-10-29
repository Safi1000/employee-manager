import { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import Button from "./Button";
import { supabase } from "../lib/supabase";

/**
 * Drive files that are still "anyone with the link" (2026-10-29). Uploads
 * before that date were shared publicly; gdrive-file's make_private removes
 * that permission from every file the company holds. "Check" only counts;
 * "Make private" acts. Files open through Bastion either way.
 */

type Result = { files: number; public: number; made_private: number; missing_in_drive: number; failed: number; dry: boolean };

export default function DrivePrivacyCard() {
  const [busy, setBusy] = useState<"check" | "fix" | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (dry: boolean) => {
    if (!dry && !window.confirm(`Remove "anyone with the link" from ${res?.public ?? "every"} public Drive file(s)? They will open only through Bastion.`)) return;
    setBusy(dry ? "check" : "fix"); setErr(null);
    const { data, error } = await supabase.functions.invoke("gdrive-file", { body: { action: "make_private", dry } });
    setBusy(null);
    if (error) { setErr(error.message); return; }
    if ((data as { error?: string })?.error) { setErr((data as { error: string }).error); return; }
    setRes(data as Result);
  };

  return (
    <div className="mb-4 rounded-2xl border border-border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <h3 className="text-sm font-semibold text-foreground">Drive files</h3>
          <span className="text-xs text-muted-foreground">Files uploaded before 29 Oct were shared "anyone with the link".</span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(true)}>
            {busy === "check" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null} Check public files
          </Button>
          <Button size="sm" variant="danger" disabled={busy !== null || !res || res.public === 0} onClick={() => void run(false)}>
            {busy === "fix" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null} Make private
          </Button>
        </div>
      </div>
      {err && <p className="mt-2 text-xs text-danger-700 dark:text-danger-500">{err}</p>}
      {res && (
        <p className="mt-2 text-xs text-foreground">
          {res.files} file(s) on record ·{" "}
          {res.dry
            ? <span className={res.public ? "font-semibold text-heed" : "text-up"}>{res.public} still public</span>
            : <span className="font-semibold text-up">{res.made_private} made private</span>}
          {res.missing_in_drive > 0 && <span className="text-muted-foreground"> · {res.missing_in_drive} no longer in Drive</span>}
          {res.failed > 0 && <span className="text-down"> · {res.failed} could not be read or changed</span>}
        </p>
      )}
    </div>
  );
}
