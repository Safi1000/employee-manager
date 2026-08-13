import { ReactNode } from "react";

// The phone rendering of a list page.
//
// A CRM table is 6–11 columns. Side-scrolling one on a 390px screen means
// hunting for a column while losing track of which row you are on, so on a
// phone the ROW becomes the unit: one card per record, led by whatever
// identifies it, with the rest as labelled pairs underneath.
//
// This is deliberately NOT `ResponsiveTable`. ResponsiveTable owns both
// renderings and requires a page to give up its <table>; that is a large,
// risky edit on pages whose cells carry inputs, badges and sticky columns.
// This component renders the cards ONLY — the existing table stays exactly as
// it is and gets `hidden md:block`. Nothing about the desktop view changes,
// which is what makes it safe to apply across a dozen pages at once.
//
//   <MobileCardList
//     rows={sorted}
//     rowKey={(r) => r.id}
//     title={(r) => r.name}
//     fields={[{ label: "Phone", value: (r) => r.phone ?? "—" }]}
//     actions={(r) => <Button onClick={() => open(r)}>View</Button>}
//   />
//   <div className="hidden md:block overflow-x-auto"><table>…</table></div>

export type CardField<T> = {
  label: string;
  value: (row: T) => ReactNode;
  /** Span both columns — for anything long, like an address or a note. */
  full?: boolean;
};

type Props<T> = {
  rows: T[];
  rowKey: (row: T) => string;
  /** The card's heading: the value that tells the user which record this is. */
  title: (row: T) => ReactNode;
  /** Small muted line under the title — a code, a reference, a client name. */
  subtitle?: (row: T) => ReactNode;
  /** Status pill, right-aligned against the title. */
  badge?: (row: T) => ReactNode;
  fields?: CardField<T>[];
  /** Free-form row of chips below the fields (warnings, flags). */
  tags?: (row: T) => ReactNode;
  /** Buttons in a footer. Clicks here never bubble to `onClick`. */
  actions?: (row: T) => ReactNode;
  /** Whole-card tap. */
  onClick?: (row: T) => void;
  /**
   * Tailwind border colour for the card's left edge, e.g. "border-l-danger-500".
   * Used where the desktop table tints a row to flag it.
   */
  accent?: (row: T) => string | undefined;
  loading?: boolean;
  empty?: ReactNode;
};

export default function MobileCardList<T>({
  rows,
  rowKey,
  title,
  subtitle,
  badge,
  fields = [],
  tags,
  actions,
  onClick,
  accent,
  loading = false,
  empty = "Nothing to show.",
}: Props<T>) {
  if (loading) {
    return (
      <div className="md:hidden px-4 py-10 text-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="md:hidden px-4 py-10 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }

  return (
    <div className="md:hidden divide-y divide-border">
      {rows.map((row) => {
        const tagRow = tags?.(row);
        const sub = subtitle?.(row);
        return (
          <div
            key={rowKey(row)}
            onClick={onClick ? () => onClick(row) : undefined}
            className={`px-4 py-3 border-l-2 ${accent?.(row) ?? "border-l-transparent"} ${
              onClick ? "active:bg-muted/60" : ""
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground break-words">{title(row)}</div>
                {sub != null && sub !== "" && (
                  <div className="text-[11px] text-muted-foreground break-words">{sub}</div>
                )}
              </div>
              {badge && <div className="flex-shrink-0">{badge(row)}</div>}
            </div>

            {fields.length > 0 && (
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                {fields.map((f) => (
                  <div key={f.label} className={`min-w-0 ${f.full ? "col-span-2" : ""}`}>
                    <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {f.label}
                    </dt>
                    <dd className="text-sm text-foreground break-words">{f.value(row)}</dd>
                  </div>
                ))}
              </dl>
            )}

            {tagRow && <div className="mt-2 flex flex-wrap gap-1">{tagRow}</div>}

            {actions && (
              // stopPropagation so tapping an action never also fires the
              // card's own onClick and opens a detail view behind it.
              <div
                className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border/60 pt-2"
                onClick={(e) => e.stopPropagation()}
              >
                {actions(row)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
