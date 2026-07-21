import { useEffect, useMemo, useState } from "react";

// Landing-page "Activity feed": a live panel where the newest row slides in at
// the top on an interval and the oldest drops off. Fed with real events; if
// there are more than `rows`, it cycles through them so it always feels live.

export type FeedTone = "in" | "out" | "evt";

export type FeedItem = {
  id: string;
  tone: FeedTone;
  text: string;
  /** Optional right-aligned mono figure, e.g. "+312,000" or "−45,000". */
  amount?: string;
};

const DOT: Record<FeedTone, string> = {
  in: "bg-success-500 shadow-[0_0_8px_var(--color-success-500)]",
  out: "bg-danger-500",
  evt: "bg-brand-500",
};

const AMT: Record<FeedTone, string> = {
  in: "text-success-600 dark:text-success-500",
  out: "text-danger-600 dark:text-danger-500",
  evt: "text-foreground",
};

export default function ActivityFeed({
  items,
  rows = 6,
  interval = 2600,
  title = "Activity feed",
}: {
  items: FeedItem[];
  rows?: number;
  interval?: number;
  title?: string;
}) {
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reduce || items.length <= rows) return;
    const id = setInterval(() => setTick((t) => t + 1), interval);
    return () => clearInterval(id);
  }, [reduce, items.length, rows, interval]);

  const visible = useMemo(() => {
    if (items.length === 0) return [];
    const out: FeedItem[] = [];
    const n = Math.min(rows, items.length);
    for (let i = 0; i < n; i++) out.push(items[(tick + i) % items.length]);
    return out;
  }, [items, tick, rows]);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-success-600 dark:text-success-500">
          <span className="w-1.5 h-1.5 rounded-full bg-success-500 shadow-[0_0_8px_var(--color-success-500)] animate-pulse" />
          {title}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">live</span>
      </div>
      {visible.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          Activity will appear here as your team works.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((it, i) => (
            <li
              key={i === 0 ? `fresh-${tick}` : `row-${i}`}
              className={`flex items-center gap-3 px-5 py-3.5 ${i === 0 && !reduce ? "feed-row-fresh" : ""}`}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT[it.tone]}`} />
              <span className="text-sm text-muted-foreground truncate flex-1">{it.text}</span>
              {it.amount && (
                <span className={`font-mono text-sm tabular-nums flex-shrink-0 ${AMT[it.tone]}`}>{it.amount}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
