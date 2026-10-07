// Edge function: gdrive-delete
// Deletes a single Drive file by ID. Identical behavior to
// gdrive-delete-employee-doc but with a generic name to match gdrive-upload.
// 404 is treated as success — the file is already gone.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { actsFor, resolveCaller, serviceClient } from "../_shared/caller.ts";

const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
const REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");

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

let cachedToken: { token: string; expiresAt: number } | null = null;

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
    throw new Error(`Google token exchange failed (status ${resp.status}): ${text}`);
  }
  const j = await resp.json();
  cachedToken = {
    token: j.access_token,
    expiresAt: Date.now() + (j.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

/**
 * The company a Drive file belongs to, read from the tags the uploaders write:
 * the file's own company_id (uploads since the audit), else the nearest
 * ancestor folder tagged company_root, else an employee folder from the old
 * per-employee uploader. null = cannot be attributed, so it is not deleted.
 */
async function owningCompany(token: string, fileId: string): Promise<string | null | "missing"> {
  let id: string | undefined = fileId;
  for (let depth = 0; id && depth < 6; depth++) {
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=parents,appProperties`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (r.status === 404) return depth === 0 ? "missing" : null;
    if (!r.ok) throw new Error(`drive lookup failed: ${r.status} ${await r.text()}`);
    const f = await r.json() as { parents?: string[]; appProperties?: Record<string, string> };
    const tags = f.appProperties ?? {};
    if (tags.company_id) return tags.company_id;
    if (tags.employee_id) {
      const { data } = await serviceClient().from("employees").select("company_id").eq("id", tags.employee_id).maybeSingle();
      return (data?.company_id as string | undefined) ?? null;
    }
    id = f.parents?.[0];
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // A signed-in user with a profile. The anon key is a valid JWT too, so
  // verify_jwt alone let anyone delete any file by id (2026-10-08 audit).
  const caller = await resolveCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const missing: string[] = [];
  if (!CLIENT_ID) missing.push("GOOGLE_OAUTH_CLIENT_ID");
  if (!CLIENT_SECRET) missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!REFRESH_TOKEN) missing.push("GOOGLE_OAUTH_REFRESH_TOKEN");
  if (missing.length > 0) {
    return json({ error: `Missing secret(s): ${missing.join(", ")}` }, 500);
  }

  let body: { drive_file_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const id = body.drive_file_id;
  if (!id) return json({ error: "drive_file_id_required" }, 400);

  try {
    const token = await getAccessToken();
    const owner = await owningCompany(token, id);
    if (owner === "missing") return json({ ok: true });
    if (!owner || !actsFor(caller, owner)) return json({ error: "wrong_company" }, 403);
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok && resp.status !== 404) {
      const text = await resp.text();
      return json({ error: `drive delete failed: ${resp.status} ${text}` }, 500);
    }
    return json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("gdrive-delete:", msg);
    return json({ error: msg }, 500);
  }
});
