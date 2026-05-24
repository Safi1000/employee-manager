// Edge function: gdrive-upload
// Generic Drive uploader. One function handles every artifact category in the
// CRM: employees, contracts, invoices, cheques, expenses.
//
// Folder layout (matches the structure confirmed with the user):
//   EmployeeManager/                            <- root, tag: employee_manager_root
//   └── <Company Name>/                         <- tag: { type: "company_root", company_id }
//       ├── Employees/                          <- tag: { type: "category", category: "employees" }
//       │   └── <EMP001> - <John Doe>/          <- tag: { type: "entity", entity_id }
//       ├── Contracts/
//       │   └── <CLI001> - <Acme Corp>/
//       ├── Invoices/
//       │   └── 2026/                           <- tag: { type: "year", year: "2026" }
//       ├── Cheques/
//       │   └── 2026/
//       └── Expenses/
//           └── 2026/
//
// All lookups happen via `appProperties` (hidden tags), so users can rename any
// folder in the Drive UI without breaking uploads.
//
// Auth: OAuth refresh-token flow on a regular Google account (drive.file scope).
// See gdrive-upload-employee-doc/README.md for the one-time setup steps; this
// function reuses the same three secrets.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
const REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");

const ROOT_FOLDER_NAME = "EmployeeManager";
const ROOT_FOLDER_TAG = "employee_manager_root";

type Category = "employees" | "contracts" | "invoices" | "cheques" | "expenses";
const VALID_CATEGORIES: Category[] = [
  "employees",
  "contracts",
  "invoices",
  "cheques",
  "expenses",
];
const CATEGORY_DISPLAY: Record<Category, string> = {
  employees: "Employees",
  contracts: "Contracts",
  invoices: "Invoices",
  cheques: "Cheques",
  expenses: "Expenses",
};
// Categories that bucket files under a year subfolder rather than per-entity.
const YEAR_PARTITIONED: Category[] = ["invoices", "cheques", "expenses"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// In-memory caches per function instance. Drive folder IDs never change once
// resolved, so caching saves one search call per subsequent upload.
let cachedToken: { token: string; expiresAt: number } | null = null;
const folderIdCache = new Map<string, string>();

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
        `Re-run the OAuth Playground flow if the refresh token was revoked. ` +
        `Response: ${text}`,
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
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
      `Drive folder create failed (status ${resp.status}): ${text}`,
    );
  }
  return (await resp.json()).id;
}

async function findOrCreateFolder(args: {
  token: string;
  name: string;
  parentId: string | null;
  tag: Record<string, string>;
  cacheKey: string;
}): Promise<string> {
  const cached = folderIdCache.get(args.cacheKey);
  if (cached) return cached;

  // Build a Drive query that matches every key/value in the tag.
  const tagClauses = Object.entries(args.tag)
    .map(
      ([k, v]) =>
        `appProperties has { key='${k}' and value='${v.replace(/'/g, "\\'")}' }`,
    )
    .join(" and ");
  const parentClause = args.parentId
    ? `'${args.parentId}' in parents and `
    : "";
  const q =
    `${parentClause}mimeType='application/vnd.google-apps.folder' and ` +
    `trashed=false and ${tagClauses}`;

  const found = await driveSearch(args.token, q);
  if (found.length > 0) {
    folderIdCache.set(args.cacheKey, found[0].id);
    return found[0].id;
  }
  const id = await createFolder(args.token, args.name, args.parentId, args.tag);
  folderIdCache.set(args.cacheKey, id);
  return id;
}

