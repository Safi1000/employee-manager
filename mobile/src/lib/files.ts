// Getting a file INTO the app: the document picker or the camera. Both resolve
// to the {uri,name,type} shape driveUpload() sends, or null when cancelled.
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { PickedFile } from "../data/api/core";

export async function pickDocument(): Promise<PickedFile | null> {
  const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  return { uri: a.uri, name: a.name, type: a.mimeType ?? "application/octet-stream", size: a.size ?? undefined };
}

export async function takePhoto(): Promise<PickedFile | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Camera permission is needed to take a photo.");
  const r = await ImagePicker.launchCameraAsync({ quality: 0.7, mediaTypes: ["images"] });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  return { uri: a.uri, name: a.fileName ?? `photo-${Date.now()}.jpg`, type: a.mimeType ?? "image/jpeg", size: a.fileSize ?? undefined };
}

/** Pick from the gallery (receipts, screenshots). */
export async function pickImage(): Promise<PickedFile | null> {
  const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ["images"] });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  return { uri: a.uri, name: a.fileName ?? `image-${Date.now()}.jpg`, type: a.mimeType ?? "image/jpeg", size: a.fileSize ?? undefined };
}

/** Pick an image as a data: URL (the web's FileReader.readAsDataURL), with its byte size for the caller's limit. */
export async function pickImageDataUrl(): Promise<{ dataUrl: string; size: number } | null> {
  const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.6, mediaTypes: ["images"], base64: true });
  if (r.canceled || !r.assets?.[0]?.base64) return null;
  const a = r.assets[0];
  const b64 = a.base64 as string;
  return { dataUrl: `data:${a.mimeType ?? "image/jpeg"};base64,${b64}`, size: a.fileSize ?? Math.floor((b64.length * 3) / 4) };
}
