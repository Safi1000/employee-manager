import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, Star } from "lucide-react";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { formatDate } from "../lib/date";
import { generateClientServiceReportPdf } from "../lib/clientReportPdf";

/**
 * A client's service record (3 Nov 2026): reviews of how the service is going,
 * the complaints raised, and the printable Client Service Report. All three
 * existed, but their only page (Client Relationships) was dissolved into the
 * client record and nothing on the record reached them — the review table and
 * the report generator had no way in.
 */
type Review = { id: string; review_date: string; rating: number; summary: string | null; action_items: string | null };
type Complaint = { id: string; raised_on: string; channel: string | null; description: string | null; status: string | null; resolved_on: string | null };

export default function ClientService({ clientId, clientName, canEdit }: { clientId: string; clientName: string; canEdit: boolean }) {
  const { company } = useAuth();
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rating, setRating] = useState(4);
  const [summary, setSummary] = useState("");
  const [actions, setActions] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [rv, cp] = await Promise.all([
      supabase.from("client_service_reviews").select("id, review_date, rating, summary, action_items").eq("client_id", clientId).order("review_date", { ascending: false }),
      supabase.from("client_complaints").select("id, raised_on, channel, description, status, resolved_on").eq("client_id", clientId).order("raised_on", { ascending: false }),
    ]);
    if (rv.error) setErr(friendlyDbError(rv.error));
    setReviews((rv.data ?? []) as Review[]);
    setComplaints((cp.data ?? []) as Complaint[]);
  }, [clientId]);
  useEffect(() => { void load(); }, [load]);

  const addReview = async () => {
    if (!company?.id || !summary.trim()) return;
    setBusy(true);
    const { error } = await supabase.from("client_service_reviews").insert({
      company_id: company.id, client_id: clientId, review_date: date, rating, summary: summary.trim(), action_items: actions.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setSummary(""); setActions(""); void load();
  };

  const report = () => generateClientServiceReportPdf({
    companyName: company?.name ?? "",
    clientName,
    reviews: (reviews ?? []).map((r) => ({ review_date: r.review_date, rating: r.rating, summary: r.summary ?? undefined, action_items: r.action_items ?? undefined })),
    complaints: complaints.map((c) => ({ raised_on: c.raised_on, channel: c.channel ?? undefined, description: c.description ?? undefined, status: c.status ?? undefined, resolved_on: c.resolved_on })),
  });

  if (!reviews) return <div className="text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>;
  const open = complaints.filter((c) => c.status !== "resolved" && c.status !== "closed").length;
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{reviews.length} review{reviews.length === 1 ? "" : "s"} · {complaints.length} complaint{complaints.length === 1 ? "" : "s"}{open ? ` (${open} open)` : ""}</span>
        <div className="flex-1" />
        <Button size="sm" variant="secondary" onClick={report}><FileText className="w-4 h-4 mr-1" />Client Service Report</Button>
      </div>
      {err && <div className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-down">{err}</div>}

      {canEdit && (
        <div className="rounded-xl border border-border p-3 space-y-2">
          <p className="font-medium text-foreground">Record a service review</p>
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-2 py-1 rounded-lg border border-border bg-card" />
            <span className="inline-flex">{[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} of 5`}>
                <Star className={`w-5 h-5 ${n <= rating ? "fill-brand-500 text-brand-500" : "text-muted-foreground"}`} />
              </button>
            ))}</span>
          </div>
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} placeholder="How the client says the service is going…" className="w-full px-3 py-2 rounded-lg border border-border bg-card" />
          <input value={actions} onChange={(e) => setActions(e.target.value)} placeholder="Actions agreed (optional)" className="w-full px-3 py-2 rounded-lg border border-border bg-card" />
          <Button size="sm" onClick={() => void addReview()} disabled={busy || !summary.trim()}>{busy ? "Saving…" : "Save review"}</Button>
        </div>
      )}

      <div>
        <p className="lbl mb-1">Reviews</p>
        {reviews.length === 0 ? <p className="text-muted-foreground italic">No review recorded yet.</p> : (
          <ul className="divide-y divide-border">{reviews.map((r) => (
            <li key={r.id} className="py-2">
              <span className="text-muted-foreground">{formatDate(r.review_date)} · {"★".repeat(r.rating)}{"☆".repeat(Math.max(0, 5 - r.rating))}</span>
              {r.summary && <p className="text-foreground">{r.summary}</p>}
              {r.action_items && <p className="text-xs text-muted-foreground">Actions: {r.action_items}</p>}
            </li>
          ))}</ul>
        )}
      </div>
      <div>
        <p className="lbl mb-1">Complaints</p>
        {complaints.length === 0 ? <p className="text-muted-foreground italic">No complaint recorded.</p> : (
          <ul className="divide-y divide-border">{complaints.map((c) => (
            <li key={c.id} className="py-2">
              <span className="text-muted-foreground">{formatDate(c.raised_on)}{c.channel ? ` · ${c.channel.replace(/_/g, " ")}` : ""} · {c.status ?? "open"}{c.resolved_on ? ` ${formatDate(c.resolved_on)}` : ""}</span>
              {c.description && <p className="text-foreground">{c.description}</p>}
            </li>
          ))}</ul>
        )}
      </div>
    </div>
  );
}
