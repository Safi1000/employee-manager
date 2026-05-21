// Edge function: gdrive-upload-employee-doc
// Uploads a single employee document to Google Drive using OAuth on a regular
// Google account (NOT a service account — service accounts have zero storage
// quota on personal drives).
//
// Auth model:
//   - One Google account "owns" all employee docs. You ran the OAuth Playground
//     flow once to get a refresh token, which lives in Supabase secrets.
//   - Scope is `drive.file` (non-sensitive). The app can only see / modify
//     files it created — it can't snoop on the user's other Drive files.
//   - The app lazily creates a top-level folder named "EmployeeManager", and
//     per-employee subfolders inside it. Both are found via Drive search
//     (limited to app-created files by the scope).
//
// Request: multipart/form-data with file + employee_id + doc_type.
// Response: { drive_file_id, drive_view_url, file_name, mime_type, size_bytes }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
const REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");
// Tag used to find our root folder even if the user renames it.
const ROOT_FOLDER_NAME = "EmployeeManager";
const ROOT_FOLDER_TAG = "employee_manager_root";

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

// In-memory caches for the lifetime of this function instance. Cold starts
// re-fetch the token (one POST) and re-resolve the root folder (one GET).
let cachedToken: { token: string; expiresAt: number } | null = null;
let cachedRootFolderId: string | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      refresh_token: REFRESH_TOKEN!,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Google token exchange failed (status ${resp.status}). ` +
      `Common causes: refresh token revoked / expired (re-run the OAuth Playground flow), ` +
      `wrong client_id or client_secret. Response: ${text}`,
    );
  }
  const j = await resp.json();
  cachedToken = {
    token: j.access_token,
    expiresAt: Date.now() + (j.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

async function driveSearch(token: string, q: string) {
  const url =
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
    `&fields=files(id,name,appProperties)`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Drive search failed (status ${resp.status}): ${text}`);
  }
  return (await resp.json()).files as { id: string; name: string }[];
}

async function createFolder(
  token: string,
  name: string,
  parentId: string | null,
  appProps?: Record<string, string>,
): Promise<string> {
  const body: Record<string, unknown> = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) body.parents = [parentId];
  if (appProps) body.appProperties = appProps;
  const resp = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Drive folder create failed (status ${resp.status}). ` +
      `Check that the OAuth refresh token was issued for the correct account ` +
      `and that the scope includes drive.file. Response: ${text}`,
    );
  }
  return (await resp.json()).id;
}

async function getRootFolder(token: string): Promise<string> {
  if (cachedRootFolderId) return cachedRootFolderId;
  // Tagged via appProperties so we find it even if the user renames the folder.
  const found = await driveSearch(
    token,
    `mimeType='application/vnd.google-apps.folder' and trashed=false and ` +
      `appProperties has { key='type' and value='${ROOT_FOLDER_TAG}' }`,
  );
  if (found.length > 0) {
    cachedRootFolderId = found[0].id;
    return cachedRootFolderId;
  }
  const id = await createFolder(token, ROOT_FOLDER_NAME, null, { type: ROOT_FOLDER_TAG });
  cachedRootFolderId = id;
  return id;
}

// Sanitize a name for Drive: trim, strip control chars, and escape single
// quotes used by the Drive query language.
function sanitizeName(s: string): string {
  return s.trim().replace(/[\x00-\x1f]/g, "").replace(/'/g, "\\'");
}

async function getEmployeeFolder(
  token: string,
  employeeId: string,
  employeeCode: string | null,
  employeeName: string | null,
): Promise<string> {
  const root = await getRootFolder(token);
  // Look up by hidden appProperties tag so renames in the Drive UI don't
  // orphan the folder.
  const found = await driveSearch(
    token,
    `'${root}' in parents and trashed=false and ` +
      `mimeType='application/vnd.google-apps.folder' and ` +
      `appProperties has { key='employee_id' and value='${employeeId}' }`,
  );
  if (found.length > 0) return found[0].id;

  const friendly =
    employeeCode && employeeName
      ? `${sanitizeName(employeeCode)} - ${sanitizeName(employeeName)}`
      : employeeCode
        ? sanitizeName(employeeCode)
        : employeeName
          ? sanitizeName(employeeName)
          : `emp_${employeeId}`;
  return await createFolder(token, friendly, root, { employee_id: employeeId });
}

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
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink`,
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
    throw new Error(`Drive upload failed (status ${resp.status}): ${text}`);
  }
  const j = await resp.json();
  return { id: j.id, webViewLink: j.webViewLink };
}

async function makeAnyoneReader(token: string, fileId: string) {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
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
    throw new Error(`Drive set-permission failed (status ${resp.status}): ${text}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const missing: string[] = [];
  if (!CLIENT_ID) missing.push("GOOGLE_OAUTH_CLIENT_ID");
  if (!CLIENT_SECRET) missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!REFRESH_TOKEN) missing.push("GOOGLE_OAUTH_REFRESH_TOKEN");
  if (missing.length > 0) {
    const msg = `Missing Edge Function secret(s): ${missing.join(", ")}.`;
    console.error(msg);
    return json({ error: msg }, 500);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "invalid_form_data" }, 400);
  }
  const file = form.get("file");
  const employeeId = form.get("employee_id");
  const docType = (form.get("doc_type") ?? "Other") as string;
  // Optional fields used to give the per-employee Drive folder a friendly name.
  const employeeCode = (form.get("employee_code") as string | null) || null;
  const employeeName = (form.get("employee_name") as string | null) || null;
  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  if (typeof employeeId !== "string" || !employeeId)
    return json({ error: "employee_id_required" }, 400);

  try {
    const token = await getAccessToken();
    const folderId = await getEmployeeFolder(token, employeeId, employeeCode, employeeName);
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
    console.error("gdrive-upload-employee-doc:", msg);
    return json({ error: msg }, 500);
  }
});
