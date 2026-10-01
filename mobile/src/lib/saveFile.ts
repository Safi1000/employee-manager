// Getting a generated file OUT of the app: write it to the cache directory and
// open the system share sheet (save to Files / Drive, WhatsApp, email). This is
// the phone's implementation of the web app's lib/saveFile.ts — the copied web
// generators in lib/web/ call these exact names.
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

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

/** Client names reach these file names ("Guards & Guides Ltd. — March/2026 Ledger.xlsx"). */
function safeName(name: string): string {
  return name.replace(/[\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim() || "export";
}

async function share(file: File, name: string) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device.");
  await Sharing.shareAsync(file.uri, { mimeType: mimeFor(name), dialogTitle: `Save or send ${name}`, UTI: extOf(name) === "pdf" ? "com.adobe.pdf" : undefined });
}

function cacheFile(name: string) {
  const f = new File(Paths.cache, safeName(name));
  if (f.exists) f.delete();
  f.create();
  return f;
}

/** Raw bytes (xlsx) → file → share sheet. */
export async function saveBytes(bytes: ArrayBuffer | Uint8Array, fileName: string): Promise<void> {
  const f = cacheFile(fileName);
  f.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  await share(f, fileName);
}

/** Base64 payload → file → share sheet. */
export async function saveBase64(b64: string, fileName: string): Promise<void> {
  const f = cacheFile(fileName);
  f.write(b64, { encoding: "base64" });
  await share(f, fileName);
}

export async function saveText(text: string, fileName: string): Promise<void> {
  const f = cacheFile(fileName);
  f.write(text);
  await share(f, fileName);
}

/** Drop-in for the web's savePdf(doc, name): jsPDF → base64 → share. */
export function savePdf(doc: { output: (type: "datauristring") => string }, fileName: string): Promise<void> {
  const uri = doc.output("datauristring");
  return saveBase64(uri.slice(uri.indexOf(",") + 1), fileName);
}

/** The web passes Blobs; React Native cannot build one from bytes, so the copied excel.ts is patched to call saveBytes. */
export async function saveBlob(_blob: unknown, fileName: string): Promise<void> {
  throw new Error(`saveBlob is not supported on the phone (${fileName}) — use saveBytes.`);
}

export function openRemoteFile(url: string): Promise<void> {
  return import("react-native").then(({ Linking }) => Linking.openURL(url));
}
