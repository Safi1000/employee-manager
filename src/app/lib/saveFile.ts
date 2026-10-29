// Getting a generated file OUT of the app: a browser download.

import { openExternal } from "./openExternal";
import { supabase } from "./supabase";
import { exportStamp } from "./exportStamp";

/** MIME types for the kinds of file this app produces. */
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
};

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
export const mimeFor = (name: string) => MIME[extOf(name)] ?? "application/octet-stream";

/** Client names reach these exports ("Guards & Guides Ltd. — March/2026 Ledger.xlsx"). */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim() || "export";
}

/** Hand `blob` to the user under the name `fileName` as a download. */
export async function saveBlob(blob: Blob, fileName: string): Promise<void> {
  const name = safeName(fileName);

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next frame — revoking synchronously races the download in
  // Safari and produces a zero-byte file.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  // 0595: who took which file, from which screen. Fire-and-forget — a log that
  // could not be written never stops the download.
  void supabase.rpc("log_export", { p_file_name: name, p_kind: extOf(name) || null, p_screen: window.location.pathname })
    .then(() => undefined, () => undefined);
}

/** `saveBlob` for text content (CSV, JSON). */
export function saveText(text: string, fileName: string): Promise<void> {
  return saveBlob(new Blob([text], { type: mimeFor(fileName) }), fileName);
}

// Typed structurally rather than against jsPDF so this module stays importable
// from the export helpers without dragging the jsPDF types through.
type StampablePdf = {
  output: (type: "blob") => Blob;
  getNumberOfPages?: () => number;
  setPage?: (n: number) => unknown;
  setFontSize?: (n: number) => unknown;
  setTextColor?: (n: number) => unknown;
  text?: (text: string, x: number, y: number) => unknown;
  internal?: { pageSize: { getHeight: () => number }; scaleFactor: number };
};

/**
 * Save a jsPDF document. Drop-in replacement for `doc.save(name)`.
 *
 * 0595: every page is stamped "Exported by <name> · <time> · Bastion" in small
 * grey type at the foot, so a PDF that leaves the company names who took it.
 */
export function savePdf(doc: StampablePdf, fileName: string): Promise<void> {
  if (doc.getNumberOfPages && doc.setPage && doc.text && doc.setFontSize && doc.setTextColor && doc.internal) {
    const stamp = exportStamp();
    const mm = doc.internal.scaleFactor ? 2.83465 / doc.internal.scaleFactor : 1;   // 1 mm in document units
    for (let i = 1; i <= doc.getNumberOfPages(); i++) {
      doc.setPage(i);
      doc.setFontSize(6.5);
      doc.setTextColor(150);
      doc.text(stamp, 4 * mm, doc.internal.pageSize.getHeight() - 2.5 * mm);
    }
  }
  return saveBlob(doc.output("blob"), fileName);
}

/** Open a remote file (a Supabase Storage signed URL, a Drive link) in a new tab. */
export function openRemoteFile(url: string): Promise<void> {
  return openExternal(url);
}
