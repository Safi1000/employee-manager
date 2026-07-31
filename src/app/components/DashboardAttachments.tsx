import { useEffect, useRef, useState } from "react";
import {
  Paperclip, Upload, Link2, FileText, Image as ImageIcon, Trash2, X,
  Loader2, ExternalLink, File as FileIcon,
} from "lucide-react";
import Button from "./Button";
import { useAuth } from "../lib/auth";
import { supabase, DASHBOARD_ATTACHMENTS_BUCKET } from "../lib/supabase";

// Company-wide scratch board on the Dashboard: upload files / images or pin
// links. Everything is scoped to the company (RLS) and shared across its users.
// Purely a saved reference area — never part of any export.

type Attachment = {
  id: string;
  kind: "file" | "image" | "link";
  title: string | null;
  url: string | null;
  file_name: string | null;
  storage_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  created_by: string | null;
  created_at: string;
};

const fmtBytes = (n?: number | null): string => {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const hostOf = (u?: string | null): string => {
  if (!u) return "";
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

const publicUrl = (path: string): string =>
  /^(https?:|data:)/.test(path)
    ? path
    : supabase.storage.from(DASHBOARD_ATTACHMENTS_BUCKET).getPublicUrl(path).data.publicUrl;

export default function DashboardAttachments() {
  const { company, profile } = useAuth();
  const companyId = company?.id ?? "";
  const isAdmin = profile?.role === "super_admin" || profile?.role === "super_super_admin";

  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [notReady, setNotReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [savingLink, setSavingLink] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    const { data, error: e } = await supabase
      .from("dashboard_attachments")
      .select("*")
      .order("created_at", { ascending: false });
    if (e) {
      // Migration not applied yet → degrade to a friendly note rather than crash.
      if (/does not exist|relation|schema cache|not find the table/i.test(e.message)) setNotReady(true);
      else setError(e.message);
    } else {
      setItems((data ?? []) as Attachment[]);
      setNotReady(false);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (companyId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length || !companyId) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of list) {
        const ext = f.name.includes(".") ? `.${f.name.split(".").pop()}` : "";
        const path = `${companyId}/${crypto.randomUUID()}${ext}`;
        const { error: upErr } = await supabase.storage
          .from(DASHBOARD_ATTACHMENTS_BUCKET)
          .upload(path, f, { upsert: false, contentType: f.type || undefined });
        if (upErr) throw upErr;
        const kind: Attachment["kind"] = (f.type || "").startsWith("image/") ? "image" : "file";
        const { error: insErr } = await supabase.from("dashboard_attachments").insert({
          company_id: companyId,
          kind,
          title: f.name,
          file_name: f.name,
          storage_path: path,
          mime_type: f.type || null,
          size_bytes: f.size,
          created_by: profile?.id ?? null,
        });
        if (insErr) throw insErr;
      }
      await load();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const addLink = async () => {
    let u = linkUrl.trim();
    if (!u || !companyId) return;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    setSavingLink(true);
    setError(null);
    const { error: e } = await supabase.from("dashboard_attachments").insert({
      company_id: companyId,
      kind: "link",
      url: u,
      title: linkTitle.trim() || null,
      created_by: profile?.id ?? null,
    });
    setSavingLink(false);
    if (e) {
      setError(e.message);
      return;
    }
    setLinkUrl("");
    setLinkTitle("");
    setShowLink(false);
    await load();
  };

  const remove = async (a: Attachment) => {
    if (!confirm("Remove this item?")) return;
    if (a.storage_path) {
      await supabase.storage.from(DASHBOARD_ATTACHMENTS_BUCKET).remove([a.storage_path]);
    }
    const { error: e } = await supabase.from("dashboard_attachments").delete().eq("id", a.id);
    if (e) {
      setError(e.message);
      return;
    }
    setItems((prev) => prev.filter((x) => x.id !== a.id));
  };

  const open = (a: Attachment) => {
    const href = a.kind === "link" ? a.url : a.storage_path ? publicUrl(a.storage_path) : null;
    if (href) window.open(href, "_blank", "noopener");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 mb-6 md:mb-8">
      <div className="p-6 border-b border-slate-200 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-base text-slate-900 flex items-center gap-2">
            <Paperclip className="w-4 h-4 text-brand-600" strokeWidth={1.5} />
            Files &amp; Links
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Shared with everyone in {company?.name ?? "your company"} · not included in exports
          </p>
        </div>
        {!notReady && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowLink((v) => !v)}>
              <Link2 className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Add link
            </Button>
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
              )}
              {uploading ? "Uploading…" : "Upload"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && uploadFiles(e.target.files)}
            />
          </div>
        )}
      </div>

      {showLink && !notReady && (
        <div className="px-6 py-4 border-b border-slate-200 bg-secondary/40 flex flex-col sm:flex-row gap-2 sm:items-center">
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addLink()}
            placeholder="Paste a URL (https://…)"
            className="flex-1 px-3 py-2 border border-border bg-card rounded-md text-sm text-foreground"
          />
          <input
            value={linkTitle}
            onChange={(e) => setLinkTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addLink()}
            placeholder="Label (optional)"
            className="sm:w-52 px-3 py-2 border border-border bg-card rounded-md text-sm text-foreground"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={addLink} disabled={savingLink || !linkUrl.trim()}>
              {savingLink && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />} Add
            </Button>
            <button
              type="button"
              onClick={() => { setShowLink(false); setLinkUrl(""); setLinkTitle(""); }}
              className="w-8 h-8 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mx-6 mt-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
          <div className="flex-1">{error}</div>
          <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      <div
        className={`p-6 ${dragOver ? "outline-2 outline-dashed outline-brand-500 outline-offset-[-12px] rounded-lg" : ""}`}
        onDragOver={(e) => { if (!notReady) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {loading ? (
          <div className="py-8 text-center text-slate-500 text-sm">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
          </div>
        ) : notReady ? (
          <div className="py-8 text-center">
            <Paperclip className="w-6 h-6 text-slate-300 mx-auto mb-2" strokeWidth={1.5} />
            <p className="text-sm text-slate-500">Attachments storage isn’t enabled yet.</p>
            {isAdmin && (
              <p className="text-xs text-slate-400 mt-1">Apply migration <code className="font-mono">0154_dashboard_attachments</code> to turn this on.</p>
            )}
          </div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center border-2 border-dashed border-slate-200 rounded-lg">
            <Upload className="w-6 h-6 text-slate-300 mx-auto mb-2" strokeWidth={1.5} />
            <p className="text-sm text-slate-500">Drag files here, or use Upload / Add link.</p>
            <p className="text-xs text-slate-400 mt-1">Documents, images, links — anything worth keeping handy.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {items.map((a) => {
              const label = a.title || a.file_name || hostOf(a.url) || "Untitled";
              const sub = a.kind === "link" ? hostOf(a.url) : fmtBytes(a.size_bytes);
              return (
                <div
                  key={a.id}
                  className="group relative border border-border rounded-lg overflow-hidden bg-card hover:border-brand-500/40 hover:shadow-sm transition-all"
                >
                  <button type="button" onClick={() => open(a)} className="block w-full text-left">
                    <div className="aspect-[4/3] bg-secondary flex items-center justify-center overflow-hidden">
                      {a.kind === "image" && a.storage_path ? (
                        <img src={publicUrl(a.storage_path)} alt={label} className="w-full h-full object-cover" loading="lazy" />
                      ) : a.kind === "link" ? (
                        <Link2 className="w-7 h-7 text-brand-500" strokeWidth={1.5} />
                      ) : a.kind === "image" ? (
                        <ImageIcon className="w-7 h-7 text-muted-foreground" strokeWidth={1.5} />
                      ) : (
                        <FileText className="w-7 h-7 text-muted-foreground" strokeWidth={1.5} />
                      )}
                    </div>
                    <div className="p-2.5">
                      <div className="flex items-center gap-1 text-xs font-medium text-foreground">
                        {a.kind === "link" ? <ExternalLink className="w-3 h-3 shrink-0 text-muted-foreground" /> : <FileIcon className="w-3 h-3 shrink-0 text-muted-foreground" />}
                        <span className="truncate">{label}</span>
                      </div>
                      {sub && <div className="text-[11px] text-muted-foreground truncate mt-0.5">{sub}</div>}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(a)}
                    title="Remove"
                    className="absolute top-1.5 right-1.5 w-7 h-7 grid place-items-center rounded-md bg-card/90 border border-border text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-danger-600 hover:bg-danger-50 transition-all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