// Sanitize a folder/file name for Drive: trim, strip control chars, and
// escape single quotes (used by the Drive query language).
function sanitizeName(s: string): string {
  return s.trim().replace(/[\x00-\x1f]/g, "").replace(/'/g, "\\'");
}

async function getRootFolderId(token: string): Promise<string> {
  return findOrCreateFolder({
    token,
    name: ROOT_FOLDER_NAME,
    parentId: null,
    tag: { type: ROOT_FOLDER_TAG },
    cacheKey: "root",
  });
}

async function getCompanyFolderId(
  token: string,
  rootId: string,
  companyId: string,
  companyName: string,
): Promise<string> {
  return findOrCreateFolder({
    token,
    name: sanitizeName(companyName) || `company_${companyId}`,
    parentId: rootId,
    tag: { type: "company_root", company_id: companyId },
    cacheKey: `company:${companyId}`,
  });
}

async function getCategoryFolderId(
  token: string,
  companyFolderId: string,
  companyId: string,
  category: Category,
): Promise<string> {
  return findOrCreateFolder({
    token,
    name: CATEGORY_DISPLAY[category],
    parentId: companyFolderId,
    tag: { type: "category", category },
    cacheKey: `cat:${companyId}:${category}`,
  });
}

async function getYearFolderId(
  token: string,
  categoryFolderId: string,
  companyId: string,
  category: Category,
  year: string,
): Promise<string> {
  return findOrCreateFolder({
    token,
    name: year,
    parentId: categoryFolderId,
    tag: { type: "year", year, category },
    cacheKey: `year:${companyId}:${category}:${year}`,
  });
}

async function getEntityFolderId(
  token: string,
  categoryFolderId: string,
  companyId: string,
  category: Category,
  entityId: string,
  entityCode: string | null,
  entityName: string | null,
): Promise<string> {
  const friendly =
    entityCode && entityName
      ? `${sanitizeName(entityCode)} - ${sanitizeName(entityName)}`
      : entityCode
        ? sanitizeName(entityCode)
        : entityName
          ? sanitizeName(entityName)
          : `id_${entityId}`;
  return findOrCreateFolder({
    token,
    name: friendly,
    parentId: categoryFolderId,
    tag: { type: "entity", entity_id: entityId, category },
    cacheKey: `entity:${companyId}:${category}:${entityId}`,
  });
}

async function uploadFile(
  token: string,
  parentFolderId: string,
  file: File,
  fileName: string,
): Promise<{ id: string; webViewLink: string }> {
  const metadata = { name: fileName, parents: [parentFolderId] };
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
  const body = new Uint8Array(
    head.byteLength + fileBuf.byteLength + tail.byteLength,
  );
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
    throw new Error(
      `Drive set-permission failed (status ${resp.status}): ${text}`,
    );
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
    return json(
      { error: `Missing Edge Function secret(s): ${missing.join(", ")}` },
      500,
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "invalid_form_data" }, 400);
  }

  const file = form.get("file");
  const category = String(form.get("category") ?? "") as Category;
  const companyId = String(form.get("company_id") ?? "");
  const companyName = String(form.get("company_name") ?? "");
  const entityId = (form.get("entity_id") as string | null) || null;
  const entityCode = (form.get("entity_code") as string | null) || null;
  const entityName = (form.get("entity_name") as string | null) || null;
  // Optional filename prefix (e.g. "Salary" → "Salary_payslip.pdf").
  const docType = (form.get("doc_type") as string | null) || null;

  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  if (!VALID_CATEGORIES.includes(category)) {
    return json(
      { error: `invalid_category: must be one of ${VALID_CATEGORIES.join(", ")}` },
      400,
    );
  }
  if (!companyId) return json({ error: "company_id_required" }, 400);
  if (!companyName) return json({ error: "company_name_required" }, 400);

  // employees/contracts require an entity to bucket the file under.
  const needsEntity = category === "employees" || category === "contracts";
  if (needsEntity && !entityId) {
    return json(
      { error: `entity_id_required for category=${category}` },
      400,
    );
  }

  try {
    const token = await getAccessToken();
    const rootId = await getRootFolderId(token);
    const companyFolderId = await getCompanyFolderId(
      token,
      rootId,
      companyId,
      companyName,
    );
    const categoryFolderId = await getCategoryFolderId(
      token,
      companyFolderId,
      companyId,
      category,
    );

    let parentFolderId: string;
    if (YEAR_PARTITIONED.includes(category)) {
      const year = String(new Date().getUTCFullYear());
      parentFolderId = await getYearFolderId(
        token,
        categoryFolderId,
        companyId,
        category,
        year,
      );
    } else {
      parentFolderId = await getEntityFolderId(
        token,
        categoryFolderId,
        companyId,
        category,
        entityId!,
        entityCode,
        entityName,
      );
    }

    const finalName = docType ? `${docType}_${file.name}` : file.name;
    const uploaded = await uploadFile(token, parentFolderId, file, finalName);
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
    console.error("gdrive-upload:", msg);
    return json({ error: msg }, 500);
  }
});
