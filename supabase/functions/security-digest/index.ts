// Edge function: security-digest (0596)
//
// Every Monday 08:00 Pakistan time pg_cron calls this with the service-role key
// (invoke_security_digest). For each company with an active super-admin it asks
// security_digest() for the past week — logins, new devices, two-factor still
// owed, disabled logins, exports, permission changes, backups, red checks,
// security gaps — and mails it to each super-admin, at the alert address they
// set on the task board if they set one, else their login email.
//
// A signed-in super-admin may call it too ("Email me this now" in Access &
// Governance): then only their own company, and only to themselves.
//
// Nothing here decides what is worth worrying about beyond three plain flags —
// a new device, a login between midnight and 5am, more than EXPORT_SPIKE files
// in a week. The digest is for a person to read, not a verdict.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isServiceRole, resolveCaller, serviceClient } from "../_shared/caller.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const DEFAULT_SENDER = "Bastion <onboarding@resend.dev>";
const EXPORT_SPIKE = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

function device(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const b = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
}

type Digest = {
  company: string | null; from: string; to: string;
  logins: { name: string; logins: number; new_devices: number; odd_hours: number }[];
  new_devices: { name: string; device: string | null; ip: string | null; at: string }[];
  two_factor: { name: string; required_from: string }[];
  disabled: { name: string; reason: string | null; at: string; by: string | null }[];
  exports: { by_person: { name: string; files: number }[]; recent: { name: string; file: string; at: string }[] };
  permissions: { name: string | null; at: string; by: string | null; added: string[]; removed: string[]; role: unknown; region: unknown }[];
  backups: { at: string; ok: boolean | null; bytes: number | null; rows: number | null; error: string | null }[];
  red_checks: { check: string; actual: number; expected: number }[];
  gaps: { kind: string; object: string; detail: string }[];
};

/** Things a reader should look at first. */
export function attention(d: Digest): string[] {
  const out: string[] = [];
  for (const g of d.gaps) out.push(`Security gap: ${g.kind} — ${g.object}`);
  for (const c of d.red_checks) out.push(`Check failing: ${c.check}`);
  if (!d.backups.some((b) => b.ok)) out.push(d.backups.length ? "No successful backup this week" : "No backup ran this week");
  for (const x of d.exports.by_person) if (x.files > EXPORT_SPIKE) out.push(`${x.name} downloaded ${x.files} files`);
  for (const l of d.logins) if (l.odd_hours > 0) out.push(`${l.name}: ${l.odd_hours} login(s) between midnight and 5am`);
  for (const n of d.new_devices) out.push(`${n.name} signed in on a new device (${device(n.device)})`);
  for (const p of d.permissions) if (p.added.length) out.push(`${p.name ?? "A login"} was given ${p.added.join(", ")}`);
  return out;
}

const H = (t: string) => `<h3 style="margin:22px 0 6px;font-size:14px;color:#0f172a;">${esc(t)}</h3>`;
const NONE = (t: string) => `<p style="margin:0;color:#64748b;font-size:13px;">${esc(t)}</p>`;
function table(head: string[], rows: string[][]): string {
  const th = head.map((h) => `<th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;text-transform:uppercase;border-bottom:1px solid #e2e8f0;">${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td style="padding:6px 8px;font-size:13px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${c}</td>`).join("")}</tr>`).join("");
  return `<table style="border-collapse:collapse;width:100%;">${`<tr>${th}</tr>`}${tr}</table>`;
}

export function renderDigest(d: Digest): string {
  const look = attention(d);
  const parts: string[] = [];
  parts.push(`<h2 style="margin:0 0 4px;font-size:18px;color:#0f172a;">Security this week — ${esc(d.company ?? "Bastion")}</h2>`);
  parts.push(`<p style="margin:0 0 12px;color:#64748b;font-size:13px;">${esc(when(d.from))} to ${esc(when(d.to))} (Pakistan time)</p>`);
  parts.push(look.length
    ? `<div style="border:1px solid #fcd34d;background:#fffbeb;border-radius:8px;padding:10px 14px;"><p style="margin:0 0 6px;font-weight:600;font-size:13px;color:#92400e;">Worth a look</p><ul style="margin:0;padding-left:18px;font-size:13px;color:#78350f;">${look.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>`
    : `<div style="border:1px solid #86efac;background:#f0fdf4;border-radius:8px;padding:10px 14px;font-size:13px;color:#166534;">Nothing unusual this week.</div>`);

  parts.push(H("Logins"));
  parts.push(d.logins.length
    ? table(["Person", "Logins", "New devices", "Midnight–5am"], d.logins.map((l) => [esc(l.name), String(l.logins), String(l.new_devices), String(l.odd_hours)]))
    : NONE("Nobody signed in."));

  if (d.new_devices.length) {
    parts.push(H("New devices"));
    parts.push(table(["Person", "Device", "Address", "When"], d.new_devices.map((n) => [esc(n.name), esc(device(n.device)), esc(n.ip ?? "—"), esc(when(n.at))])));
  }

  parts.push(H("Two-factor still owed"));
  parts.push(d.two_factor.length
    ? table(["Person", "Compulsory from"], d.two_factor.map((t) => [esc(t.name), esc(when(t.required_from))]))
    : NONE("Everyone has an authenticator."));

  if (d.disabled.length) {
    parts.push(H("Logins disabled"));
    parts.push(table(["Person", "Why", "By", "When"], d.disabled.map((x) => [esc(x.name), esc(x.reason ?? "—"), esc(x.by ?? "automatic"), esc(when(x.at))])));
  }

  parts.push(H("Files downloaded"));
  parts.push(d.exports.by_person.length
    ? table(["Person", "Files"], d.exports.by_person.map((x) => [esc(x.name), x.files > EXPORT_SPIKE ? `<b style="color:#b45309;">${x.files}</b>` : String(x.files)]))
      + (d.exports.recent.length ? `<p style="margin:8px 0 2px;font-size:12px;color:#64748b;">Most recent</p>` + table(["Person", "File", "When"], d.exports.recent.map((r) => [esc(r.name), esc(r.file), esc(when(r.at))])) : "")
    : NONE("No files downloaded."));

  parts.push(H("Access changes"));
  parts.push(d.permissions.length
    ? table(["Login", "Change", "By", "When"], d.permissions.map((p) => {
        const bits: string[] = [];
        if (p.added.length) bits.push(`<span style="color:#166534;">+ ${esc(p.added.join(", "))}</span>`);
        if (p.removed.length) bits.push(`<span style="color:#991b1b;">− ${esc(p.removed.join(", "))}</span>`);
        if (p.role) bits.push(`role changed`);
        if (p.region) bits.push(`region changed`);
        return [esc(p.name ?? "—"), bits.join("<br>") || "profile updated", esc(p.by ?? "—"), esc(when(p.at))];
      }))
    : NONE("No permissions changed."));

  parts.push(H("Backups"));
  parts.push(d.backups.length
    ? table(["When", "Result"], d.backups.map((b) => [esc(when(b.at)), b.ok ? `OK · ${b.rows?.toLocaleString() ?? "?"} rows` : b.ok === false ? `<span style="color:#991b1b;">Failed: ${esc(b.error ?? "")}</span>` : "running"]))
    : NONE("No backup ran."));

  if (d.red_checks.length || d.gaps.length) {
    parts.push(H("Checks"));
    parts.push(table(["Check", "Detail"], [
      ...d.red_checks.map((c) => [esc(c.check), `expected ${esc(c.expected)}, found ${esc(c.actual)}`]),
      ...d.gaps.map((g) => [esc(`${g.kind}: ${g.object}`), esc(g.detail)]),
    ]));
  }

  parts.push(`<p style="margin:24px 0 0;color:#94a3b8;font-size:11px;">Sent by Bastion every Monday. The same view is in Access &amp; Governance.</p>`);
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;">${parts.join("")}</div>`;
}

