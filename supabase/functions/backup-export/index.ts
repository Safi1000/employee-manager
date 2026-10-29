// backup-export — the weekly encrypted backup (0594).
//
// Every public table → NDJSON (one {"t": table, "r": row} per line, after a
// header line) → gzip → AES-256-GCM with BACKUP_ENCRYPTION_KEY → one file in a
// private "Bastion Backups" Drive folder. The last eight weeks are kept.
//
// File layout: "BASTIONBK1" (10 bytes) | IV (12 bytes) | ciphertext+tag.
// scripts/decrypt-backup.mjs turns it back into NDJSON.
//
// Who may run it: the service role (pg_cron, 'weekly-backup') or a super-admin
// pressing "Back up now". Every run, good or bad, is a row in backup_runs.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isServiceRole, resolveCaller, serviceClient } from "../_shared/caller.ts";

const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
const REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");
const BACKUP_KEY = Deno.env.get("BACKUP_ENCRYPTION_KEY");

const KEEP_WEEKS = 8;
const PAGE = 1000;
const MAGIC = new TextEncoder().encode("BASTIONBK1");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

async function googleToken(): Promise<string> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID!, client_secret: CLIENT_SECRET!, refresh_token: REFRESH_TOKEN! }),
  });
  if (!r.ok) throw new Error(`Google token exchange failed (${r.status}): ${await r.text()}`);
  return (await r.json()).access_token;
}

async function backupFolder(token: string): Promise<string> {
  const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='type' and value='bastion_backups' }`;
  const s = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: { Authorization: `Bearer ${token}` } });
  if (!s.ok) throw new Error(`Drive search failed (${s.status})`);
  const found = (await s.json()).files ?? [];
  if (found.length) return found[0].id;
  const c = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Bastion Backups", mimeType: "application/vnd.google-apps.folder", appProperties: { type: "bastion_backups" } }),
  });
  if (!c.ok) throw new Error(`Drive folder create failed (${c.status})`);
  return (await c.json()).id;
}

async function upload(token: string, folder: string, name: string, data: Uint8Array): Promise<string> {
  const boundary = `bastion-backup-${crypto.randomUUID()}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: [folder], appProperties: { type: "bastion_backup" } }) +
    `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + data.length + tail.length);
  body.set(head, 0); body.set(data, head.length); body.set(tail, head.length + data.length);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  if (!r.ok) throw new Error(`Drive upload failed (${r.status}): ${await r.text()}`);
  return (await r.json()).id;
}

async function pruneOld(token: string, folder: string) {
  const cutoff = new Date(Date.now() - KEEP_WEEKS * 7 * 86400_000).toISOString();
  const q = `'${folder}' in parents and trashed=false and createdTime < '${cutoff}' and appProperties has { key='type' and value='bastion_backup' }`;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return;
  for (const f of (await r.json()).files ?? []) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = serviceClient();
  let triggeredBy: string | null = null;
  if (!isServiceRole(req)) {
    const caller = await resolveCaller(req);
    if (!caller) return json({ error: "unauthorized" }, 401);
    const { data: p } = await admin.from("profiles").select("role").eq("id", caller.userId).maybeSingle();
    if (!(caller.isSSA || p?.role === "super_admin")) return json({ error: "Only a super admin can run a backup." }, 403);
    triggeredBy = caller.userId;
  }
  if (!BACKUP_KEY) return json({ error: "BACKUP_ENCRYPTION_KEY is not set in the Edge Function secrets." }, 500);
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) return json({ error: "drive_not_configured" }, 500);

  const { data: run } = await admin.from("backup_runs").insert({ triggered_by: triggeredBy }).select("id").single();
  const runId = run?.id as string | undefined;

  try {
    const keyBytes = Uint8Array.from(atob(BACKUP_KEY), (c) => c.charCodeAt(0));
    if (keyBytes.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);

    const { data: tables, error: tErr } = await admin.rpc("backup_tables");
    if (tErr) throw new Error(`backup_tables: ${tErr.message}`);

    // NDJSON through gzip, collected as compressed chunks.
    const gz = new CompressionStream("gzip");
    const writer = gz.writable.getWriter();
    const chunks: Uint8Array[] = [];
    const reading = (async () => {
      const reader = gz.readable.getReader();
      for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); }
    })();
    const enc = new TextEncoder();
    const stamp = new Date().toISOString();
    await writer.write(enc.encode(JSON.stringify({ bastion_backup: 1, created_at: stamp, tables: (tables ?? []).length }) + "\n"));

    let rows = 0;
    for (const t of (tables ?? []) as { table_name: string; has_id: boolean }[]) {
      for (let from = 0; ; from += PAGE) {
        let q = admin.from(t.table_name).select("*").range(from, from + PAGE - 1);
        if (t.has_id) q = q.order("id");
        const { data, error } = await q;
        if (error) throw new Error(`${t.table_name}: ${error.message}`);
        const lines = (data ?? []).map((r) => JSON.stringify({ t: t.table_name, r })).join("\n");
        if (lines) await writer.write(enc.encode(lines + "\n"));
        rows += (data ?? []).length;
        if (!data || data.length < PAGE) break;
      }
    }
    await writer.close();
    await reading;

    const plain = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0; for (const c of chunks) { plain.set(c, off); off += c.length; }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
    const file = new Uint8Array(MAGIC.length + iv.length + cipher.length);
    file.set(MAGIC, 0); file.set(iv, MAGIC.length); file.set(cipher, MAGIC.length + iv.length);

    const token = await googleToken();
    const folder = await backupFolder(token);
    const name = `bastion-backup-${stamp.slice(0, 10)}-${stamp.slice(11, 16).replace(":", "")}.ndjson.gz.enc`;
    const fileId = await upload(token, folder, name, file);
    await pruneOld(token, folder);

    const result = { ok: true, tables: (tables ?? []).length, rows_exported: rows, bytes: file.length, drive_file_id: fileId, file_name: name };
    if (runId) await admin.from("backup_runs").update({ ...result, finished_at: new Date().toISOString() }).eq("id", runId);
    return json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (runId) await admin.from("backup_runs").update({ ok: false, error: msg, finished_at: new Date().toISOString() }).eq("id", runId);
    return json({ ok: false, error: msg }, 500);
  }
});
