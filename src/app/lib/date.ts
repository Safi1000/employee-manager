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
