// Edge function: gdrive-delete-employee-doc
// Deletes a single Drive file by ID. Idempotent — a 404 from Drive is treated
// as success since the row may already be gone.
//
// Request: POST JSON { drive_file_id: string }
// Response: { ok: true }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { create as jwtCreate, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SA_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SA_PRIVATE_KEY_RAW = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!;

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

async function importPrivateKey(pem: string) {
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
  const exp = getNumericDate(60 * 60);
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
  if (!resp.ok) throw new Error(`token exchange failed: ${await resp.text()}`);
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
      `https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true`,
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
    return json({ error: msg }, 500);
  }
});
