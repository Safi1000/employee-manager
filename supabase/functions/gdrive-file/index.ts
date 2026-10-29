// gdrive-file — open a Drive file through Bastion, and take Drive files private.
//
// 2026-10-29 security sweep: every file gdrive-upload stored was shared
// "anyone with the link can view" (makeAnyoneReader) — expense receipts, client
// contracts with their rates, advances, employee documents. A link forwarded on
// WhatsApp or left in a browser history opened the file with no login at all.
//
// POST { file_id }                      → the file itself, streamed.
//   Allowed only if the CALLER can read a record that holds this file. The
//   lookup runs with the caller's own token, so every rule that governs the
//   record governs the file: RLS read rules (0586/0588), the API gate's live
//   session and two-factor checks (0591), company and region scope.
//
// POST { action: "make_private", dry } → for a super-admin: every file the
//   caller's company holds loses its "anyone" permission. dry: true only counts.
//   Files stay where they are; they open only through Bastion afterwards.
//
// Auth to Google: the same OAuth refresh token as gdrive-upload (drive.file
// scope — this app can reach only files it created, which is all of these).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveCaller, serviceClient } from "../_shared/caller.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
const REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");

/** Every table that holds a Drive file (drive_file_id). */
const TABLES = [
  "employee_documents", "expense_receipts", "expenses", "advances", "contracts", "contract_addendums",
  "invoices", "cheques", "cash_deposits", "incidents", "daily_ok_reports", "supervisor_visits",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Expose-Headers": "content-disposition, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

let cachedToken: { token: string; expiresAt: number } | null = null;
async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: CLIENT_ID!, client_secret: CLIENT_SECRET!, refresh_token: REFRESH_TOKEN!,
    }),
  });
  if (!resp.ok) throw new Error(`Google token exchange failed (status ${resp.status}): ${await resp.text()}`);
  const j = await resp.json();
  cachedToken = { token: j.access_token, expiresAt: Date.now() + (j.expires_in - 60) * 1000 };
  return cachedToken.token;
}

async function makePrivate(companyId: string, dry: boolean) {
  const admin = serviceClient();
  const ids = new Set<string>();
  for (const t of TABLES) {
    const { data, error } = await admin.from(t).select("drive_file_id").eq("company_id", companyId).not("drive_file_id", "is", null);
    if (error) throw new Error(`${t}: ${error.message}`);
    for (const r of (data ?? []) as { drive_file_id: string }[]) ids.add(r.drive_file_id);
  }
  const token = await getAccessToken();
  let isPublic = 0, madePrivate = 0, missing = 0, failed = 0;
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.pop()!;
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions?fields=permissions(id,type)`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 404) { missing++; continue; }
      if (!r.ok) { failed++; continue; }
      const anyone = ((await r.json()).permissions ?? []).filter((p: { type: string }) => p.type === "anyone");
      if (!anyone.length) continue;
      isPublic++;
      if (dry) continue;
      let ok = true;
      for (const p of anyone) {
        const d = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions/${p.id}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${token}` },
        });
        if (!d.ok && d.status !== 404) ok = false;
      }
      if (ok) madePrivate++; else failed++;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { files: ids.size, public: isPublic, made_private: madePrivate, missing_in_drive: missing, failed, dry };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const caller = await resolveCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) return json({ error: "drive_not_configured" }, 500);

  let body: { file_id?: string; action?: string; dry?: boolean };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  try {
    if (body.action === "make_private") {
      const { data: p } = await serviceClient().from("profiles").select("role").eq("id", caller.userId).maybeSingle();
      if (!(caller.isSSA || p?.role === "super_admin")) return json({ error: "Only a super admin can change Drive sharing." }, 403);
      if (!caller.companyId) return json({ error: "no_company" }, 400);
      return json(await makePrivate(caller.companyId, body.dry !== false));
    }

    const fileId = String(body.file_id ?? "");
    if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return json({ error: "invalid_file_id" }, 400);

    // As the caller: is there a record holding this file that they may read?
    const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization")! } },
      auth: { persistSession: false },
    });
    let allowed = false;
    for (const t of TABLES) {
      const { data, error } = await asCaller.from(t).select("id").eq("drive_file_id", fileId).limit(1);
      if (error) {
        // The API gate's refusals (session ended, two-factor required, disabled) stop here.
        if (/session ended|two-factor|account disabled/.test(error.message)) return json({ error: error.message }, 403);
        continue;
      }
      if (data && data.length) { allowed = true; break; }
    }
    if (!allowed) return json({ error: "That file is not on a record you can open." }, 404);

    const token = await getAccessToken();
    const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meta.ok) return json({ error: `Drive could not find the file (status ${meta.status}).` }, 404);
    const { name, mimeType } = await meta.json();
    const media = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!media.ok || !media.body) return json({ error: `Drive refused the download (status ${media.status}).` }, 502);
    const safe = String(name ?? "file").replace(/["\\\r\n]/g, "_");
    return new Response(media.body, {
      headers: {
        ...CORS,
        "Content-Type": mimeType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${safe}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
