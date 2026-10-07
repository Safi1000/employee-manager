// Shared presentation pieces for Assets & Issuance (Store, Issuance, Clearance,
// Register). Layout only — no data, no rules. Every tab and every popup on the
// page is built from these so the four read as one screen.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertCircle, CheckCircle2, Search, X } from "lucide-react";

export const inputCls =
  "w-full h-10 px-3 rounded-lg border border-border bg-background text-sm text-foreground " +
  "placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 " +
  "disabled:opacity-60 disabled:cursor-not-allowed transition-colors";

export const textareaCls =
  "w-full px-3 py-2 rounded-lg border border-border bg-background text-xs font-mono text-foreground " +
  "placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500";

export const money = (n: unknown) => Number(n ?? 0).toLocaleString();

/** Page body: the scroller under each tab's sticky Header. */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className="flex-1 overflow-y-auto px-3 md:px-8 py-4 md:py-6 space-y-5">{children}</div>;
}

/** A titled card section: icon chip, heading, one-line description, actions. */
export function Panel({
  icon: Icon, title, description, actions, children, tone = "brand", flush,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  tone?: "brand" | "warning" | "success" | "danger" | "info";
  /** Children sit edge to edge (tables) instead of inside padding. */
  flush?: boolean;
}) {
  const chip: Record<string, string> = {
    brand: "bg-brand-50 border-brand-200 text-brand-700 dark:text-brand-500",
    warning: "bg-warning-50 border-warning-200 text-warning-700 dark:text-warning-500",
    success: "bg-success-50 border-success-200 text-success-700 dark:text-success-500",
    danger: "bg-danger-50 border-danger-200 text-danger-700 dark:text-danger-500",
    info: "bg-info-50 border-info-200 text-info-700 dark:text-info-500",
  };
  return (
    <section className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 md:px-5 py-3.5 border-b border-border">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {Icon && (
            <div className={`w-9 h-9 rounded-lg border flex items-center justify-center flex-shrink-0 ${chip[tone]}`}>
              <Icon className="w-4 h-4" strokeWidth={1.75} />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {description && <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
      {children != null && <div className={flush ? "" : "p-4 md:p-5"}>{children}</div>}
    </section>
  );
}

/** Dismissible error / success banner. */
export function Notice({
  kind, children, onClose,
}: { kind: "error" | "success"; children: ReactNode; onClose?: () => void }) {
  const cls = kind === "error"
    ? "bg-danger-50 border-danger-200 text-danger-700 dark:text-danger-500"
    : "bg-success-50 border-success-200 text-success-700 dark:text-success-500";
  const Icon = kind === "error" ? AlertCircle : CheckCircle2;
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${cls}`}>
      <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={2} />
      <div className="flex-1 min-w-0 break-words">{children}</div>
      {onClose && (
        <button onClick={onClose} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

/** Label + control + optional hint. */
export function FormField({
  label, required, hint, children, className,
}: { label: ReactNode; required?: boolean; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-foreground mb-1.5">
        {label}{required && <span className="text-danger-600 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  );
}

/** A group heading inside a popup, so long forms read in steps. */
export function FormSection({ step, title, children }: { step?: number; title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {step != null && (
          <span className="w-5 h-5 rounded-full bg-brand-500 text-[#241a06] text-[11px] font-semibold flex items-center justify-center">
            {step}
          </span>
        )}
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
      </div>
      {children}
    </div>
  );
}

/** Small explanatory callout inside a popup. */
export function Hint({ tone = "neutral", children }: { tone?: "neutral" | "warning" | "info"; children: ReactNode }) {
  const cls = {
    neutral: "bg-muted/50 border-border text-muted-foreground",
    warning: "bg-warning-50 border-warning-200 text-warning-700 dark:text-warning-500",
    info: "bg-info-50 border-info-200 text-info-700 dark:text-info-500",
  }[tone];
  return <div className={`rounded-lg border px-3 py-2.5 text-xs leading-relaxed ${cls}`}>{children}</div>;
}

/** Mutually exclusive choice rendered as selectable cards. */
export function ChoiceCards<T extends string>({
  value, onChange, options, disabled, columns = 3,
}: {
  value: T | null;
  onChange: (v: T) => void;
  options: { value: T; label: string; sub?: string; tone?: "danger" | "success" | "warning" }[];
  disabled?: boolean;
  columns?: 2 | 3 | 4;
}) {
  const grid = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" }[columns];
  return (
    <div className={`grid grid-cols-1 ${grid} gap-2`} role="radiogroup">
      {options.map((o) => {
        const active = value === o.value;
        const activeCls = o.tone === "danger"
          ? "border-danger-500 bg-danger-50 ring-1 ring-danger-500/40"
          : o.tone === "success"
            ? "border-success-500 bg-success-50 ring-1 ring-success-500/40"
            : o.tone === "warning"
              ? "border-warning-500 bg-warning-50 ring-1 ring-warning-500/40"
              : "border-brand-500 bg-brand-500/10 ring-1 ring-brand-500/40";
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`text-left rounded-lg border px-3 py-2.5 transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
              active ? activeCls : "border-border bg-card hover:bg-accent"
            }`}
          >
            <span className="block text-sm font-medium text-foreground">{o.label}</span>
            {o.sub && <span className="block text-[11px] text-muted-foreground mt-0.5 leading-snug">{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Compact pill choice (conditions, grade, payment mode). */
export function Pills<T extends string>({
  value, onChange, options,
}: { value: T; onChange: (v: T) => void; options: readonly T[] | { value: T; label: string }[] }) {
  const opts = (options as readonly unknown[]).map((o) =>
    typeof o === "string" ? { value: o as T, label: o as string } : (o as { value: T; label: string }));
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {opts.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`px-3 py-1.5 rounded-md border text-sm capitalize transition-colors ${
              active
                ? "border-brand-500 bg-brand-500/15 text-brand-700 dark:text-brand-500 font-medium"
                : "border-border text-muted-foreground hover:bg-accent"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Toggle row: a checkbox styled as a card with a title and explanation. */
export function ToggleCard({
  checked, onChange, title, sub, disabled,
}: { checked: boolean; onChange: (v: boolean) => void; title: string; sub?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
      checked ? "border-brand-500 bg-brand-500/10" : "border-border bg-card"
    } ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-accent"}`}>
      <input type="checkbox" className="mt-0.5 accent-brand-500" checked={checked} disabled={disabled}
             onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium text-foreground">{title}</span>
        {sub && <span className="block text-[11px] text-muted-foreground mt-0.5 leading-snug">{sub}</span>}
      </span>
    </label>
  );
}

/** Search box with icon. */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full sm:max-w-xs">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
      <input className={inputCls + " pl-9"} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Popup footer: a summary on the left, actions on the right. */
export function ModalFooter({ summary, children }: { summary?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
      <div className="text-sm text-muted-foreground">{summary}</div>
      <div className="flex justify-end gap-2">{children}</div>
    </div>
  );
}

/** Summary card for the thing a popup acts on (an issuance, a guard). */
export function SubjectCard({ title, meta, aside }: { title: ReactNode; meta?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground truncate">{title}</div>
        {meta && <div className="text-xs text-muted-foreground mt-0.5">{meta}</div>}
      </div>
      {aside && <div className="flex-shrink-0">{aside}</div>}
    </div>
  );
}

/** Review table for a paste: good rows render their cells, bad rows their error. */
export function PastePreview<R extends { error: string | null }>({
  rows, headers, cells,
}: { rows: R[]; headers: string[]; cells: (r: R) => ReactNode[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-auto max-h-72 rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted/90 backdrop-blur border-b border-border">
          <tr>
            <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground w-10">#</th>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((r, i) => (
            <tr key={i} className={r.error ? "bg-danger-50/60" : undefined}>
              <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">{i + 1}</td>
              {r.error
                ? <td colSpan={headers.length} className="px-3 py-2 text-danger-700 dark:text-danger-500">{r.error}</td>
                : cells(r).map((c, j) => <td key={j} className="px-3 py-2 text-foreground">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "12 lines · 2 need fixing" summary for a paste. */
export function PasteCount({ total, bad, noun, extra }: { total: number; bad: number; noun: string; extra?: ReactNode }) {
  return (
    <span>
      <span className="font-medium text-foreground">{total}</span> {noun}{total === 1 ? "" : "s"}
      {bad > 0
        ? <span className="text-danger-700 dark:text-danger-500"> · {bad} need fixing</span>
        : extra ? <> · {extra}</> : null}
    </span>
  );
}
