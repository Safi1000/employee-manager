// Thin wrappers over supabase-js that THROW the database's own message. Every
// ported action is written against these, so a refusal (RLS, a require_perm()
// guard, a trigger) reaches the user verbatim instead of being swallowed.
import { supabase } from "../../lib/supabase";

export function sb() {
  if (!supabase) throw new Error("Not connected to the server.");
  return supabase;
}

/** Call an RPC; throws on error, returns `data`. */
export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await sb().rpc(fn as never, args as never);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Await a query builder; throws on error, returns `data`. */
export async function q<T = any>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

/** Signed-in user id (auth), for the *_by columns the web fills client-side. */
export async function uid(): Promise<string | null> {
  const { data } = await sb().auth.getUser();
  return data.user?.id ?? null;
}

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Web's daysInCurrentMonth() — per-day salary is base ÷ this. */
export const daysInCurrentMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};

export const nn = (s: string | null | undefined) => (s ?? "").trim() || null;

// ---------------------------------------------------------------- Google Drive
// Every attachment in the web app goes through the gdrive-upload edge function
// as multipart form data, then a row pointing at the Drive file is written. The
// phone sends the same fields; React Native's FormData takes a {uri,name,type}.
export type PickedFile = { uri: string; name: string; type: string; size?: number };

async function authHeaders() {
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired — sign in again.");
  return { Authorization: `Bearer ${token}`, apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "" };
}

export type DriveResult = { drive_file_id: string; drive_view_url: string; file_name?: string; mime_type?: string; size_bytes?: number };

export async function driveUpload(file: PickedFile, fields: Record<string, string>): Promise<DriveResult> {
  const fd = new FormData();
  fd.append("file", { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/gdrive-upload`, { method: "POST", headers: await authHeaders(), body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.drive_file_id) throw new Error(`Drive upload failed: ${body?.error ?? `HTTP ${res.status}`}`);
  return body as DriveResult;
}

export async function driveDelete(driveFileId: string) {
  await fetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/gdrive-delete`, {
    method: "POST", headers: { ...(await authHeaders()), "Content-Type": "application/json" }, body: JSON.stringify({ drive_file_id: driveFileId }),
  }).catch(() => {});
}
