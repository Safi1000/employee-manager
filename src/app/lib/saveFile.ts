// Getting a generated file OUT of the app: a browser download.

import { openExternal } from "./openExternal";

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
}

/** `saveBlob` for text content (CSV, JSON). */
export function saveText(text: string, fileName: string): Promise<void> {
  return saveBlob(new Blob([text], { type: mimeFor(fileName) }), fileName);
}

/**
 * Save a jsPDF document. Drop-in replacement for `doc.save(name)`.
 *
 * Typed structurally rather than against jsPDF so this module stays importable
 * from the export helpers without dragging the jsPDF types through.
 */
export function savePdf(doc: { output: (type: "blob") => Blob }, fileName: string): Promise<void> {
  return saveBlob(doc.output("blob"), fileName);
}

/** Open a remote file (a Supabase Storage signed URL, a Drive link) in a new tab. */
export function openRemoteFile(url: string): Promise<void> {
  return openExternal(url);
}
