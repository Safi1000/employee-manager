// Edge function: gdrive-upload-employee-doc
// Uploads a single employee document to Google Drive using a service account.
// The Drive file is placed under the parent folder identified by
// GOOGLE_DRIVE_PARENT_FOLDER_ID, optionally inside a per-employee subfolder
// (created lazily on first upload). File is made world-readable so the
// returned `view_url` works without further auth.
//
// Auth: the caller must be a signed-in Supabase user. We don't enforce
// company scoping in this function — the DB insert that follows on the
// frontend is gated by RLS on employee_documents.
//
// Request: multipart/form-data with fields:
//   file:        the binary file
//   employee_id: uuid
//   doc_type:    "CNIC" | "Police Verification" | "Other" | ...
//
// Response (200): { drive_file_id, drive_view_url, file_name, mime_type, size_bytes }
// Errors return JSON { error: string } with appropriate status.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { create as jwtCreate, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SA_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SA_PRIVATE_KEY_RAW = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!;
const PARENT_FOLDER_ID = Deno.env.get("GOOGLE_DRIVE_PARENT_FOLDER_ID")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Cache the Drive access token across invocations on a warm container.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function importPrivateKey(pem: string) {
  // The env var is stored with literal \n line breaks (so it survives the
  // Supabase secret editor). Restore real line breaks here.
  const normalized = pem.replace(/\\n/g, "\n");
  const pkcs8 = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pkcs8), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const key = await importPrivateKey(SA_PRIVATE_KEY_RAW);
  const now = getNumericDate(0);
  const exp = getNumericDate(60 * 60); // 1 hour
  const jwt = await jwtCreate(
    { alg: "RS256", typ: "JWT" },
    {
      iss: SA_EMAIL,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp,
    },
    key,
  );
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`token exchange failed: ${resp.status} ${text}`);
  }
  const j = await resp.json();
  cachedToken = {
    token: j.access_token,
    expiresAt: Date.now() + (j.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

// Lazy-create per-employee folder. Drive enforces no name uniqueness so we
// search by name + parent before creating.
async function ensureEmployeeFolder(token: string, employeeId: string): Promise<string> {
  const q = encodeURIComponent(
    `'${PARENT_FOLDER_ID}' in parents and name = 'emp_${employeeId}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  const search = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!search.ok) throw new Error(`folder search failed: ${await search.text()}`);
  const sj = await search.json();
  if (sj.files && sj.files.length > 0) return sj.files[0].id;

  const create = await fetch(
    "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `emp_${employeeId}`,
        mimeType: "application/vnd.google-apps.folder",
        parents: [PARENT_FOLDER_ID],
      }),
    },
  );
  if (!create.ok) throw new Error(`folder create failed: ${await create.text()}`);
  const cj = await create.json();
  return cj.id;
}

// Multipart upload to Drive (good for files up to ~5 MB; for larger consider
// resumable). Boundary is a fixed string — Drive does not care which boundary
// we pick as long as it's unique within the body.
async function uploadFile(
  token: string,
  parentFolderId: string,
  file: File,
  docType: string,
): Promise<{ id: string; webViewLink: string }> {
  const metadata = {
    name: `${docType}_${file.name}`,
    parents: [parentFolderId],
  };
  const boundary = `-------employee-manager-${crypto.randomUUID()}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const fileBuf = new Uint8Array(await file.arrayBuffer());
  const body = new Uint8Array(head.byteLength + fileBuf.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(fileBuf, head.byteLength);
  body.set(tail, head.byteLength + fileBuf.byteLength);

  const resp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`drive upload failed: ${resp.status} ${text}`);
  }
  const j = await resp.json();
  return { id: j.id, webViewLink: j.webViewLink };
}

// Make the file world-readable (anyone with the link can view).
async function makeAnyoneReader(token: string, fileId: string) {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`set permission failed: ${resp.status} ${text}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Auth check — require a logged-in Supabase user. We don't need to identify
  // them beyond "they're signed in"; the DB insert that follows is RLS-gated.
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "invalid_form_data" }, 400);
  }
  const file = form.get("file");
  const employeeId = form.get("employee_id");
  const docType = (form.get("doc_type") ?? "Other") as string;
  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  if (typeof employeeId !== "string" || !employeeId)
    return json({ error: "employee_id_required" }, 400);

  try {
    const token = await getAccessToken();
    const folderId = await ensureEmployeeFolder(token, employeeId);
    const uploaded = await uploadFile(token, folderId, file, docType);
    await makeAnyoneReader(token, uploaded.id);
    return json({
      drive_file_id: uploaded.id,
      drive_view_url: uploaded.webViewLink,
      file_name: file.name,
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
