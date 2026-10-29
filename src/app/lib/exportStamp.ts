/**
 * Who is exporting (0595). Every PDF page and workbook Bastion produces says
 * "Exported by <name> · <time>", so a file that leaks names its source; the
 * same download is logged in export_log. The auth provider sets the name when
 * the profile loads — a module value, because the save helpers run outside React.
 */

let exporter: string | null = null;

export function setExporter(name: string | null): void {
  exporter = name && name.trim() ? name.trim() : null;
}

export function exportStamp(): string {
  const when = new Date().toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `Exported by ${exporter ?? "a Bastion user"} · ${when} · Bastion`;
}

export function exporterName(): string {
  return exporter ?? "Bastion user";
}
