// Getting a generated file OUT of the app.
//
// On the web this is a download: an <a download> click, or jsPDF/SheetJS doing
// the same internally. Inside a WebView there is no download manager and no
// visible filesystem, so `doc.save()` and `XLSX.writeFile()` silently do
// nothing — the button appears to work and no file ever appears. That is the
// single biggest thing that breaks when this CRM is wrapped natively, because
// every invoice, payslip, attendance sheet and ledger export runs through it.
//
// The native path writes the bytes into the app's Cache directory and opens the
// system share sheet, which is what a phone user actually wants: save to Files
// / Drive, mail it to the client, send it on WhatsApp.

import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { isNative } from "./platform";
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

/**
 * Cache-directory filenames must survive being used as a path segment. Client
 * names reach these exports ("Guards & Guides Ltd. — March/2026 Ledger.xlsx"),
 * and a slash there writes to a directory that does not exist.
 */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim() || "export";
}

/** Blob → base64, the only encoding Capacitor's Filesystem.writeFile accepts. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // The result is a `data:<mime>;base64,<payload>` URL — strip the prefix.
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file data"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Hand `blob` to the user under the name `fileName`.
 *
 * Web: a normal download. Native: write to cache, then open the share sheet.
 * Resolves once the file has been handed off; a user who dismisses the share
 * sheet is NOT an error and resolves normally.
 */
export async function saveBlob(blob: Blob, fileName: string): Promise<void> {
  const name = safeName(fileName);

  if (!isNative) {
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
    return;
  }

  const data = await blobToBase64(blob);
  // Cache, not Documents: these are regenerable artefacts, and Cache is exempt
  // from iOS backup rules and reclaimable by the OS under storage pressure.
  const written = await Filesystem.writeFile({
    path: name,
    data,
    directory: Directory.Cache,
  });

  try {
    await Share.share({
      title: name,
      files: [written.uri],
      dialogTitle: `Save or send ${name}`,
    });
  } catch (err) {
    // Every platform words a user-cancelled share differently, and none of them
    // are failures worth surfacing as an error toast.
    const msg = String((err as Error)?.message ?? err).toLowerCase();
    if (msg.includes("cancel") || msg.includes("abort") || msg.includes("dismiss")) return;
    throw err;
  }
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

/**
 * Open a remote file (a Supabase Storage signed URL, a Drive link). On the web
 * this is a new tab; natively it goes to the system browser, which owns the
 * download and can hand off to the right app. Kept here so callers have one
 * import for "get this file to the user" regardless of where it lives.
 */
export function openRemoteFile(url: string): Promise<void> {
  return openExternal(url);
}
