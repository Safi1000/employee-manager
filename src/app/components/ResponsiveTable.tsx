import { ReactNode } from "react";

// One table definition, two renderings.
//
// The CRM's tables are built for a desktop: Employees is 11 columns, the
// receivables ledger is 9. None of that fits 390 logical pixels, and the usual
// fix — wrapping the table in `overflow-x-auto` — produces a surface where the
// user scrolls sideways hunting for the column they want and loses which row
// they are on. On a phone the row, not the column, is the unit of interest.
//
// So: describe the columns once, get a real <table> at md+ and a stack of cards
// below it. Each card leads with the column marked `primary` as its title and
// lists the rest as label/value pairs, dropping any column marked
// `hideOnMobile` — the ones that only earn their place when scanning hundreds
// of rows at once.
//
// This is a presentation wrapper only: sorting, filtering and paging stay with
// the page that owns the data.

export type Column<T> = {
  /** Stable identity for React keys. */
  key: string;
  /** Column heading. Also the label on the mobile card. */
  header: ReactNode;
  /** Cell contents for one row. */
  cell: (row: T) => ReactNode;
  /**
   * The card's title on mobile — the value that identifies the row (a guard's
   * name, an invoice number). Exactly one column should set this; if none does,
   * the first column is used.
   */
  primary?: boolean;
  /**
   * Drop this column from the mobile cards. For columns that only make sense
   * when comparing rows (row numbers, internal codes) or that duplicate
   * something already in the card.
   */
  hideOnMobile?: boolean;
  /** Extra classes for the <td>/<th>, e.g. "text-right tabular-nums". */
  className?: string;
};

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Whole-row click, on both renderings. */
  onRowClick?: (row: T) => void;
  /** Shown in place of the table/cards when there are no rows. */
  empty?: ReactNode;
  /** Per-row trailing actions. Rendered in a footer on the mobile card. */
  actions?: (row: T) => ReactNode;
};

export default function ResponsiveTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty = "Nothing to show.",
  actions,
}: Props<T>) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }

  const primary = columns.find((c) => c.primary) ?? columns[0];
  const secondary = columns.filter((c) => c !== primary && !c.hideOnMobile);

  return (
    <>
      {/* ── Desktop: the real table ── */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground ${c.className ?? ""}`}
                >
                  {c.header}
                </th>
              ))}
              {actions && <th className="px-3 py-2.5" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-b border-border/60 ${onRowClick ? "cursor-pointer hover:bg-muted/50" : ""}`}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-3 py-2.5 text-foreground ${c.className ?? ""}`}>
                    {c.cell(row)}
                  </td>
                ))}
                {actions && <td className="px-3 py-2.5 text-right">{actions(row)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Mobile: one card per row ── */}
      <div className="space-y-2 md:hidden">
        {rows.map((row) => (
          <div
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`rounded-lg border border-border bg-card p-3 ${onRowClick ? "active:bg-muted/60" : ""}`}
          >
            <div className="text-sm font-semibold text-foreground">{primary.cell(row)}</div>

            {secondary.length > 0 && (
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                {secondary.map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {c.header}
                    </dt>
                    <dd className="truncate text-sm text-foreground">{c.cell(row)}</dd>
                  </div>
                ))}
              </dl>
            )}

            {actions && (
              // stopPropagation so tapping an action never also fires the row's
              // own onClick and opens a detail view behind the action.
              <div
                className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border/60 pt-2"
                onClick={(e) => e.stopPropagation()}
              >
                {actions(row)}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
