/**
 * Semantic tone helpers — domain-meaningful color groupings that compose
 * Tailwind utility classes for the common "soft tint + matching border +
 * accent text" pattern used across the app.
 *
 * Use:
 *   <div className={tone.success.card}>...</div>     // bg + left border
 *   <span className={tone.danger.badge}>Overdue</span>
 *   <button className={tone.brand.solidButton}>Save</button>
 *
 * Each tone maps to a single semantic palette (success, danger, warning,
 * info, brand, neutral). Pick the tone that matches *meaning*, not visual
 * color preference — that's the whole point.
 */

export type Tone = "success" | "danger" | "warning" | "info" | "brand" | "neutral";

type ToneSet = {
  /** Light tinted background only. */
  softBg: string;
  /** Accent text color. */
  text: string;
  /** Icon color (one shade brighter than text). */
  icon: string;
  /** Tinted border. */
  border: string;
  /** Strong border (used for left accent strips). */
  borderStrong: string;
  /** Composed badge: tint + text + border. */
  badge: string;
  /** Composed card: tint + thin border + left accent border. */
  card: string;
  /** Composed stat-card surface: white bg + left accent border + accent text. */
  statCard: string;
  /** Solid button (filled with tone). */
  solidButton: string;
  /** Subtle (ghost) button using the tone. */
  subtleButton: string;
  /** Recharts stroke / fill. */
  chartStroke: string;
  chartFill: string;
};

const make = (key: Exclude<Tone, "neutral">): ToneSet => ({
  softBg: `bg-${key}-50`,
  text: `text-${key}-700`,
  icon: `text-${key}-600`,
  border: `border-${key}-200`,
  borderStrong: `border-${key}-500`,
  badge: `inline-flex items-center px-2 py-0.5 rounded text-xs bg-${key}-50 text-${key}-700 border border-${key}-200`,
  card: `bg-${key}-50 border border-${key}-200 border-l-4 border-l-${key}-500 rounded-lg`,
  statCard: `bg-white border border-slate-200 border-l-4 border-l-${key}-500 rounded-lg`,
  solidButton: `bg-${key}-600 hover:bg-${key}-700 text-white`,
  subtleButton: `bg-${key}-50 hover:bg-${key}-100 text-${key}-700`,
  chartStroke: `var(--color-${key}-600)`,
  chartFill: `var(--color-${key}-500)`,
});

const neutral: ToneSet = {
  softBg: "bg-slate-50",
  text: "text-slate-700",
  icon: "text-slate-600",
  border: "border-slate-200",
  borderStrong: "border-slate-500",
  badge: "inline-flex items-center px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-700 border border-slate-200",
  card: "bg-slate-50 border border-slate-200 border-l-4 border-l-slate-400 rounded-lg",
  statCard: "bg-white border border-slate-200 border-l-4 border-l-slate-400 rounded-lg",
  solidButton: "bg-slate-900 hover:bg-slate-800 text-white",
  subtleButton: "bg-slate-100 hover:bg-slate-200 text-slate-700",
  chartStroke: "#64748b",
  chartFill: "#94a3b8",
};

export const tone: Record<Tone, ToneSet> = {
  success: make("success"),
  danger: make("danger"),
  warning: make("warning"),
  info: make("info"),
  brand: make("brand"),
  neutral,
};

/** Map common business statuses to a tone. Used by Badge & friends so a
 * "Cleared" payroll status, a "Paid" invoice, and a "Disbursed" payslip all
 * land on the same `success` palette without a 6-arm if/else each time. */
export function toneOfStatus(status: string | null | undefined): Tone {
  if (!status) return "neutral";
  const s = status.toLowerCase();
  if (
    s === "cleared" ||
    s === "paid" ||
    s === "disbursed" ||
    s === "received" ||
    s === "active" ||
    s === "completed" ||
    s === "done" ||
    s === "present"
  )
    return "success";
  if (
    s === "overdue" ||
    s === "failed" ||
    s === "rejected" ||
    s === "absent" ||
    s === "expired" ||
    s === "critical"
  )
    return "danger";
  if (
    s === "pending" ||
    s === "due" ||
    s === "leave" ||
    s === "partial" ||
    s === "in_progress" ||
    s === "in progress" ||
    s === "warning" ||
    s === "high"
  )
    return "warning";
  if (s === "draft" || s === "todo" || s === "to do" || s === "info" || s === "scheduled" || s === "medium")
    return "info";
  return "neutral";
}
