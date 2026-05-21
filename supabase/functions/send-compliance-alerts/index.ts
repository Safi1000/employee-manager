// Edge function: send-compliance-alerts
// Sends a compliance / contract-end alert digest via Resend.
//
// Two modes:
//   ?test=1  — called from Settings UI with the user's JWT. Targets that user's
//              company, sends a test email even if there are zero real alerts
//              today (so the recipient can verify Resend is wired up).
//   (cron)   — called daily by pg_cron with the service-role key. Iterates
//              every company that has a recipient_email configured and only
//              sends when there is at least one alert to surface.
//
// Alert sources:
//   1. important_dates where (due_date - today) <= advance_notice_days
//      (mirrors what Compliance.tsx renders as active alerts)
//   2. clients.contract_end at exactly 60 / 30 / 7 days out
//      (matches the Compliance / Dashboard contract-end banner windows)
//
// Email transport: Resend (https://resend.com). RESEND_API_KEY must be set.
// The `from` address must be on a domain verified in your Resend account —
// otherwise Resend will return a 403.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Days-out values that should trigger a contract-end alert. Must match the
// thresholds rendered in Compliance.tsx / Dashboard.tsx.
const CONTRACT_ALERT_DAYS = [60, 30, 7];

// Fallback sender if the company has not set sender_email. Resend allows this
// address out of the box without domain verification — good for first run.
const DEFAULT_SENDER = "Employee Manager <onboarding@resend.dev>";

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

type AlertItem = {
  title: string;
  category: string;
  daysRemaining: number;
  priority?: string | null;
  source: "important_date" | "contract_end";
};

async function getCallerProfile(jwt: string): Promise<{
  user_id: string;
  company_id: string | null;
  role: string | null;
} | null> {
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user) return null;
  const { data: profile } = await client
    .from("profiles")
    .select("company_id, role")
    .eq("id", data.user.id)
    .maybeSingle();
  return {
    user_id: data.user.id,
    company_id: (profile?.company_id as string | null) ?? null,
    role: (profile?.role as string | null) ?? null,
  };
}

function diffDaysUTC(target: string, today: string): number {
  // Treat both as UTC midnight to avoid DST off-by-one.
  const a = new Date(`${target}T00:00:00Z`).getTime();
  const b = new Date(`${today}T00:00:00Z`).getTime();
  return Math.round((a - b) / 86_400_000);
}

async function collectAlerts(
  db: SupabaseClient,
  companyId: string,
  today: string,
): Promise<AlertItem[]> {
  const alerts: AlertItem[] = [];

  const { data: dates } = await db
    .from("important_dates")
    .select("title, due_date, category, priority, advance_notice_days")
    .eq("company_id", companyId)
    .gte("due_date", today);
  for (const d of dates ?? []) {
    const days = diffDaysUTC(d.due_date as string, today);
    const window = (d.advance_notice_days as number | null) ?? 7;
    if (days <= window) {
      alerts.push({
        title: d.title as string,
        category: (d.category as string) ?? "General",
        daysRemaining: days,
        priority: d.priority as string | null,
        source: "important_date",
      });
    }
  }

  const { data: clients } = await db
    .from("clients")
    .select("name, contract_end")
    .eq("company_id", companyId)
    .not("contract_end", "is", null)
    .gte("contract_end", today);
  for (const c of clients ?? []) {
    if (!c.contract_end) continue;
    const days = diffDaysUTC(c.contract_end as string, today);
    if (CONTRACT_ALERT_DAYS.includes(days)) {
      alerts.push({
        title: `${c.name} — contract ending`,
        category: "Contract",
        daysRemaining: days,
        source: "contract_end",
      });
    }
  }

  // Most urgent first.
  alerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
  return alerts;
}

function urgencyColor(days: number): string {
  if (days <= 7) return "#dc2626"; // danger
  if (days <= 30) return "#d97706"; // warning
  return "#2563eb"; // info
}

function dueLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days} days`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmailHtml(alerts: AlertItem[], today: string, isTest: boolean): string {
  const dateLabel = new Date(`${today}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  const rows = alerts
    .map((a) => {
      const color = urgencyColor(a.daysRemaining);
      const badge = a.source === "contract_end" ? "Contract" : escapeHtml(a.category);
      return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9">${escapeHtml(a.title)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;color:#475569;font-size:13px">${badge}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;color:${color};font-weight:600;white-space:nowrap">${dueLabel(a.daysRemaining)}</td>
      </tr>`;
    })
    .join("");

  const heading = isTest && alerts.length === 0
    ? "Compliance alerts — test email"
    : `Compliance digest — ${alerts.length} item${alerts.length === 1 ? "" : "s"}`;

  const body = alerts.length === 0
    ? `<p style="color:#475569">No alerts are due right now. This is a test message confirming Resend is wired up correctly.</p>`
    : `<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px">
         <thead>
           <tr style="background:#f8fafc;text-align:left">
             <th style="padding:10px 12px;border-bottom:2px solid #e2e8f0;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#64748b">Item</th>
             <th style="padding:10px 12px;border-bottom:2px solid #e2e8f0;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#64748b">Category</th>
             <th style="padding:10px 12px;border-bottom:2px solid #e2e8f0;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#64748b">Due</th>
           </tr>
         </thead>
         <tbody>${rows}</tbody>
       </table>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #e2e8f0">
      <h2 style="margin:0;font-size:18px;color:#0f172a">${escapeHtml(heading)}</h2>
      <p style="margin:4px 0 0;color:#64748b;font-size:13px">${escapeHtml(dateLabel)}</p>
    </div>
    <div style="padding:20px 24px">
      ${body}
    </div>
    <div style="padding:14px 24px;background:#f8fafc;color:#94a3b8;font-size:12px">
      Sent by Employee Manager · Change recipient in Settings → Notifications
    </div>
  </div>
</body></html>`;
}

async function sendViaResend(args: {
  to: string;
  from: string;
  subject: string;
  html: string;
}): Promise<{ id: string }> {
  if (!RESEND_API_KEY) {
    throw new Error(
      "RESEND_API_KEY secret is not set. Add it under Edge Functions → Secrets.",
    );
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend send failed (status ${resp.status}): ${text}`);
  }
  return (await resp.json()) as { id: string };
}

async function sendForCompany(
  db: SupabaseClient,
  companyId: string,
  today: string,
  isTest: boolean,
): Promise<{ sent: boolean; reason?: string; recipient?: string }> {
  const { data: ns } = await db
    .from("notification_settings")
    .select("recipient_email, sender_email")
    .eq("company_id", companyId)
    .maybeSingle();

  const recipient = ns?.recipient_email?.trim();
  if (!recipient) {
    return { sent: false, reason: "No recipient email configured in Settings → Notifications." };
  }
  const sender = ns?.sender_email?.trim() || DEFAULT_SENDER;

  const alerts = await collectAlerts(db, companyId, today);
  if (alerts.length === 0 && !isTest) {
    return { sent: false, reason: "No alerts due today." };
  }

  const subject = alerts.length === 0
    ? "[Test] Employee Manager compliance alerts"
    : `Compliance digest — ${alerts.length} item${alerts.length === 1 ? "" : "s"} due`;

  await sendViaResend({
    to: recipient,
    from: sender,
    subject,
    html: buildEmailHtml(alerts, today, isTest),
  });

  return { sent: true, recipient };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const isTest = url.searchParams.get("test") === "1";

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const today = new Date().toISOString().slice(0, 10);

  // Test mode: send directly to the recipient passed in the body. Does NOT
  // read notification_settings — that way the test works the moment the user
  // types an email and clicks "Send test email", even before saving.
  // Restricted to super_admin / super_super_admin to prevent regular users
  // from using this as an open relay.
  if (isTest) {
    const authHeader = req.headers.get("Authorization");
    const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!jwt) return json({ error: "unauthorized" }, 401);

    const caller = await getCallerProfile(jwt);
    if (!caller) return json({ error: "invalid_token" }, 401);
    if (caller.role !== "super_admin" && caller.role !== "super_super_admin") {
      return json({ error: "forbidden_role" }, 403);
    }

    let body: { recipient?: string; from?: string } = {};
    try { body = await req.json(); } catch { /* empty body is fine */ }

    const recipient = body.recipient?.trim();
    if (!recipient) {
      return json({ error: "recipient_required" }, 400);
    }
    const sender = body.from?.trim() || DEFAULT_SENDER;

    try {
      // Synthesize a small preview using the caller's company alerts (if any)
      // so the test email reflects what a real daily digest would look like.
      const alerts = caller.company_id
        ? await collectAlerts(db, caller.company_id, today)
        : [];
      const subject = alerts.length === 0
        ? "[Test] Employee Manager compliance alerts"
        : `[Test] Compliance digest — ${alerts.length} item${alerts.length === 1 ? "" : "s"}`;
      await sendViaResend({
        to: recipient,
        from: sender,
        subject,
        html: buildEmailHtml(alerts, today, true),
      });
      return json({ sent: true, recipient });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("send-compliance-alerts (test):", msg);
      return json({ error: msg }, 500);
    }
  }

  // Cron mode: iterate every company that has a recipient configured.
  const { data: configured, error: cfgErr } = await db
    .from("notification_settings")
    .select("company_id")
    .not("recipient_email", "is", null);
  if (cfgErr) {
    return json({ error: cfgErr.message }, 500);
  }

  const results: Array<{
    company_id: string;
    sent: boolean;
    reason?: string;
    recipient?: string;
    error?: string;
  }> = [];

  for (const row of configured ?? []) {
    const companyId = row.company_id as string;
    try {
      const r = await sendForCompany(db, companyId, today, false);
      results.push({ company_id: companyId, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`send-compliance-alerts company=${companyId}:`, msg);
      results.push({ company_id: companyId, sent: false, error: msg });
    }
  }

  return json({ ok: true, count: results.length, results });
});