async function sendViaResend(args: { to: string; from: string; subject: string; html: string }) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY secret is not set. Add it under Edge Functions → Secrets.");
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!resp.ok) throw new Error(`Resend send failed (status ${resp.status}): ${await resp.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = serviceClient();
  let onlyUser: string | null = null;
  let onlyCompany: string | null = null;
  if (!isServiceRole(req)) {
    const caller = await resolveCaller(req);
    if (!caller) return json({ error: "unauthorized" }, 401);
    const { data: p } = await admin.from("profiles").select("role").eq("id", caller.userId).maybeSingle();
    if (!(caller.isSSA || p?.role === "super_admin")) return json({ error: "Only a super admin can send the security digest." }, 403);
    if (!caller.companyId) return json({ error: "No company selected." }, 400);
    onlyUser = caller.userId;
    onlyCompany = caller.companyId;
  }

  let q = admin.from("profiles").select("id, company_id, email, task_alert_email")
    .eq("role", "super_admin").is("disabled_at", null).not("company_id", "is", null);
  if (onlyUser) q = admin.from("profiles").select("id, company_id, email, task_alert_email").eq("id", onlyUser);
  const { data: people, error: pErr } = await q;
  if (pErr) return json({ error: `profiles: ${pErr.message}` }, 500);

  const byCompany = new Map<string, { email: string | null; task_alert_email: string | null }[]>();
  for (const p of people ?? []) {
    const co = (onlyCompany ?? p.company_id) as string;
    if (!byCompany.has(co)) byCompany.set(co, []);
    byCompany.get(co)!.push(p);
  }

  const sent: string[] = [];
  const failed: string[] = [];
  for (const [companyId, recipients] of byCompany) {
    try {
      const { data, error } = await admin.rpc("security_digest", { p_company_id: companyId, p_days: 7 });
      if (error) throw new Error(`security_digest: ${error.message}`);
      const d = data as Digest;
      const { data: ns } = await admin.from("notification_settings").select("sender_email").eq("company_id", companyId).maybeSingle();
      const from = ns?.sender_email?.trim() || DEFAULT_SENDER;
      const look = attention(d).length;
      const subject = `Bastion security this week — ${look ? `${look} thing${look === 1 ? "" : "s"} worth a look` : "nothing unusual"}`;
      const html = renderDigest(d);
      for (const r of recipients) {
        const to = (r.task_alert_email?.trim() || r.email?.trim()) ?? "";
        if (!to) continue;
        try { await sendViaResend({ to, from, subject, html }); sent.push(to); }
        catch (e) { failed.push(`${to}: ${(e as Error).message}`); }
      }
    } catch (e) {
      failed.push(`${companyId}: ${(e as Error).message}`);
    }
  }
  return json({ sent, failed }, failed.length && !sent.length ? 500 : 200);
});
