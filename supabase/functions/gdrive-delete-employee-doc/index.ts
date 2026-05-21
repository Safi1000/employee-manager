// Edge function: gdrive-delete-employee-doc
// Deletes a single Drive file by ID using OAuth refresh-token auth.
// Idempotent — 404 is treated as success.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
const REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");

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
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!resp.ok && resp.status !== 404) {
      const text = await resp.text();
      return json({ error: `drive delete failed: ${resp.status} ${text}` }, 500);
    }
    return json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("gdrive-delete-employee-doc:", msg);
    return json({ error: msg }, 500);
  }
});
