// Central date formatting. The whole app displays dates as DD/MM/YYYY.
//
// Accepts plain ISO dates ("YYYY-MM-DD"), full ISO timestamps, epoch millis, or
// Date objects. Plain YYYY-MM-DD strings are parsed as a local calendar date so
// the day doesn't shift across timezones.

const toDate = (value: string | number | Date): Date => {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10));
    if (m && value.length <= 10) {
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
    return new Date(value);
  }
  return new Date(value);
};

/** DD/MM/YYYY. Returns "—" for empty values and echoes the raw string if unparseable. */
export function formatDate(value: string | number | Date | null | undefined): string {
  if (value == null || value === "") return "—";
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** DD/MM/YYYY, HH:mm (24h). */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value == null || value === "") return "—";
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${formatDate(d)}, ${hh}:${min}`;
}

/**
 * MM/DD/YYYY. The app standard is DD/MM/YYYY (formatDate); this is for the few
 * places asked to read US-style, currently the Contracts period column.
 */
export function formatDateUS(value: string | number | Date | null | undefined): string {
  if (value == null || value === "") return "—";
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/**
 * The month an invoice belongs to for reporting.
 *
 * Invoices carry two dates: period_start/period_end (the service period being
 * billed) and invoice_date (when the paperwork was raised). June's service
 * invoiced on 3 August is June revenue — accrual, not cash — so the PERIOD wins
 * and invoice_date is only a fallback for rows that predate the period columns.
 *
 * Every month-scoped read of invoices must use this, or the same invoice lands
 * in one month on the Invoices list and another in the P&L.
 */
export const invoiceMonth = (i: {
  period_start?: string | null;
  invoice_date?: string | null;
}): string => ((i.period_start ?? i.invoice_date) ?? "").slice(0, 7);

/**
 * PostgREST filter selecting invoices whose BILLING month falls in
 * [startIso, endIso]. Expressed as an .or() because the column to test depends
 * on whether period_start is set.
 */
export const invoicePeriodFilter = (startIso: string, endIso: string): string =>
  `and(period_start.gte.${startIso},period_start.lte.${endIso}),` +
  `and(period_start.is.null,invoice_date.gte.${startIso},invoice_date.lte.${endIso})`;

/**
 * True only for a complete YYYY-MM-DD that names a real calendar day.
 *
 * `<input type="date">` reports value="" for every intermediate state while the
 * user types — and on Firefox/Safari for a half-entered date such as 2026-08-
 * as well. Feeding that straight into state sends `attendance_date = ''` to
 * PostgREST, which Postgres rejects with
 *
 *     invalid input syntax for type date: ""
 *
 * surfacing as a red error banner mid-keystroke. Guard every date-input
 * onChange with this and simply ignore what fails: the user is still typing,
 * which is not an error worth showing them.
 */
export const isIsoDate = (v: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  // Round-trips only when the day actually exists — rejects 2026-02-31.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
