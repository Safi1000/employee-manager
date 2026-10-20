import { type ReactNode, useEffect } from "react";
import { Link } from "react-router";
import { ArrowRight, X } from "lucide-react";

export type DetailRow = { label: ReactNode; value: ReactNode; hint?: ReactNode };

export type DetailContent = {
  kicker?: ReactNode;
  title: ReactNode;
  /** The headline figure, large and mono. */
  big?: ReactNode;
  note?: ReactNode;
  rows?: DetailRow[];
  /** Where "open the full record" goes. */
  link?: { to: string; label: string };
  children?: ReactNode;
};

/**
 * The right-hand sheet any figure opens into: what it is, the number, how it is
 * made up, and a way through to the record. One component so a tile on the
 * dashboard and a cell in a report open the same way.
 */
export default function DetailSheet({ content, onClose }: { content: DetailContent | null; onClose: () => void }) {
  useEffect(() => {
    if (!content) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [content, onClose]);
  if (!content) return null;
  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close details" onClick={onClose} className="absolute inset-0 bg-ink/45 cursor-default" />
      <aside
        aria-label="Details"
        style={{ paddingTop: "calc(var(--safe-top, 0px) + 1.5rem)", paddingBottom: "calc(var(--safe-bottom, 0px) + 2rem)" }}
        className="absolute top-0 right-0 bottom-0 w-full sm:w-[440px] bg-card border-l border-border shadow-[-12px_0_32px_rgba(25,26,16,0.18)] overflow-y-auto px-5 md:px-6 flex flex-col gap-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {content.kicker && <p className="lbl mb-1">{content.kicker}</p>}
            <h2 className="font-display text-xl md:text-2xl font-bold tracking-tight text-foreground">{content.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-xl border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent flex-shrink-0">
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>
        {content.big != null && <div className="font-ledger text-3xl font-semibold tracking-tight text-foreground">{content.big}</div>}
        {content.note && <p className="text-sm text-muted-foreground leading-relaxed">{content.note}</p>}
        {content.rows && content.rows.length > 0 && (
          <dl className="border-t border-border">
            {content.rows.map((r, i) => (
              <div key={i} className="flex items-start justify-between gap-4 py-3 border-b border-border/70">
                <dt className="text-sm text-foreground min-w-0">
                  {r.label}
                  {r.hint && <span className="block text-xs text-muted-foreground mt-0.5">{r.hint}</span>}
                </dt>
                <dd className="font-ledger text-sm text-foreground text-right flex-shrink-0">{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {content.children}
        {content.link && (
          <Link to={content.link.to} onClick={onClose} className="self-start inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-foreground text-background text-sm font-semibold hover:opacity-90">
            {content.link.label} <ArrowRight className="w-4 h-4" />
          </Link>
        )}
      </aside>
    </div>
  );
}
